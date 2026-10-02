import { buildKretzFrame, parseKretzResponse, toHex, toPrintable } from "./kretz-frame";
import { buildAuraPluRecord } from "./aura-plu";
import { collect, readPluList, sendRead, type DiagnosticExchange, type KretzResponder } from "./discovery";
import { claimPort, closeQuietly, errorClassification, freshPortFor, newSession, openForSession, releasePort, type OpenAttempt } from "./port-session";

/**
 * Prueba de escritura controlada en la Kretz Aura: UN producto, en un PLU libre.
 *
 * Es lo único que escribe en una Aura. Pasos:
 * 1. Abrir el puerto como en las pruebas que anduvieron (port-session).
 * 2. Hacer el test de conexión 0001.
 * 3. Leer TODOS los PLU (copia "antes"). Si el PLU de prueba ya existe, o la lectura no llegó al final, se frena sin escribir.
 * 4. Mandar 2005 con el registro de prueba. `assertTestWrite` deja pasar
 *    SOLO ese comando con ESE registro exacto.
 * 5. Releer el PLU de prueba (5005 con PLU − 1) y compararlo byte por byte.
 * 6. Leer TODOS los PLU otra vez. Los de la clienta tienen que estar idénticos;
 *    solo puede aparecer el de prueba.
 * El producto de prueba queda en la balanza para mirar en su pantalla qué
 * precio muestra (eso confirma el factor del precio). No se borra con 3005,
 * porque el borrado todavía no está probado en la Aura.
 */

export const AURA_TEST_PLU = 99;
export const AURA_TEST_PRODUCT = { plu: AURA_TEST_PLU, name: "PRUEBA PATAGONIA", type: "P" as const, priceRaw: 1234 };
export const AURA_TEST_RECORD = buildAuraPluRecord(AURA_TEST_PRODUCT);
export const AURA_WRITE_TEST_VERSION = "2026-10-02d";

export function assertTestWrite(command: string, data: string): void {
  if (command !== "2005" || data !== AURA_TEST_RECORD) {
    throw new Error(`Bloqueado: en la Aura solo se permite escribir el producto de prueba (PLU ${AURA_TEST_PLU}).`);
  }
}

export type WriteTestVerdict =
  | "ok" // escribió, releyó idéntico y los demás quedaron igual
  | "puerto" // no abrió
  | "sin_respuesta" // no contestó el 0001
  | "lectura_incompleta" // no se pudo leer la lista completa antes: no se escribió
  | "plu_ocupado" // el PLU de prueba ya existía: no se escribió
  | "rechazada" // la balanza contestó otro código al 2005
  | "no_coincide" // contestó 01 pero al releer no está igual
  | "otros_cambiaron" // ¡algún producto de la clienta cambió! (no debería pasar)
  | "error";

export interface AuraWriteTestResult {
  version: string;
  startedAt: string;
  finishedAt: string;
  verdict: WriteTestVerdict;
  detail: string;
  record: string;
  writeCode: string | null;
  readBack: string | null;
  before: { plu: number; data: string }[];
  after: { plu: number; data: string }[];
  exchanges: DiagnosticExchange[];
  openLog: OpenAttempt[];
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
    record: AURA_TEST_RECORD,
    writeCode: null,
    readBack: null,
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
    if (before.records.some((r) => r.plu === AURA_TEST_PLU)) return finish("plu_ocupado", `el PLU ${AURA_TEST_PLU} ya tiene un producto: no se escribió nada`);

    progress(`Cargando el producto de prueba en el PLU ${AURA_TEST_PLU}…`);
    assertTestWrite("2005", AURA_TEST_RECORD);
    const frame = buildKretzFrame(deviceType, equipmentId, "2005", AURA_TEST_RECORD);
    const writer = port.writable!.getWriter();
    const t0 = Date.now();
    try {
      await writer.write(frame);
    } finally {
      writer.releaseLock();
    }
    const rx = await collect(port, Math.max(timeout, 2000), true);
    const kretz = parseKretzResponse(rx);
    result.exchanges.push({ step: "escribir producto de prueba", link: `${link.baudRate}/${link.stopBits}`, tx: toHex(frame), rx: toHex(rx), rxText: toPrintable(rx), ms: Date.now() - t0, kretz, echo: false });
    result.writeCode = kretz?.code ?? null;
    if (!kretz || kretz.code !== "01") {
      // Igual se relee la lista, para dejar constancia de que no cambió nada.
      const check = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
      result.after = check.records;
      return finish("rechazada", kretz ? `la balanza contestó el código ${kretz.code} al cargar el producto` : rx.length ? `respuesta no reconocida: ${toHex(rx)}` : "la balanza no contestó a la carga");
    }

    await new Promise((r) => setTimeout(r, 400));
    progress("Releyendo el producto de prueba…");
    const back = await sendRead(port, result.exchanges, "releer producto de prueba", link, deviceType, equipmentId, "5005", String(AURA_TEST_PLU - 1).padStart(6, "0"), timeout);
    result.readBack = back.kretz?.code === "01" ? back.kretz.data : null;

    progress("Leyendo todos los productos otra vez (comprobar que los demás no cambiaron)…");
    const after = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
    result.after = after.records;
    const untouched = before.records.every((b) => after.records.some((a) => a.plu === b.plu && a.data === b.data));
    const onlyNew = after.records.filter((a) => !before.records.some((b) => b.plu === a.plu));
    if (after.stoppedBy !== "fin" || !untouched || onlyNew.some((a) => a.plu !== AURA_TEST_PLU)) {
      return finish("otros_cambiaron", "la lista de después no coincide con la de antes (ver before/after)");
    }
    if (result.readBack !== AURA_TEST_RECORD) {
      return finish("no_coincide", `se mandó ${JSON.stringify(AURA_TEST_RECORD)} y se releyó ${JSON.stringify(result.readBack)}`);
    }
    return finish("ok", "se cargó, se releyó idéntico y los demás productos quedaron iguales");
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
