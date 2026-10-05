import { buildKretzFrame, parseKretzResponse, toHex, toPrintable } from "./kretz-frame";
import { auraWriteToReadOrder, buildAuraWriteRecord, parseAuraPlu, rewriteWithNewPrice, AURA_PLU_RECORD_LENGTH } from "./aura-plu";
import { collect, readPluList, sendRead, type DiagnosticExchange, type KretzResponder } from "./discovery";
import { claimPort, closeQuietly, errorClassification, freshPortFor, newSession, openForSession, releasePort, type OpenAttempt } from "./port-session";

/**
 * Envío REAL de productos de Patagonia a la Kretz Aura (2026-10-05).
 *
 * Formato COMPROBADO en la Aura de la clienta (pruebas 2026-10-03 b y c):
 * - Escritura 2005: PLU(6) + nombre(16) + código(6) + tipo(1) + precio(6) + tara(4) + validez(3).
 * - "D" = por kilo y "C" = por unidad, precio en PESOS ENTEROS (tickets "26000.0$/kg", "1500.00$/U").
 *   "P"/"N" son lo mismo pero con centavos (tope $9.999,99): Patagonia nunca los escribe.
 * - Al releer (5005) vuelve exactamente auraWriteToReadOrder(lo mandado).
 * - El cambio de precio reenvía el registro completo con el mismo código y tipo; no se pierde nada.
 *
 * Reglas (pedido del dueño):
 * - Se lee todo lo que hay en la balanza antes (respaldo) y se arma un plan.
 * - Producto que ya está en la balanza con el MISMO nombre → se actualiza el precio
 *   conservando código, tara y validez (si estaba en P/N pasa a D/C, en pesos enteros).
 * - Número ocupado por OTRO producto (otro nombre o por kilo/unidad distinto) → no se toca,
 *   salvo que la persona tilde "Reemplazar" (los productos de prueba 96-99 de Patagonia se reemplazan solos).
 * - Número libre → se crea.
 * - Nunca se borra nada (no se manda 3005 ni 4005). Solo 0001, 5005 y 2005 con un registro del plan.
 * - Después de cada escritura se relee y se compara; ante cualquier diferencia se frena.
 * - Al final se releen todos y los que no estaban en el plan tienen que estar idénticos.
 */

export const AURA_MAX_PLU = 9999;
export const AURA_MAX_CODE = 99999;

export interface AuraSyncProduct {
  code: string;
  name: string;
  byWeight: boolean;
  /** Pesos, como en Patagonia. */
  price: number;
}

export type AuraSyncAction = "crear" | "actualizar" | "reemplazar" | "sin_cambios" | "conflicto" | "omitir";

export interface AuraSyncItem {
  plu: number | null;
  name: string;
  action: AuraSyncAction;
  reason: string;
  /** Lo que hay hoy en la balanza en ese PLU (orden de lectura), si hay algo. */
  current: string | null;
  /** Registro 2005 a mandar (orden de escritura), o null. */
  record: string | null;
  /** Cómo tiene que releerse si la balanza lo guardó bien. */
  expected: string | null;
}

/** Nombre como lo guarda la balanza (mayúsculas, sin acentos, 16 letras). */
export function auraName(name: string): string {
  return buildAuraWriteRecord({ plu: 1, name, type: "D", code: 1, priceRaw: 0 }).slice(6, 22).trimEnd();
}

function isPatagoniaTestProduct(current: string): boolean {
  const plu = Number(current.slice(0, 6));
  return plu >= 96 && plu <= 99 && current.slice(6, 22).startsWith("PRUEBA ");
}

export function planAuraSync(scaleRecords: string[], products: AuraSyncProduct[], options: { replaceConflicts?: boolean } = {}): AuraSyncItem[] {
  const byPlu = new Map(scaleRecords.filter((r) => r.length === AURA_PLU_RECORD_LENGTH).map((r) => [Number(r.slice(0, 6)), r]));
  const seen = new Set<number>();
  return products.map((p): AuraSyncItem => {
    const base = { name: p.name, current: null as string | null, record: null as string | null, expected: null as string | null };
    const code = p.code.trim();
    const plu = /^\d+$/.test(code) ? Number(code) : NaN;
    if (!Number.isInteger(plu) || plu < 1 || plu > AURA_MAX_PLU) {
      return { ...base, plu: null, action: "omitir", reason: `el código "${p.code}" tiene que ser un número de 1 a ${AURA_MAX_PLU} (es el número de producto en la balanza)` };
    }
    if (seen.has(plu)) return { ...base, plu, action: "omitir", reason: `hay otro producto de Patagonia con el código ${plu}` };
    seen.add(plu);
    if (!(p.price >= 0)) return { ...base, plu, action: "omitir", reason: "precio inválido" };
    const priceRaw = Math.round(p.price);
    if (priceRaw > 999999) return { ...base, plu, action: "omitir", reason: "precio de más de $999.999: no entra en la balanza" };
    const type = p.byWeight ? "D" : "C";
    const current = byPlu.get(plu) ?? null;
    const fresh = () => buildAuraWriteRecord({ plu, name: p.name, type, code: plu, priceRaw });
    if (!current) {
      const record = fresh();
      return { ...base, plu, action: "crear", reason: p.byWeight ? "nuevo, por kilo" : "nuevo, por unidad", record, expected: auraWriteToReadOrder(record) };
    }
    const cur = parseAuraPlu(current);
    if (!cur) return { ...base, plu, current, action: "omitir", reason: "lo que hay en la balanza en ese número no se pudo leer" };
    const sameName = cur.name === auraName(p.name);
    const curByWeight = cur.type === "D" || cur.type === "P";
    const curKnownType = ["D", "C", "P", "N"].includes(cur.type);
    if (!sameName || !curKnownType || curByWeight !== p.byWeight) {
      const why = !sameName ? `en la balanza el ${plu} es "${cur.name}"` : `en la balanza "${cur.name}" está ${curByWeight ? "por kilo" : "por unidad"}`;
      if (options.replaceConflicts || isPatagoniaTestProduct(current)) {
        const record = fresh();
        return { ...base, plu, current, action: "reemplazar", reason: isPatagoniaTestProduct(current) ? "reemplaza un producto de prueba de Patagonia" : `${why}: se reemplaza`, record, expected: auraWriteToReadOrder(record) };
      }
      return { ...base, plu, current, action: "conflicto", reason: `${why}: no se toca (tildá "Reemplazar" si querés pisarlo)` };
    }
    let record: string | null;
    if (cur.type === "D" || cur.type === "C") {
      if (Number(cur.priceRaw) === priceRaw) return { ...base, plu, current, action: "sin_cambios", reason: "ya tiene ese precio" };
      record = rewriteWithNewPrice(current, priceRaw, ["D", "C"]);
    } else {
      // P/N tienen el precio con centavos: se pasa a D/C (pesos enteros) conservando código, tara y validez.
      record = buildAuraWriteRecord({ plu, name: cur.name, type, code: Number(current.slice(23, 28)), priceRaw, tareGrams: Number(cur.tareRaw), validityDays: cur.validityDays });
    }
    if (!record) return { ...base, plu, current, action: "omitir", reason: "no se pudo armar el registro" };
    const what = cur.type === "D" || cur.type === "C" ? `precio ${Number(cur.priceRaw)} → ${priceRaw}` : `precio a ${priceRaw} en pesos enteros`;
    return { ...base, plu, current, action: "actualizar", reason: `${what}; conserva código, tara y validez`, record, expected: auraWriteToReadOrder(record) };
  });
}

export function summarizeAuraPlan(plan: AuraSyncItem[]): Record<AuraSyncAction, number> {
  const out: Record<AuraSyncAction, number> = { crear: 0, actualizar: 0, reemplazar: 0, sin_cambios: 0, conflicto: 0, omitir: 0 };
  for (const it of plan) out[it.action]++;
  return out;
}

export type AuraSyncVerdict = "ok" | "puerto" | "sin_respuesta" | "lectura_incompleta" | "cambio_la_balanza" | "rechazada" | "diferencia" | "otros_cambiaron" | "frenado" | "error";

export interface AuraSyncResult {
  verdict: AuraSyncVerdict;
  detail: string;
  written: { plu: number; action: AuraSyncAction }[];
  stoppedAt: { plu: number; sent: string; readBack: string | null; expected: string } | null;
  before: { plu: number; data: string }[];
  after: { plu: number; data: string }[];
  exchanges: DiagnosticExchange[];
  openLog: OpenAttempt[];
  startedAt: string;
  finishedAt: string;
}

/** Lee la lista completa de la Aura (SOLO LECTURA: 0001 y 5005). */
export async function readAuraList(port: SerialPort, responder: KretzResponder, options: { timeoutMs?: number; onProgress?: (t: string) => void } = {}): Promise<{ records: { plu: number; data: string }[]; complete: boolean; detail: string; exchanges: DiagnosticExchange[] }> {
  const exchanges: DiagnosticExchange[] = [];
  if (!claimPort(port)) return { records: [], complete: false, detail: "ya hay otra operación con esta balanza en esta pestaña", exchanges };
  const claimed = port;
  try {
    port = await freshPortFor(port);
    try {
      await openForSession(port, { baudRate: responder.link.baudRate, dataBits: 8, stopBits: responder.link.stopBits, parity: "none" }, newSession(4, []));
    } catch (err) {
      const c = errorClassification(err);
      return { records: [], complete: false, detail: `no se pudo abrir el puerto: ${c ? c.explanation : err instanceof Error ? err.message : String(err)}`, exchanges };
    }
    const list = await readPluList(port, responder, exchanges, { timeoutMs: options.timeoutMs ?? 1500, onProgress: options.onProgress });
    return { records: list.records, complete: list.stoppedBy === "fin", detail: list.stoppedBy === "fin" ? `${list.records.length} productos en la balanza` : `no se pudo leer la lista completa (${list.lastDetail})`, exchanges };
  } finally {
    await closeQuietly(port);
    releasePort(claimed);
  }
}

export async function runAuraSync(
  port: SerialPort,
  responder: KretzResponder,
  plan: AuraSyncItem[],
  options: { timeoutMs?: number; onProgress?: (text: string) => void; shouldStop?: () => boolean } = {}
): Promise<AuraSyncResult> {
  const timeout = options.timeoutMs ?? 1500;
  const progress = options.onProgress ?? (() => {});
  const work = plan.filter((p) => p.record && p.expected && p.plu !== null && (p.action === "crear" || p.action === "actualizar" || p.action === "reemplazar"));
  const allowed = new Set(work.map((w) => w.record!));
  const result: AuraSyncResult = { verdict: "error", detail: "", written: [], stoppedAt: null, before: [], after: [], exchanges: [], openLog: [], startedAt: new Date().toISOString(), finishedAt: "" };
  const finish = (verdict: AuraSyncVerdict, detail: string) => {
    result.verdict = verdict;
    result.detail = detail;
    return result;
  };
  if (!claimPort(port)) {
    result.finishedAt = new Date().toISOString();
    return finish("puerto", "ya hay otra operación con esta balanza en esta pestaña");
  }
  const claimed = port;
  const { link, deviceType, equipmentId } = responder;
  try {
    port = await freshPortFor(port);
    progress("Abriendo la conexión con la balanza…");
    try {
      await openForSession(port, { baudRate: link.baudRate, dataBits: 8, stopBits: link.stopBits, parity: "none" }, newSession(4, result.openLog));
    } catch (err) {
      const c = errorClassification(err);
      return finish("puerto", `no se pudo abrir el puerto: ${c ? c.explanation : ""} (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`);
    }
    let hello = await sendRead(port, result.exchanges, "test de conexión", link, deviceType, equipmentId, "0001", "", timeout);
    if (!hello.kretz) hello = await sendRead(port, result.exchanges, "test de conexión (reintento)", link, deviceType, equipmentId, "0001", "", timeout);
    if (!hello.kretz) return finish("sin_respuesta", "la balanza no contestó: no se mandó nada");

    progress("Leyendo los productos de la balanza (respaldo antes de mandar)…");
    const before = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout, onProgress: progress });
    result.before = before.records;
    if (before.stoppedBy !== "fin") return finish("lectura_incompleta", `no se pudo leer la lista completa (${before.lastDetail}): no se mandó nada`);
    const nowByPlu = new Map(before.records.map((r) => [r.plu, r.data]));
    for (const w of work) {
      if ((nowByPlu.get(w.plu!) ?? null) !== w.current) return finish("cambio_la_balanza", `el PLU ${w.plu} cambió en la balanza desde que se armó el envío: volvé a leer la balanza`);
    }

    for (const [i, w] of work.entries()) {
      if (options.shouldStop?.()) return finish("frenado", `se frenó a pedido después de ${result.written.length} productos`);
      progress(`Mandando ${i + 1} de ${work.length}: PLU ${w.plu} ${w.name}…`);
      if (!allowed.has(w.record!)) throw new Error("Bloqueado: registro fuera del plan");
      const frame = buildKretzFrame(deviceType, equipmentId, "2005", w.record!);
      const writer = port.writable!.getWriter();
      const t0 = Date.now();
      try {
        await writer.write(frame);
      } finally {
        writer.releaseLock();
      }
      const rx = await collect(port, Math.max(timeout, 2000), true);
      const kretz = parseKretzResponse(rx);
      result.exchanges.push({ step: `escribir PLU ${w.plu}`, link: `${link.baudRate}/${link.stopBits}`, tx: toHex(frame), rx: toHex(rx), rxText: toPrintable(rx), ms: Date.now() - t0, kretz, echo: false });
      if (result.exchanges.length > 60) result.exchanges.splice(20, 1);
      // Sin respuesta o con error: no se reenvía a ciegas, se relee para saber qué quedó.
      await new Promise((r) => setTimeout(r, 250));
      const back = await sendRead(port, result.exchanges, `releer PLU ${w.plu}`, link, deviceType, equipmentId, "5005", String(w.plu! - 1).padStart(6, "0"), timeout);
      const data = back.kretz?.code === "01" && back.kretz.data.startsWith(String(w.plu).padStart(6, "0")) ? back.kretz.data : null;
      if (data !== w.expected) {
        result.stoppedAt = { plu: w.plu!, sent: w.record!, readBack: data, expected: w.expected! };
        if (kretz && kretz.code !== "01" && data === w.current) return finish("rechazada", `la balanza no aceptó el PLU ${w.plu} (código ${kretz.code}); quedó como estaba. Se frenó`);
        return finish("diferencia", `el PLU ${w.plu} no quedó como se mandó (leído: ${data ?? "nada"}). Se frenó`);
      }
      result.written.push({ plu: w.plu!, action: w.action });
    }

    progress("Comprobando que los demás productos de la balanza no cambiaron…");
    const after = await readPluList(port, responder, result.exchanges, { timeoutMs: timeout });
    result.after = after.records;
    const touched = new Set(result.written.map((w) => w.plu));
    const afterMap = new Map(after.records.map((r) => [r.plu, r.data]));
    const changed = before.records.filter((r) => !touched.has(r.plu) && afterMap.get(r.plu) !== r.data).map((r) => r.plu);
    if (after.stoppedBy !== "fin") return finish("lectura_incompleta", `se mandaron ${result.written.length} productos, pero no se pudo releer la lista completa al final`);
    if (changed.length) return finish("otros_cambiaron", `cambiaron productos que no estaban en el envío: ${changed.slice(0, 20).join(", ")}`);
    return finish("ok", `se mandaron ${result.written.length} productos y cada uno quedó exactamente como se mandó`);
  } catch (err) {
    return finish("error", err instanceof Error ? err.message : String(err));
  } finally {
    await closeQuietly(port);
    releasePort(claimed);
    result.finishedAt = new Date().toISOString();
  }
}
