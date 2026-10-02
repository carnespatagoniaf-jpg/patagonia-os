import { buildKretzFrame, parseKretzResponse, toHex, toPrintable } from "./kretz-frame";
import { buildAuraPluRecord, type AuraPluInput } from "./aura-plu";
import { collect, readPluList, sendRead, type DiagnosticExchange, type KretzResponder } from "./discovery";
import { claimPort, closeQuietly, errorClassification, freshPortFor, newSession, openForSession, releasePort, type OpenAttempt } from "./port-session";

/**
 * Prueba de escritura controlada en la Kretz Aura: SOLO los productos de
 * prueba de los PLU 96 a 99. Es lo único que escribe en una Aura.
 *
 * Primera prueba (2026-10-02 12:02): PLU 99 con P y código 000990 → la balanza
 * lo guardó con D y código 000000. Precio, nombre, tara y validez quedaron
 * bien; la pantalla mostró "1234 $/kg".
 *
 * Segunda prueba: cada producto contesta una pregunta concreta.
 * - PLU 97, por kilo, 2 días → P. ¿Se respeta P cuando hay días de validez? (hipótesis H1, aura-plu.ts)
 * - PLU 98, por unidad, 0 días → C. ¿Es C el unitario sin validez? ¿La pantalla lo vende por unidad? (ticket)
 * - PLU 96, por unidad, 3 días → N. ¿Es N el unitario con validez?
 * - PLU 99, por kilo, 0 días → D, código 500. Se reescribe solo nuestro producto
 *   de prueba. ¿Se queda un código distinto del PLU? ¿El código de barras del
 *   ticket lleva el código o el número de PLU?
 * En los PLU 96, 97 y 98 el código es igual al PLU, como en los 6 productos de la
 * clienta: si ahí tampoco queda, la balanza no toma el código por este comando.
 *
 * Pasos:
 * 1. Lista completa antes. Frena si 96/97/98 existen, o si 99 existe con otra cosa
 *    que no sea nuestro producto de la primera prueba.
 * 2. 2005 de cada uno. `assertTestWrite` deja pasar SOLO estos 4 registros exactos.
 * 3. Releer cada uno.
 *    Después de CADA carga se relee la lista entera: si un producto de la clienta
 *    cambió, se frena ahí.
 * 4. Prueba de borrado (para poder retirar después los productos de prueba): 3005
 *    con "000096". Se borra el 96 si 3005 borra el número exacto, o el 97 si
 *    funciona como 5005 ("el siguiente mayor"). Los dos son de prueba y ninguno es
 *    de los que se usan para los tickets (98 y 99), y todos los
 *    de la clienta son menores a 96 (se comprueba antes). La lista de después dice
 *    cuál se borró. `assertTestDelete` solo deja pasar ese borrado.
 * 5. Lista completa final: los productos de la clienta tienen que estar idénticos.
 */

export const AURA_WRITE_TEST_VERSION = "2026-10-02f";

export interface AuraTestProduct extends AuraPluInput {
  purpose: string;
}

export const AURA_TEST_PRODUCTS: AuraTestProduct[] = [
  { plu: 97, name: "PRUEBA KILO", type: "P", code: 97, priceRaw: 2000, validityDays: 2, purpose: "por kilo con 2 días de validez: ¿queda la letra P?" },
  { plu: 98, name: "PRUEBA UNIDAD", type: "C", code: 98, priceRaw: 500, validityDays: 0, purpose: "por unidad sin validez: ¿queda la letra C y se vende por unidad? (ticket)" },
  { plu: 96, name: "PRUEBA UNIDAD V", type: "N", code: 96, priceRaw: 300, validityDays: 3, purpose: "por unidad con 3 días de validez: ¿queda la letra N?" },
  { plu: 99, name: "PRUEBA PATAGONIA", type: "D", code: 500, priceRaw: 1234, validityDays: 0, purpose: "por kilo, código 500 (distinto del PLU): ¿queda el código? ¿qué lleva el código de barras?" }
];

export const AURA_TEST_RECORDS = AURA_TEST_PRODUCTS.map((p) => buildAuraPluRecord(p));
export const AURA_TEST_PLUS = AURA_TEST_PRODUCTS.map((p) => p.plu);

/** Lo que quedó en el PLU 99 después de la primera prueba (lo único que se permite pisar). */
export const AURA_FIRST_TEST_READBACK = "000099PRUEBA PATAGONIAD0000000012340000000";

export function assertTestWrite(command: string, data: string): void {
  if (command !== "2005" || !AURA_TEST_RECORDS.includes(data)) {
    throw new Error(`Bloqueado: en la Aura solo se permite escribir los productos de prueba (PLU ${AURA_TEST_PLUS.join(", ")}).`);
  }
}

export const AURA_TEST_DELETE_ARG = "000096";

export function assertTestDelete(command: string, data: string, clientPlus: number[]): void {
  if (command !== "3005" || data !== AURA_TEST_DELETE_ARG || clientPlus.some((p) => p >= Number(AURA_TEST_DELETE_ARG))) {
    throw new Error("Bloqueado: el único borrado permitido es el de prueba (PLU 96), y solo si ningún producto de la clienta tiene un número de 96 o más.");
  }
}

export type WriteTestVerdict =
  | "ok" // se escribieron todos y los productos de la clienta quedaron iguales (las diferencias de letra/código se informan aparte)
  | "puerto"
  | "sin_respuesta"
  | "lectura_incompleta" // no se pudo leer la lista completa antes: no se escribió
  | "plu_ocupado" // algún PLU de prueba tiene otra cosa: no se escribió
  | "rechazada" // la balanza contestó otro código a algún 2005
  | "otros_cambiaron" // ¡algún producto de la clienta cambió! (no debería pasar)
  | "error";

export interface AuraTestItemResult {
  plu: number;
  purpose: string;
  sent: string;
  writeCode: string | null;
  readBack: string | null;
  /** Comparación campo por campo de lo releído contra lo mandado. */
  same: { nombre: boolean; letra: boolean; codigo: boolean; precio: boolean; tara: boolean; validez: boolean } | null;
}

export interface AuraWriteTestResult {
  version: string;
  startedAt: string;
  finishedAt: string;
  verdict: WriteTestVerdict;
  detail: string;
  items: AuraTestItemResult[];
  before: { plu: number; data: string }[];
  after: { plu: number; data: string }[];
  /** Prueba de borrado: qué se mandó, qué contestó y qué PLU desapareció de la lista. */
  deleteTest: { sent: string; code: string | null; removedPlus: number[]; clientIntact: boolean } | null;
  exchanges: DiagnosticExchange[];
  openLog: OpenAttempt[];
}

/** Compara dos registros de 42 caracteres campo por campo (6+16+1+5+1+6+4+3). */
export function compareAuraRecords(sent: string, back: string): AuraTestItemResult["same"] {
  if (back.length !== sent.length) return null;
  const f = (s: string, a: number, b: number) => s.slice(a, b);
  return {
    nombre: f(sent, 6, 22) === f(back, 6, 22),
    letra: f(sent, 22, 23) === f(back, 22, 23),
    codigo: f(sent, 23, 29) === f(back, 23, 29),
    precio: f(sent, 29, 35) === f(back, 29, 35),
    tara: f(sent, 35, 39) === f(back, 35, 39),
    validez: f(sent, 39, 42) === f(back, 39, 42)
  };
}

export async function runAuraWriteTest(port: SerialPort, responder: KretzResponder, options: { timeoutMs?: number; onProgress?: (text: string) => void } = {}): Promise<AuraWriteTestResult> {
  const timeout = options.timeoutMs ?? 1500;
  const progress = options.onProgress ?? (() => {});
  const result: AuraWriteTestResult = {
    version: AURA_WRITE_TEST_VERSION,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    verdict: "error",
    detail: "",
    items: [],
    before: [],
    after: [],
    deleteTest: null,
    exchanges: [],
    openLog: []
  };
  const finish = (verdict: WriteTestVerdict, detail: string) => {
    result.verdict = verdict;
    result.detail = detail;
    return result;
  };
  if (!claimPort(port)) {
    result.finishedAt = new Date().toISOString();
    return finish("puerto", "ya hay una prueba en curso con esta balanza en esta pestaña");
  }
  const claimed = port;
  const session = newSession(4, result.openLog);
  const { link, deviceType, equipmentId } = responder;
  try {
    port = await freshPortFor(port);
    progress("Abriendo la conexión con la balanza…");
    try {
      await openForSession(port, { baudRate: link.baudRate, dataBits: 8, stopBits: link.stopBits, parity: "none" }, session);
    } catch (err) {
      const c = errorClassification(err);
      return finish("puerto", `no se pudo abrir el puerto: ${c ? c.explanation : ""} (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`);
    }

    let hello = await sendRead(port, result.exchanges, "test de conexión", link, deviceType, equipmentId, "0001", "", timeout);
    if (!hello.kretz) hello = await sendRead(port, result.exchanges, "test de conexión (reintento)", link, deviceType, equipmentId, "0001", "", timeout);
    if (!hello.kretz) return finish("sin_respuesta", "la balanza no contestó el test de conexión: no se escribió nada");

    progress("Leyendo los productos de la balanza (copia antes de escribir)…");
    const before = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
    result.before = before.records;
    if (before.stoppedBy !== "fin") return finish("lectura_incompleta", `no se pudo leer la lista completa (${before.lastDetail}): no se escribió nada`);
    const clientBefore = before.records.filter((r) => !AURA_TEST_PLUS.includes(r.plu));
    const clientIntact = (list: { records: { plu: number; data: string }[]; stoppedBy: string }) => {
      const now = list.records.filter((r) => !AURA_TEST_PLUS.includes(r.plu));
      return list.stoppedBy === "fin" && now.length === clientBefore.length && clientBefore.every((b) => now.some((a) => a.plu === b.plu && a.data === b.data));
    };
    if (clientBefore.some((r) => r.plu >= 96)) return finish("plu_ocupado", "hay productos de la clienta con número 96 o más: no se escribió nada");
    const busy = before.records.filter((r) => AURA_TEST_PLUS.includes(r.plu) && !(r.plu === 99 && (r.data === AURA_FIRST_TEST_READBACK || AURA_TEST_RECORDS.includes(r.data))));
    if (busy.length) return finish("plu_ocupado", `el PLU ${busy.map((b) => b.plu).join(", ")} tiene otro producto: no se escribió nada`);

    for (const [i, product] of AURA_TEST_PRODUCTS.entries()) {
      const record = AURA_TEST_RECORDS[i];
      progress(`Cargando producto de prueba ${i + 1} de ${AURA_TEST_PRODUCTS.length} (PLU ${product.plu})…`);
      assertTestWrite("2005", record);
      const frame = buildKretzFrame(deviceType, equipmentId, "2005", record);
      const writer = port.writable!.getWriter();
      const t0 = Date.now();
      try {
        await writer.write(frame);
      } finally {
        writer.releaseLock();
      }
      const rx = await collect(port, Math.max(timeout, 2000), true);
      const kretz = parseKretzResponse(rx);
      result.exchanges.push({ step: `escribir PLU ${product.plu}`, link: `${link.baudRate}/${link.stopBits}`, tx: toHex(frame), rx: toHex(rx), rxText: toPrintable(rx), ms: Date.now() - t0, kretz, echo: false });
      const item: AuraTestItemResult = { plu: product.plu, purpose: product.purpose, sent: record, writeCode: kretz?.code ?? null, readBack: null, same: null };
      result.items.push(item);
      if (!kretz || kretz.code !== "01") break; // no se sigue escribiendo si la balanza rechaza uno
      await new Promise((r) => setTimeout(r, 400));
      const back = await sendRead(port, result.exchanges, `releer PLU ${product.plu}`, link, deviceType, equipmentId, "5005", String(product.plu - 1).padStart(6, "0"), timeout);
      const data = back.kretz?.code === "01" ? back.kretz.data : null;
      item.readBack = data && data.startsWith(String(product.plu).padStart(6, "0")) ? data : null;
      item.same = item.readBack ? compareAuraRecords(record, item.readBack) : null;
      const check = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
      result.after = check.records;
      if (!clientIntact(check)) return finish("otros_cambiaron", `después de cargar el PLU ${product.plu}, la lista de productos de la clienta no coincide: se frenó todo`);
    }

    if (result.items.length === AURA_TEST_PRODUCTS.length && result.items.every((it) => it.writeCode === "01")) {
      progress("Probando el borrado de un producto de prueba…");
      const listBefore = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
      if (!clientIntact(listBefore)) return finish("otros_cambiaron", "antes del borrado, la lista de productos de la clienta no coincide: se frenó todo");
      assertTestDelete("3005", AURA_TEST_DELETE_ARG, listBefore.records.filter((r) => !AURA_TEST_PLUS.includes(r.plu)).map((r) => r.plu));
      const frame = buildKretzFrame(deviceType, equipmentId, "3005", AURA_TEST_DELETE_ARG);
      const writer = port.writable!.getWriter();
      const t0 = Date.now();
      try {
        await writer.write(frame);
      } finally {
        writer.releaseLock();
      }
      const rx = await collect(port, Math.max(timeout, 2000), true);
      const kretz = parseKretzResponse(rx);
      result.exchanges.push({ step: "borrar producto de prueba", link: `${link.baudRate}/${link.stopBits}`, tx: toHex(frame), rx: toHex(rx), rxText: toPrintable(rx), ms: Date.now() - t0, kretz, echo: false });
      await new Promise((r) => setTimeout(r, 400));
      const listAfter = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
      result.deleteTest = {
        sent: AURA_TEST_DELETE_ARG,
        code: kretz?.code ?? null,
        removedPlus: listBefore.records.filter((b) => !listAfter.records.some((a) => a.plu === b.plu)).map((b) => b.plu),
        clientIntact: clientIntact(listAfter)
      };
      if (!result.deleteTest.clientIntact) return finish("otros_cambiaron", "después del borrado de prueba, la lista de productos de la clienta no coincide");
    }

    progress("Leyendo todos los productos otra vez (comprobar que los de la clienta no cambiaron)…");
    const after = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
    result.after = after.records;
    if (!clientIntact(after)) return finish("otros_cambiaron", "la lista de productos de la clienta no coincide antes y después (ver before/after)");
    const rejected = result.items.find((it) => it.writeCode !== "01");
    if (rejected) return finish("rechazada", `la balanza contestó el código ${rejected.writeCode ?? "(nada)"} al cargar el PLU ${rejected.plu}`);
    const diffs = result.items.filter((it) => !it.same || Object.values(it.same).some((v) => !v)).map((it) => it.plu);
    const loaded = diffs.length ? `se cargaron los ${result.items.length}; la balanza cambió algún dato en el PLU ${diffs.join(", ")} (ver detalle)` : `se cargaron los ${result.items.length} y se releyeron idénticos`;
    const d = result.deleteTest;
    const removed = d ? (d.removedPlus.length ? `; el borrado de prueba sacó el PLU ${d.removedPlus.join(", ")} (código ${d.code ?? "-"})` : `; el borrado de prueba no sacó nada (código ${d.code ?? "-"})`) : "";
    return finish("ok", loaded + removed);
  } catch (err) {
    return finish("error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    await closeQuietly(port);
    releasePort(claimed);
    result.finishedAt = new Date().toISOString();
  }
}

const KEY = "patagonia-scale-aura-write-test";

export function saveAuraWriteTest(r: AuraWriteTestResult): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // sin localStorage
  }
}

export function getLastAuraWriteTest(): AuraWriteTestResult | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AuraWriteTestResult) : null;
  } catch {
    return null;
  }
}
