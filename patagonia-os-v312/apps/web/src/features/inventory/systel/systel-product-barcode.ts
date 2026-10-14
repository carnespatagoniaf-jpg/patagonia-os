import type { SystelClient } from "./systel-client";
import { describeSystelError } from "./systel-frame";
import { LAYOUT_INFO, pluEanSetting, type SystelLayout } from "./systel-plu";

/**
 * Hacer que la balanza imprima el código de barras de CADA producto en el ticket (producto + cantidad),
 * cambiando solo el "código de barras propio" de cada producto, desde Patagonia.
 *
 * Por qué (REAL, Los gringos 14/10): 87 de sus productos tienen código propio "000000000000" (por eso el ticket
 * imprime "0 000000 000000"), 4 tienen uno útil (13 y 14 "20PPPPCCCCCC", 50 y 51 "21PPPPCCCCCC") y 12 usan el
 * general "20PPPPCCCCII" (cantidad de 4 cifras: no entra un peso de 10 kg o más).
 *
 * Cómo, sin arriesgar el producto:
 * 1. Se lee el producto completo (62).
 * 2. Se arma la escritura (61) con EXACTAMENTE lo leído (sin el carácter de "gestión", que la escritura no
 *    lleva: documento V6.0 págs. 19-21) y se cambian SOLO los 12 caracteres del código propio. El byte del
 *    tipo se deja como lo usa la balanza para "propio" (0x01, leído así en sus productos 13, 14, 50 y 51).
 * 3. Se relee y se compara con lo leído: tiene que ser idéntico salvo el tipo, el código propio y la "gestión".
 * 4. Si cambió cualquier otra cosa, se vuelve a escribir el registro ORIGINAL y se frena todo.
 * Sin ACK de la balanza el resultado es "indeterminado" aunque la relectura muestre el cambio.
 */

export const WEIGHED_TICKET_CODE = "20PPPPCCCCCC";
export const UNIT_TICKET_CODE = "21PPPPCCCCCC";

export type BarcodeRewriteVerdict = "ya_estaba" | "confirmado" | "indeterminado" | "rechazado" | "diferencia_restaurado" | "diferencia_sin_restaurar" | "sin_lectura" | "no_soportado" | "bloqueado";

export interface BarcodeRewriteResult {
  number: number;
  verdict: BarcodeRewriteVerdict;
  ok: boolean;
  detail: string;
  before: string | null;
  after: string | null;
}

/** El código que corresponde según la forma de venta del producto (P/C pesable, U unitario). */
export function targetCodeFor(saleType: string): string | null {
  if (saleType === "P" || saleType === "C") return WEIGHED_TICKET_CODE;
  if (saleType === "U") return UNIT_TICKET_CODE;
  return null;
}

/**
 * Datos de la escritura (61) a partir del registro leído (62): sin el carácter de gestión y con el código
 * propio nuevo. Devuelve null si el registro no tiene la forma esperada (no se escribe nada).
 */
/**
 * Cómo va el tipo de código en la escritura. El documento (V6.0/V7, función 61) dice "1 número", pero la balanza lo
 * DEVUELVE como byte 0x01 (función 62, real Los gringos). "binario" manda lo mismo que devuelve; "ascii" manda el dígito.
 * Cuál acepta se averigua UNA vez, en un número de producto libre (systel-barcode-write-test.ts), y después se usa ese.
 */
export type TypeByteMode = "binario" | "ascii";

export function buildBarcodeRewrite(readRaw: string, layout: SystelLayout, newConfig: string, mode: TypeByteMode = "binario"): string | null {
  if (!/^[0-9PCIBS]{12}$/.test(newConfig)) return null;
  if (layout === "cuora2") return null;
  const pd = LAYOUT_INFO[layout].pluDigits;
  const ean = pluEanSetting(readRaw);
  if (ean.type === null || ean.config === null) return null;
  const end = readRaw[readRaw.length - 1] === "N" ? readRaw.length - 1 : readRaw.length - 101;
  const typeAt = end - 13;
  const typeChar = mode === "ascii" ? "1" : "\u0001";
  const updated = readRaw.slice(0, typeAt) + typeChar + newConfig + readRaw.slice(end);
  return updated.slice(0, pd) + updated.slice(pd + 1);
}

/**
 * Datos de escritura (sin gestión) de un registro leído, con el tipo de código en la forma que acepta la balanza.
 * Lo usa la restauración: si la balanza solo acepta el dígito, el respaldo (que tiene el byte) se manda con el dígito.
 */
export function writeDataFromRead(readRaw: string, layout: SystelLayout, mode: TypeByteMode): string {
  const pd = LAYOUT_INFO[layout].pluDigits;
  const end = readRaw[readRaw.length - 1] === "N" ? readRaw.length - 1 : readRaw.length - 101;
  const typeAt = end - 13;
  const t = readRaw.charCodeAt(typeAt);
  // Se manda solo el tipo (parte baja): nunca los bits que agrega la balanza (real: 0xD1), que no van en una escritura.
  const low = t >= 0x80 ? t & 0x0f : t;
  const typed = t >= 0x80 || (mode === "ascii" && t <= 3) ? readRaw.slice(0, typeAt) + (mode === "ascii" ? String(low) : String.fromCharCode(low)) + readRaw.slice(typeAt + 1) : readRaw;
  return typed.slice(0, pd) + typed.slice(pd + 1);
}

/** ¿El registro releído es igual al de antes salvo tipo + código propio + gestión? */
export function onlyBarcodeChanged(before: string, after: string, layout: SystelLayout): boolean {
  if (before.length !== after.length) return false;
  const pd = LAYOUT_INFO[layout].pluDigits;
  const end = before[before.length - 1] === "N" ? before.length - 1 : before.length - 101;
  const allowed = new Set<number>([pd]);
  for (let i = end - 13; i < end; i++) allowed.add(i);
  for (let i = 0; i < before.length; i++) if (!allowed.has(i) && !sameIgnoringLotePadding(before[i], after[i], i, end)) return false;
  return true;
}

/**
 * REAL (Los gringos 14/10, producto 97): al escribir, la balanza guarda 0x00 donde el campo lote (12 caracteres
 * antes del tipo) tenía un espacio de relleno. No es un cambio de datos: ahí espacio y 0x00 valen lo mismo.
 */
export function sameIgnoringLotePadding(a: string, b: string, i: number, end: number): boolean {
  if (a === b) return true;
  const pad = (c: string) => c === " " || c === "\u0000";
  return i >= end - 25 && i < end - 13 && pad(a) && pad(b);
}

export async function rewriteProductBarcode(client: SystelClient, layout: SystelLayout, number: number, saleType: string, mode: TypeByteMode = "binario"): Promise<BarcodeRewriteResult> {
  const base = { number, before: null as string | null, after: null as string | null };
  const target = targetCodeFor(saleType);
  if (!target) return { ...base, verdict: "no_soportado", ok: false, detail: `forma de venta "${saleType}" sin código definido` };
  const current = await client.readPlu(layout, number);
  if (!current) return { ...base, verdict: "sin_lectura", ok: false, detail: "no se pudo leer el producto; no se escribió nada" };
  const ean = pluEanSetting(current.raw);
  if (ean.type === 1 && ean.config === target) return { ...base, before: current.raw, after: current.raw, verdict: "ya_estaba", ok: true, detail: `ya tenía ${target}` };
  const data = buildBarcodeRewrite(current.raw, layout, target, mode);
  if (!data) return { ...base, before: current.raw, verdict: "no_soportado", ok: false, detail: "el registro no tiene la forma esperada; no se escribió nada" };

  // Control ANTES de mandar: lo que se va a escribir es el registro leído con solo el código cambiado (si no, no se manda).
  const pd0 = LAYOUT_INFO[layout].pluDigits;
  if (!onlyBarcodeChanged(current.raw, data.slice(0, pd0) + current.raw[pd0] + data.slice(pd0), layout)) {
    return { ...base, before: current.raw, verdict: "no_soportado", ok: false, detail: "lo que se iba a escribir no coincide con lo leído salvo el código: no se mandó nada" };
  }
  const reply = await client.writePluRaw(layout, number, data);
  if (reply === "bloqueado") return { ...base, before: current.raw, verdict: "bloqueado", ok: false, detail: "la escritura está bloqueada en Patagonia" };
  if (reply && reply.kind === "error") return { ...base, before: current.raw, verdict: "rechazado", ok: false, detail: `la balanza rechazó la escritura (${describeSystelError(reply.errorCode)}); no cambió nada` };

  const back = await client.readPlu(layout, number);
  if (!back) return { ...base, before: current.raw, verdict: "indeterminado", ok: false, detail: "se escribió pero no se pudo releer para comprobar" };
  const backEan = pluEanSetting(back.raw);
  const changedOk = backEan.type === 1 && backEan.config === target && onlyBarcodeChanged(current.raw, back.raw, layout);
  if (!onlyBarcodeChanged(current.raw, back.raw, layout)) {
    // Cambió algo más: se vuelve a escribir el registro ORIGINAL (sin la gestión) y se relee.
    const original = writeDataFromRead(current.raw, layout, mode);
    await client.writePluRaw(layout, number, original);
    const restored = await client.readPlu(layout, number);
    const same = !!restored && onlyBarcodeChanged(current.raw, restored.raw, layout) && pluEanSetting(restored.raw).config === ean.config;
    return {
      ...base,
      before: current.raw,
      after: back.raw,
      verdict: same ? "diferencia_restaurado" : "diferencia_sin_restaurar",
      ok: false,
      detail: same ? "la relectura mostró otros cambios: se restauró el producto como estaba" : "la relectura mostró otros cambios y NO se pudo confirmar la restauración"
    };
  }
  if (!changedOk) return { ...base, before: current.raw, after: back.raw, verdict: "indeterminado", ok: false, detail: "la balanza no aplicó el código nuevo" };
  if (!reply || reply.kind !== "ack") return { ...base, before: current.raw, after: back.raw, verdict: "indeterminado", ok: false, detail: "la relectura muestra el cambio pero la balanza no confirmó la orden" };
  return { ...base, before: current.raw, after: back.raw, verdict: "confirmado", ok: true, detail: `código ${target} confirmado` };
}

export interface BulkBarcodeResult {
  backup: { number: number; raw: string }[];
  results: BarcodeRewriteResult[];
  stoppedAt: number | null;
}

/**
 * Todos los productos: primero se lee y guarda el respaldo de TODOS; después se cambia uno por uno y se frena
 * en el primero que no quede confirmado (o "ya_estaba"). `limit` permite hacer solo el primero (prueba).
 */
export async function rewriteAllProductBarcodes(
  client: SystelClient,
  layout: SystelLayout,
  products: { number: number; saleType: string }[],
  opts: { limit?: number; onProgress?: (t: string) => void; mode?: TypeByteMode } = {}
): Promise<BulkBarcodeResult> {
  const backup: { number: number; raw: string }[] = [];
  for (const [i, p] of products.entries()) {
    opts.onProgress?.(`Respaldo ${i + 1} de ${products.length}`);
    const plu = await client.readPlu(layout, p.number);
    if (!plu) return { backup, results: [{ number: p.number, verdict: "sin_lectura", ok: false, detail: "no se pudo leer el producto para el respaldo; no se cambió nada", before: null, after: null }], stoppedAt: p.number };
    backup.push({ number: p.number, raw: plu.raw });
  }
  const results: BarcodeRewriteResult[] = [];
  const todo = products.slice(0, opts.limit ?? products.length);
  for (const [i, p] of todo.entries()) {
    opts.onProgress?.(`Producto ${i + 1} de ${todo.length}`);
    const r = await rewriteProductBarcode(client, layout, p.number, p.saleType, opts.mode ?? "binario");
    results.push(r);
    if (!r.ok) return { backup, results, stoppedAt: p.number };
  }
  return { backup, results, stoppedAt: null };
}

// ── Respaldo, comparación y restauración ─────────────────────────────────────────────────────────────

export interface ProductBackup {
  /** Cuándo se leyó (ISO) y de qué balanza. */
  takenAt: string;
  address: number;
  layout: SystelLayout;
  records: { number: number; raw: string }[];
  /** Huella de todos los registros juntos: si un byte cambia, cambia la huella. */
  digest: string;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function backupDigest(records: { number: number; raw: string }[]): string {
  return fnv1a(records.map((r) => `${r.number}:${r.raw}`).join("\n"));
}

/**
 * Respaldo SOLO LECTURA de los productos indicados. Está completo solo si se leyó cada uno con el formato
 * esperado y con su código de barras propio reconocible. Se puede verificar después (`verifyBackup`).
 */
export async function takeProductBackup(client: SystelClient, layout: SystelLayout, numbers: number[], onProgress?: (t: string) => void): Promise<{ backup: ProductBackup; missing: number[] }> {
  const records: { number: number; raw: string }[] = [];
  const missing: number[] = [];
  for (const [i, n] of numbers.entries()) {
    onProgress?.(`Respaldo ${i + 1} de ${numbers.length}`);
    const plu = await client.readPlu(layout, n);
    if (!plu || pluEanSetting(plu.raw).type === null) missing.push(n);
    else records.push({ number: n, raw: plu.raw });
  }
  return { backup: { takenAt: new Date().toISOString(), address: client.address, layout, records, digest: backupDigest(records) }, missing };
}

/** ¿El respaldo está entero (misma huella) y cada registro tiene la forma de un producto? */
export function verifyBackup(b: ProductBackup): { ok: boolean; detail: string } {
  if (backupDigest(b.records) !== b.digest) return { ok: false, detail: "la huella no coincide: el respaldo se modificó o está incompleto" };
  const bad = b.records.filter((r) => pluEanSetting(r.raw).type === null || !r.raw.startsWith(String(r.number).padStart(LAYOUT_INFO[b.layout].pluDigits, "0")));
  if (bad.length) return { ok: false, detail: `${bad.length} registros no tienen la forma esperada (${bad.map((r) => r.number).join(", ")})` };
  return { ok: true, detail: `${b.records.length} productos, huella ${b.digest}` };
}

export type CompareState = "igual" | "solo_codigo" | "otra_diferencia" | "sin_lectura";

function sameAsBackup(original: string, now: string, layout: SystelLayout): boolean {
  const a = pluEanSetting(original);
  const b = pluEanSetting(now);
  return onlyBarcodeChanged(original, now, layout) && a.config === b.config && a.type === b.type;
}

/**
 * SOLO LECTURA: cómo está cada producto respecto del respaldo. Es lo primero que se hace si se cortó la
 * conexión en medio de una escritura: "igual" (no se escribió), "solo_codigo" (se escribió el código y nada
 * más), "otra_diferencia" (hay que restaurar) o "sin_lectura".
 */
export async function compareWithBackup(client: SystelClient, b: ProductBackup): Promise<{ number: number; state: CompareState }[]> {
  const out: { number: number; state: CompareState }[] = [];
  for (const r of b.records) {
    const now = await client.readPlu(b.layout, r.number);
    if (!now) out.push({ number: r.number, state: "sin_lectura" });
    else if (sameAsBackup(r.raw, now.raw, b.layout)) out.push({ number: r.number, state: "igual" });
    else if (onlyBarcodeChanged(r.raw, now.raw, b.layout)) out.push({ number: r.number, state: "solo_codigo" });
    else out.push({ number: r.number, state: "otra_diferencia" });
  }
  return out;
}

/**
 * Vuelve los productos indicados (o todos) a como estaban en el respaldo: escribe el registro original (sin la
 * gestión), relee y compara. Requiere la escritura habilitada. Los que ya están iguales no se tocan.
 */
export async function restoreFromBackup(client: SystelClient, b: ProductBackup, numbers?: number[], mode: TypeByteMode = "binario"): Promise<{ number: number; verdict: "igual" | "restaurado" | "no_restaurado" | "bloqueado" }[]> {
  const out: { number: number; verdict: "igual" | "restaurado" | "no_restaurado" | "bloqueado" }[] = [];
  const pd = LAYOUT_INFO[b.layout].pluDigits;
  for (const r of b.records.filter((x) => !numbers || numbers.includes(x.number))) {
    const now = await client.readPlu(b.layout, r.number);
    if (now && sameAsBackup(r.raw, now.raw, b.layout)) {
      out.push({ number: r.number, verdict: "igual" });
      continue;
    }
    const reply = await client.writePluRaw(b.layout, r.number, writeDataFromRead(r.raw, b.layout, mode));
    if (reply === "bloqueado") {
      out.push({ number: r.number, verdict: "bloqueado" });
      continue;
    }
    const back = await client.readPlu(b.layout, r.number);
    out.push({ number: r.number, verdict: back && sameAsBackup(r.raw, back.raw, b.layout) ? "restaurado" : "no_restaurado" });
  }
  return out;
}
