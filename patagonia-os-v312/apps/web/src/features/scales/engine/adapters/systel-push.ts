import type { SystelClient } from "../../../inventory/systel/systel-client";
import { toCuoraText } from "../../../inventory/systel/systel-frame";
import { LAYOUT_INFO, pluEanSetting, priceToRaw, type SystelLayout, type SystelPlu } from "../../../inventory/systel/systel-plu";
import { buildBarcodeRewrite, sameIgnoringLotePadding, targetCodeFor, writeDataFromRead } from "../../../inventory/systel/systel-product-barcode";
import { namesEquivalent } from "../matching";

/**
 * Patagonia → Systel: Patagonia es la única fuente. Cada producto activo va a la balanza con
 * número = código de Patagonia, su nombre, su precio, kilo o unidad, y su código de barras propio en el ticket
 * (producto + kilos o unidades). Lo que la balanza tiene y Patagonia no, NO se toca.
 *
 * Seguridad (igual que la escritura del código de barras, comprobada en Los gringos el 14/10):
 * - el registro se arma sobre lo que la balanza tiene HOY en ese número: solo cambian nombre, precio de la lista 1,
 *   código, forma de venta y código de barras; todo lo demás (lista 2, sector, vencimiento, nutrición, lote) igual;
 * - un número con OTRO producto no se pisa sin autorización;
 * - un producto sin precio en Patagonia no va (la balanza quedaría en $0);
 * - se relee cada uno y se compara; ante cualquier diferencia se vuelve a escribir lo que había y se frena.
 */

export interface PushProduct {
  id: string;
  code: string;
  name: string;
  byWeight: boolean;
  /** Pesos, como en Patagonia. */
  price: number;
}

export type PushAction = "crear" | "actualizar" | "reemplazar" | "sin_cambios" | "ocupado" | "omitir";

export interface PushItem {
  number: number | null;
  product: PushProduct;
  action: PushAction;
  reason: string;
  /** Lo que tiene hoy la balanza en ese número (lectura), o null. */
  current: string | null;
  /** Datos de la orden 61 (sin el carácter de gestión), o null si no se escribe. */
  data: string | null;
}

interface Offsets {
  pd: number;
  nameAt: number;
  pricesAt: number;
  codeAt: number;
  saleAt: number;
  tareAt: number;
}

function offsets(layout: SystelLayout): Offsets {
  const info = LAYOUT_INFO[layout];
  const pd = info.pluDigits;
  const nameAt = pd + 1;
  const pricesAt = nameAt + 18;
  const codeAt = pricesAt + info.priceLists * (layout === "max7" ? 12 : 6);
  const saleAt = codeAt + info.codeDigits + 2 + 4;
  return { pd, nameAt, pricesAt, codeAt, saleAt, tareAt: saleAt + 1 };
}

const put = (s: string, at: number, value: string) => s.slice(0, at) + value + s.slice(at + value.length);
const pad = (n: number, w: number) => String(n).padStart(w, "0");

/**
 * Cómo tiene que quedar el registro (en forma de lectura, con gestión) para este producto.
 * Producto nuevo: se arma sobre un producto que la balanza YA tiene (el modelo), igual que los productos de prueba
 * creados en la balanza real de Los gringos (14/10): otro número, nombre, precio (lista 2 en 0), código y forma de venta.
 */
export function desiredRead(layout: SystelLayout, number: number, product: PushProduct, priceRaw: number, current: string | null, template: string | null = null): string | null {
  const info = LAYOUT_INFO[layout];
  const o = offsets(layout);
  const saleType = product.byWeight ? "P" : "U";
  const base = current ?? template;
  if (!base) return null;
  let r = base;
  if (!current) {
    r = put(r, 0, pad(number, o.pd));
    r = put(r, o.pd, "1");
    r = put(r, o.pricesAt, "0".repeat(o.codeAt - o.pricesAt));
  }
  r = put(r, o.nameAt, toCuoraText(product.name, 18));
  r = put(r, o.pricesAt, pad(priceRaw, 6));
  r = put(r, o.codeAt, pad(number, info.codeDigits));
  r = put(r, o.saleAt, saleType);
  // Producto nuevo: sin la tara ni el vencimiento del producto que se usó de modelo.
  if (!product.byWeight || !current) r = put(r, o.tareAt, pad(0, info.tareDigits));
  if (!current) r = put(r, o.saleAt - 4, "0000");
  return r;
}

/** ¿Lo releído es lo esperado? Ignora la gestión, compara el tipo de código por su valor, y el relleno del lote. */
export function sameRecord(layout: SystelLayout, expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  const pd = LAYOUT_INFO[layout].pluDigits;
  const end = expected[expected.length - 1] === "N" ? expected.length - 1 : expected.length - 101;
  const typeAt = end - 13;
  for (let i = 0; i < expected.length; i++) {
    if (i === pd || i === typeAt) continue;
    if (!sameIgnoringLotePadding(expected[i], actual[i], i, end)) return false;
  }
  const a = pluEanSetting(expected);
  const b = pluEanSetting(actual);
  return a.type === b.type && a.config === b.config;
}

const withGestion = (layout: SystelLayout, data: string, g = "1") => data.slice(0, LAYOUT_INFO[layout].pluDigits) + g + data.slice(LAYOUT_INFO[layout].pluDigits);

export function planSystelPush(plus: SystelPlu[], layout: SystelLayout, priceDecimals: number, products: PushProduct[], opts: { replace?: boolean } = {}): PushItem[] {
  const info = LAYOUT_INFO[layout];
  const byNumber = new Map(plus.map((p) => [p.number, p]));
  const seen = new Map<number, string>();
  return products.map((product): PushItem => {
    const base = { product, current: null as string | null, data: null as string | null };
    const code = product.code.trim();
    const number = /^\d+$/.test(code) ? Number(code) : NaN;
    if (layout === "cuora2") return { ...base, number: null, action: "omitir", reason: "este modelo de Systel todavía no recibe productos" };
    if (!Number.isInteger(number) || number < 1 || number > Math.min(info.maxPlu, info.maxCode)) return { ...base, number: null, action: "omitir", reason: "su código no sirve como número de balanza" };
    if (seen.has(number)) return { ...base, number, action: "omitir", reason: `el código ${number} está repetido en Patagonia` };
    seen.set(number, product.id);
    const priceRaw = product.price > 0 ? priceToRaw(product.price, priceDecimals) : null;
    if (priceRaw === null || priceRaw <= 0) return { ...base, number, action: "omitir", reason: "no tiene precio en Patagonia" };
    const cur = byNumber.get(number) ?? null;
    const target = targetCodeFor(product.byWeight ? "P" : "U")!;
    const template = cur ? null : (plus.find((p) => (p.saleType === "P" || p.saleType === "C") === product.byWeight) ?? plus[0])?.raw ?? null;
    const read = desiredRead(layout, number, product, priceRaw, cur?.raw ?? null, template);
    const data = read ? buildBarcodeRewrite(read, layout, target, "ascii") : null;
    if (!data) return { ...base, number, current: cur?.raw ?? null, action: "omitir", reason: "el registro de la balanza no tiene la forma esperada" };
    if (!cur) return { ...base, number, data, action: "crear", reason: "nuevo en la balanza" };
    if (sameRecord(layout, withGestion(layout, data, cur.raw[info.pluDigits]), cur.raw)) return { ...base, number, current: cur.raw, action: "sin_cambios", reason: "ya está igual" };
    if (!namesEquivalent(cur.name, product.name)) {
      return opts.replace
        ? { ...base, number, current: cur.raw, data, action: "reemplazar", reason: `en la balanza era "${cur.name.trim()}"` }
        : { ...base, number, current: cur.raw, action: "ocupado", reason: `en la balanza el ${number} es "${cur.name.trim()}"` };
    }
    return { ...base, number, current: cur.raw, data, action: "actualizar", reason: "cambia precio, nombre, forma de venta o código" };
  });
}

/** Productos de la balanza que Patagonia no tiene (no se tocan; solo se informan). */
export function scaleOnly(plus: SystelPlu[], products: PushProduct[]): SystelPlu[] {
  const codes = new Set(products.map((p) => p.code.trim()));
  return plus.filter((p) => !codes.has(String(p.number)));
}

export interface PushResult {
  done: { number: number; action: PushAction }[];
  stoppedAt: number | null;
  detail: string;
  restored: boolean | null;
}

export async function runSystelPush(client: SystelClient, layout: SystelLayout, plan: PushItem[], onProgress: (done: number, total: number) => void = () => {}): Promise<PushResult> {
  const todo = plan.filter((x) => x.data && x.number !== null && (x.action === "crear" || x.action === "actualizar" || x.action === "reemplazar"));
  const done: PushResult["done"] = [];
  for (const [i, item] of todo.entries()) {
    onProgress(i + 1, todo.length);
    const n = item.number!;
    // Justo antes de escribir: la balanza tiene que seguir como cuando se leyó (si alguien la cambió, se frena).
    const fresh = await client.readPlu(layout, n);
    const freshRaw = fresh?.raw ?? null;
    if (item.current === null ? freshRaw !== null : !freshRaw || !sameRecord(layout, item.current, freshRaw)) {
      return { done, stoppedAt: n, detail: "la balanza cambió desde que se leyó: no se escribió", restored: null };
    }
    const reply = await client.writeProductRecord(layout, n, item.data!);
    if (reply === "bloqueado") return { done, stoppedAt: n, detail: "escritura bloqueada", restored: null };
    if (reply && reply.kind === "error") return { done, stoppedAt: n, detail: `la balanza rechazó el producto ${n} (${reply.errorCode}); no cambió nada`, restored: null };
    const back = await client.readPlu(layout, n);
    const ok = !!back && sameRecord(layout, withGestion(layout, item.data!, back.raw[LAYOUT_INFO[layout].pluDigits]), back.raw);
    if (ok && reply && reply.kind === "ack") {
      done.push({ number: n, action: item.action });
      continue;
    }
    // Diferencia o sin confirmación: si había algo, se vuelve a escribir tal cual estaba y se comprueba.
    let restored: boolean | null = null;
    if (item.current) {
      await client.writeProductRecord(layout, n, writeDataFromRead(item.current, layout, "ascii"));
      const again = await client.readPlu(layout, n);
      restored = !!again && sameRecord(layout, item.current, again.raw);
    }
    return { done, stoppedAt: n, detail: !back ? "no se pudo releer el producto" : ok ? "la balanza no confirmó la escritura" : "lo releído no es lo que se mandó", restored };
  }
  return { done, stoppedAt: null, detail: "", restored: null };
}
