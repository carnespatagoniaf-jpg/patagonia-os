import { buildKretzFrame, parseKretzResponse, toHex, toPrintable } from "./kretz-frame";
import { auraWriteToReadOrder, buildAuraWriteRecord, rewriteWithNewPrice, type AuraWriteInput } from "./aura-plu";
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
 * Segunda prueba (12:59): con P/C/N/D y códigos 97/98/96/500, todo quedó D y 0.
 *
 * CAUSA (capturada de iTegra, 2026-10-02): al escribir, el código va ANTES del
 * tipo (aura-plu.ts, buildAuraWriteRecord). Esta tercera prueba usa ese formato:
 * - PLU 97, por kilo (P), código 97, 2 días.
 * - PLU 98, por unidad (N), código 98: ticket para ver la venta por unidad.
 * - PLU 96, por unidad (N), código 960 (distinto del PLU), 3 días.
 * - PLU 99, por kilo (P), código 500 (distinto del PLU): ticket para ver el código de barras.
 * Se espera que al releer (5005) cada uno vuelva con SU tipo y SU código
 * (auraWriteToReadOrder). Si vuelven con D y 0 otra vez, el formato no es ese.
 *
 * Pasos:
 * 1. Lista completa antes. Frena si en 96 a 99 hay algo que no sea un producto
 *    de prueba nuestro (de las pruebas anteriores o de esta).
 * 2. 2005 de cada uno. `assertTestWrite` deja pasar SOLO estos 4 registros exactos y el del cambio de precio.
 * 3. Releer cada uno. Se frena todo (no se carga el siguiente) si:
 *    - no se puede releer;
 *    - volvió distinto en CUALQUIER campo (nombre, tipo, código, precio, tara, validez);
 *    - después de esa carga cambió cualquier producto de la clienta (se relee la lista entera).
 * 4. Cambio de precio del PLU 97 (2000 → 2100) reenviando el registro con el mismo
 *    código y tipo, como iTegra. Se relee y tiene que conservar todo lo demás.
 * 5. Lista completa final: los productos de la clienta tienen que estar idénticos.
 *
 * NO BORRA NADA, nunca (decisión del dueño, 2026-10-02): este módulo solo manda
 * 0001 y 5005 (de solo lectura, assertReadOnly) y 2005 con uno de los registros
 * de prueba (assertTestWrite). Los productos de prueba quedan en la balanza.
 */

export const AURA_WRITE_TEST_VERSION = "2026-10-03a";

export interface AuraTestProduct extends AuraWriteInput {
  purpose: string;
}

export const AURA_TEST_PRODUCTS: AuraTestProduct[] = [
  { plu: 97, name: "PRUEBA KILO", type: "P", code: 97, priceRaw: 2000, validityDays: 2, purpose: "por kilo, código 97, 2 días: ¿queda P y el código?" },
  { plu: 98, name: "PRUEBA UNIDAD", type: "N", code: 98, priceRaw: 500, validityDays: 0, purpose: "por unidad, código 98: ¿queda N y se vende por unidad? (ticket)" },
  { plu: 96, name: "PRUEBA UNIDAD V", type: "N", code: 960, priceRaw: 300, validityDays: 3, purpose: "por unidad, código 960 (distinto del PLU), 3 días: ¿queda N y el código?" },
  { plu: 99, name: "PRUEBA PATAGONIA", type: "P", code: 500, priceRaw: 1234, validityDays: 0, purpose: "por kilo, código 500 (distinto del PLU): ¿queda el código? ¿qué lleva el código de barras? (ticket)" }
];

/** Registros a mandar (orden de ESCRITURA) y cómo se espera releerlos (orden de LECTURA). */
export const AURA_TEST_RECORDS = AURA_TEST_PRODUCTS.map((p) => buildAuraWriteRecord(p));
export const AURA_TEST_EXPECTED_READBACK = AURA_TEST_RECORDS.map(auraWriteToReadOrder);
export const AURA_TEST_PLUS = AURA_TEST_PRODUCTS.map((p) => p.plu);

/** Cambio de precio (como iTegra: reenvía el registro completo con el mismo código y tipo): PLU 97 de 2000 a 2100. */
export const AURA_TEST_PRICE_CHANGE = { plu: 97, from: 2000, to: 2100 };
export const AURA_TEST_PRICE_CHANGE_RECORD = rewriteWithNewPrice(AURA_TEST_EXPECTED_READBACK[0], AURA_TEST_PRICE_CHANGE.to)!;
export const AURA_TEST_PRICE_CHANGE_READBACK = auraWriteToReadOrder(AURA_TEST_PRICE_CHANGE_RECORD);

/** Lo que quedó en la balanza real de las pruebas anteriores (lo único que se permite pisar en 96 a 99). */
export const AURA_FIRST_TEST_READBACK = "000099PRUEBA PATAGONIAD0000000012340000000";
export const AURA_PREVIOUS_TEST_READBACKS = [
  AURA_FIRST_TEST_READBACK,
  "000097PRUEBA KILO     D0000000020000000002",
  "000098PRUEBA UNIDAD   D0000000005000000000",
  "000096PRUEBA UNIDAD V D0000000003000000003"
];

export function assertTestWrite(command: string, data: string): void {
  if (command !== "2005" || !(AURA_TEST_RECORDS.includes(data) || data === AURA_TEST_PRICE_CHANGE_RECORD)) {
    throw new Error(`Bloqueado: en la Aura solo se permite escribir los productos de prueba (PLU ${AURA_TEST_PLUS.join(", ")}).`);
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
  | "diferencia" // un producto de prueba no se pudo releer o volvió distinto (nombre, tipo, código, precio, tara o validez): se frenó
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
    const busy = before.records.filter((r) => AURA_TEST_PLUS.includes(r.plu) && !AURA_PREVIOUS_TEST_READBACKS.includes(r.data) && !AURA_TEST_EXPECTED_READBACK.includes(r.data) && r.data !== AURA_TEST_PRICE_CHANGE_READBACK);
    if (busy.length) return finish("plu_ocupado", `el PLU ${busy.map((b) => b.plu).join(", ")} tiene otro producto: no se escribió nada`);

    /** Manda un 2005, lo relee, compara TODO y revisa que los de la clienta sigan iguales. Devuelve un motivo para frenar, o null. */
    const writeAndCheck = async (plu: number, purpose: string, record: string, expected: string): Promise<{ verdict: WriteTestVerdict; detail: string } | null> => {
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
      result.exchanges.push({ step: `escribir PLU ${plu}`, link: `${link.baudRate}/${link.stopBits}`, tx: toHex(frame), rx: toHex(rx), rxText: toPrintable(rx), ms: Date.now() - t0, kretz, echo: false });
      const item: AuraTestItemResult = { plu, purpose, sent: record, writeCode: kretz?.code ?? null, readBack: null, same: null };
      result.items.push(item);
      if (!kretz || kretz.code !== "01") {
        result.after = (await readPluList(port, responder, result.exchanges, { timeoutMs: timeout })).records; // constancia de cómo quedó todo
        return { verdict: "rechazada", detail: `la balanza contestó ${kretz ? `el código ${kretz.code}` : "nada"} al cargar el PLU ${plu}: se frenó todo` };
      }
      await new Promise((r) => setTimeout(r, 400));
      const back = await sendRead(port, result.exchanges, `releer PLU ${plu}`, link, deviceType, equipmentId, "5005", String(plu - 1).padStart(6, "0"), timeout);
      const data = back.kretz?.code === "01" ? back.kretz.data : null;
      item.readBack = data && data.startsWith(String(plu).padStart(6, "0")) ? data : null;
      // Se compara contra cómo DEBERÍA releerse (la Aura devuelve el tipo antes que el código).
      item.same = item.readBack ? compareAuraRecords(expected, item.readBack) : null;
      const check = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
      result.after = check.records;
      if (!clientIntact(check)) return { verdict: "otros_cambiaron", detail: `después de cargar el PLU ${plu}, la lista de productos de la clienta no coincide: se frenó todo` };
      if (!item.same) return { verdict: "diferencia", detail: `no se pudo releer el PLU ${plu} después de cargarlo: se frenó todo` };
      const wrong = Object.entries(item.same).filter(([, ok]) => !ok).map(([k]) => k);
      if (wrong.length) return { verdict: "diferencia", detail: `el PLU ${plu} volvió con otro ${wrong.join(", ")} (esperado ${expected}, leído ${item.readBack}): se frenó todo` };
      return null;
    };

    for (const [i, product] of AURA_TEST_PRODUCTS.entries()) {
      progress(`Cargando producto de prueba ${i + 1} de ${AURA_TEST_PRODUCTS.length} (PLU ${product.plu})…`);
      const stop = await writeAndCheck(product.plu, product.purpose, AURA_TEST_RECORDS[i], AURA_TEST_EXPECTED_READBACK[i]);
      if (stop) return finish(stop.verdict, stop.detail);
    }

    progress(`Cambiando el precio del PLU ${AURA_TEST_PRICE_CHANGE.plu} (comprobar que no se pierde nada)…`);
    const stop = await writeAndCheck(
      AURA_TEST_PRICE_CHANGE.plu,
      `cambio de precio de ${AURA_TEST_PRICE_CHANGE.from} a ${AURA_TEST_PRICE_CHANGE.to}: ¿se conservan tipo, código, tara y validez?`,
      AURA_TEST_PRICE_CHANGE_RECORD,
      AURA_TEST_PRICE_CHANGE_READBACK
    );
    if (stop) return finish(stop.verdict, stop.detail);

    progress("Leyendo todos los productos otra vez (comprobar que los de la clienta no cambiaron)…");
    const after = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
    result.after = after.records;
    if (!clientIntact(after)) return finish("otros_cambiaron", "la lista de productos de la clienta no coincide antes y después (ver before/after)");
    return finish("ok", `se cargaron los 4 productos de prueba con su tipo, código y precio, y el cambio de precio conservó todo lo demás`);
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
