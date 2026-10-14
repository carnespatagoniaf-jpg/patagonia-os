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
export function buildBarcodeRewrite(readRaw: string, layout: SystelLayout, newConfig: string): string | null {
  if (!/^[0-9PCIBS]{12}$/.test(newConfig)) return null;
  if (layout === "cuora2") return null;
  const pd = LAYOUT_INFO[layout].pluDigits;
  const ean = pluEanSetting(readRaw);
  if (ean.type === null || ean.config === null) return null;
  const end = readRaw[readRaw.length - 1] === "N" ? readRaw.length - 1 : readRaw.length - 101;
  const typeAt = end - 13;
  const typeChar = readRaw.charCodeAt(typeAt) <= 3 ? "\u0001" : "1";
  const updated = readRaw.slice(0, typeAt) + typeChar + newConfig + readRaw.slice(end);
  return updated.slice(0, pd) + updated.slice(pd + 1);
}

/** ¿El registro releído es igual al de antes salvo tipo + código propio + gestión? */
export function onlyBarcodeChanged(before: string, after: string, layout: SystelLayout): boolean {
  if (before.length !== after.length) return false;
  const pd = LAYOUT_INFO[layout].pluDigits;
  const end = before[before.length - 1] === "N" ? before.length - 1 : before.length - 101;
  const allowed = new Set<number>([pd]);
  for (let i = end - 13; i < end; i++) allowed.add(i);
  for (let i = 0; i < before.length; i++) if (!allowed.has(i) && before[i] !== after[i]) return false;
  return true;
}

export async function rewriteProductBarcode(client: SystelClient, layout: SystelLayout, number: number, saleType: string): Promise<BarcodeRewriteResult> {
  const base = { number, before: null as string | null, after: null as string | null };
  const target = targetCodeFor(saleType);
  if (!target) return { ...base, verdict: "no_soportado", ok: false, detail: `forma de venta "${saleType}" sin código definido` };
  const current = await client.readPlu(layout, number);
  if (!current) return { ...base, verdict: "sin_lectura", ok: false, detail: "no se pudo leer el producto; no se escribió nada" };
  const ean = pluEanSetting(current.raw);
  if (ean.type === 1 && ean.config === target) return { ...base, before: current.raw, after: current.raw, verdict: "ya_estaba", ok: true, detail: `ya tenía ${target}` };
  const data = buildBarcodeRewrite(current.raw, layout, target);
  if (!data) return { ...base, before: current.raw, verdict: "no_soportado", ok: false, detail: "el registro no tiene la forma esperada; no se escribió nada" };

  const reply = await client.writePluRaw(layout, number, data);
  if (reply === "bloqueado") return { ...base, before: current.raw, verdict: "bloqueado", ok: false, detail: "la escritura está bloqueada en Patagonia" };
  if (reply && reply.kind === "error") return { ...base, before: current.raw, verdict: "rechazado", ok: false, detail: `la balanza rechazó la escritura (${describeSystelError(reply.errorCode)}); no cambió nada` };

  const back = await client.readPlu(layout, number);
  if (!back) return { ...base, before: current.raw, verdict: "indeterminado", ok: false, detail: "se escribió pero no se pudo releer para comprobar" };
  const backEan = pluEanSetting(back.raw);
  const changedOk = backEan.type === 1 && backEan.config === target && onlyBarcodeChanged(current.raw, back.raw, layout);
  if (!onlyBarcodeChanged(current.raw, back.raw, layout)) {
    // Cambió algo más: se vuelve a escribir el registro ORIGINAL (sin la gestión) y se relee.
    const original = current.raw.slice(0, LAYOUT_INFO[layout].pluDigits) + current.raw.slice(LAYOUT_INFO[layout].pluDigits + 1);
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
  opts: { limit?: number; onProgress?: (t: string) => void } = {}
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
    const r = await rewriteProductBarcode(client, layout, p.number, p.saleType);
    results.push(r);
    if (!r.ok) return { backup, results, stoppedAt: p.number };
  }
  return { backup, results, stoppedAt: null };
}
