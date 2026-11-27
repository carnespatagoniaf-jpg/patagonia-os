import type { SystelClient } from "../../../inventory/systel/systel-client";
import { toCuoraText } from "../../../inventory/systel/systel-frame";
import { emptyPluTail, LAYOUT_INFO, pluEanSetting, priceToRaw, type SystelLayout, type SystelPlu } from "../../../inventory/systel/systel-plu";
import { buildBarcodeRewrite, sameIgnoringLotePadding, targetCodeFor, writeDataFromRead, type TypeByteMode } from "../../../inventory/systel/systel-product-barcode";
import { namesEquivalent } from "../matching";

/**
 * Patagonia → Systel: Patagonia es la única fuente. Cada producto activo va a la balanza con
 * número = código de Patagonia, su nombre, su precio, kilo o unidad, y su código de barras propio en el ticket
 * (producto + kilos o unidades). Lo que la balanza tiene y Patagonia no, NO se toca.
 *
 * Seguridad (igual que la escritura del código de barras, comprobada en Los gringos el 14/10):
 * - el registro se arma sobre lo que la balanza tiene HOY en ese número: solo cambian nombre, precio de la lista 1,
 *   código, forma de venta, código de barras y vencimiento (siempre 0: no se imprime); todo lo demás (lista 2, sector,
 *   nutrición, lote) igual;
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
 * La información extra de un producto (después de la tara) en blanco, como en un producto nuevo: agua, nutrición,
 * origen, conservación, receta y lote vacíos, sin ingredientes. El código de barras propio (tipo + configuración) se
 * deja: lo arma después `buildBarcodeRewrite`. Cuora 2: después de la tara solo están los ingredientes.
 */
function blankExtras(layout: SystelLayout, r: string, tailAt: number): string {
  const info = LAYOUT_INFO[layout];
  if (layout === "cuora2") return r.slice(0, tailAt) + "N";
  const typeAt = tailAt + info.tailFixed - 14;
  return r.slice(0, tailAt) + emptyPluTail(layout).slice(0, info.tailFixed - 14) + r.slice(typeAt, typeAt + 13) + "N";
}

/**
 * Cómo tiene que quedar el registro (en forma de lectura, con gestión) para este producto.
 * Producto nuevo: se arma sobre un producto que la balanza YA tiene (el modelo), igual que los productos de prueba
 * creados en la balanza real de Los gringos (14/10): otro número, nombre, precio (lista 2 en 0), código y forma de venta.
 * `fresh` (producto nuevo, o un número que tenía OTRO producto y se reemplaza): todas las listas menos la 1 en 0, sin
 * tara y sin la información extra del registro anterior (C10). El mismo producto con otro precio conserva todo.
 */
export function desiredRead(layout: SystelLayout, number: number, product: PushProduct, priceRaw: number, current: string | null, template: string | null = null, fresh = !current): string | null {
  const info = LAYOUT_INFO[layout];
  const o = offsets(layout);
  const saleType = product.byWeight ? "P" : "U";
  const base = current ?? template;
  if (!base) return null;
  let r = base;
  if (!current) {
    r = put(r, 0, pad(number, o.pd));
    r = put(r, o.pd, "1");
  }
  if (fresh) {
    r = put(r, o.pricesAt, "0".repeat(o.codeAt - o.pricesAt));
    r = blankExtras(layout, r, o.tareAt + info.tareDigits);
  }
  r = put(r, o.nameAt, toCuoraText(product.name, 18));
  r = put(r, o.pricesAt, pad(priceRaw, 6));
  r = put(r, o.codeAt, pad(number, info.codeDigits));
  r = put(r, o.saleAt, saleType);
  // Producto nuevo o reemplazado: sin la tara del producto anterior o del modelo.
  if (!product.byWeight || fresh) r = put(r, o.tareAt, pad(0, info.tareDigits));
  // Nunca vencimiento en la etiqueta (dueño 2026-11-19, Carnes premium): 0 días = no lo imprime. También en los que ya estaban.
  r = put(r, o.saleAt - 4, "0000");
  return r;
}

/** ¿Lo releído es lo esperado? Ignora la gestión, compara el tipo de código por su valor, y el relleno del lote. */
export function sameRecord(layout: SystelLayout, expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  // Cuora 2: sin código de barras por producto ni lote; todo igual salvo la versión (quién lo gestionó).
  if (layout === "cuora2") return [...expected].every((c, i) => i === LAYOUT_INFO.cuora2.pluDigits || c === actual[i]);
  const pd = LAYOUT_INFO[layout].pluDigits;
  const end = expected[expected.length - 1] === "N" ? expected.length - 1 : expected.length - 101;
  const typeAt = end - 13;
  const loteFrom = end - 25;
  // REAL (El Dorado 29/10, Cuora Max firmware 7.0): un lote mandado en blanco ("            ") se relee como
  // " 00000000000". Lote vacío = solo espacios, ceros o 0x00, en cualquier combinación: es el mismo "sin lote".
  const emptyLote = (s: string) => /^[ 0\u0000]{12}$/.test(s.slice(loteFrom, typeAt));
  const skipLote = emptyLote(expected) && emptyLote(actual);
  for (let i = 0; i < expected.length; i++) {
    if (i === pd || i === typeAt) continue;
    if (skipLote && i >= loteFrom && i < typeAt) continue;
    if (!sameIgnoringLotePadding(expected[i], actual[i], i, end)) return false;
  }
  const a = pluEanSetting(expected);
  const b = pluEanSetting(actual);
  return a.type === b.type && a.config === b.config;
}

const withGestion = (layout: SystelLayout, data: string, g = "1") => data.slice(0, LAYOUT_INFO[layout].pluDigits) + g + data.slice(LAYOUT_INFO[layout].pluDigits);

/**
 * Cuora 2 (protocolo oficial V4.0, Rev 03/Dic/2010, págs. 7-8). Lectura (función 3) y escritura (función 4) tienen los
 * mismos campos hasta la tara: PLU 4 + versión 1 + nombre 18 + 2 precios de 6 + código 5 + sección 2 + vencimiento 4 +
 * tipo 1 + tara 6 = 53. La escritura agrega ahí "Mantener totales": "N" pone en cero los totales de venta de ese PLU,
 * "M" los conserva (N solo para un PLU nuevo, o si cambia unitario/pesable, el número o el código). Después, en las
 * dos, "Ingredientes S/N" y, con S, 100 letras. La versión va "1" = gestionado desde la PC (función 31, pág. 13).
 * A diferencia de la Cuora Max, la escritura LLEVA la versión.
 */
export const CUORA2_FIXED = 53;

export function cuora2WriteData(read: string, keepTotals: boolean): string {
  return read.slice(0, 4) + "1" + read.slice(5, CUORA2_FIXED) + (keepTotals ? "M" : "N") + read.slice(CUORA2_FIXED);
}

/** Cómo se relee lo que se mandó; `version`: la letra que devuelve la balanza (no se compara). */
function expectedRead(layout: SystelLayout, data: string, version: string): string {
  if (layout !== "cuora2") return withGestion(layout, data, version);
  const read = data.slice(0, CUORA2_FIXED) + data.slice(CUORA2_FIXED + 1);
  return read.slice(0, 4) + version + read.slice(5);
}

/** Datos para volver a escribir tal cual un registro leído (restauración, sin borrar totales en la Cuora 2). */
function restoreData(layout: SystelLayout, read: string, mode: TypeByteMode): string {
  return layout === "cuora2" ? cuora2WriteData(read, true) : writeDataFromRead(read, layout, mode);
}

/** `templates`: modelos para armar productos nuevos cuando la balanza no tiene ninguno (systel-empty-template.ts). */
/** `ticketCodes` ('balanzas_v2'): el código propio de ESTA balanza (su inicio); sin esto, 20PPPPCCCCCC / 21PPPPCCCCCC. */
export function planSystelPush(plus: SystelPlu[], layout: SystelLayout, priceDecimals: number, products: PushProduct[], opts: { replace?: boolean; mode?: TypeByteMode; templates?: SystelPlu[]; pluCapacity?: number; ticketCodes?: { weighed: string; unit: string } } = {}): PushItem[] {
  const info = LAYOUT_INFO[layout];
  // El número más alto que acepta ESTA balanza (topPluNumber en systel.ts: firma "P08000" de una Max 6.0); 0 = el del formato.
  const top = Math.min(info.maxPlu, info.maxCode, (opts.pluCapacity ?? 0) > 0 ? opts.pluCapacity! : Infinity);
  const byNumber = new Map(plus.map((p) => [p.number, p]));
  const models = plus.length > 0 ? plus : (opts.templates ?? []);
  const seen = new Map<number, string>();
  return products.map((product): PushItem => {
    const base = { product, current: null as string | null, data: null as string | null };
    const code = product.code.trim();
    const number = /^\d+$/.test(code) ? Number(code) : NaN;
    if (Number.isInteger(number) && number > top) return { ...base, number: null, action: "omitir", reason: `su código (${number}) es más alto que ${top.toLocaleString("es-AR")}, el último número que acepta esta balanza: cambiale el código en Stock por uno libre de 1 a ${top.toLocaleString("es-AR")}` };
    if (!Number.isInteger(number) || number < 1) return { ...base, number: null, action: "omitir", reason: "su código no sirve como número de balanza" };
    if (seen.has(number)) return { ...base, number, action: "omitir", reason: `el código ${number} está repetido en Patagonia` };
    seen.set(number, product.id);
    if (!(product.price > 0)) return { ...base, number, action: "omitir", reason: "no tiene precio en Patagonia" };
    // Nunca se redondea: la etiqueta cobraría distinto que Patagonia (auditoría 28/10).
    if (priceDecimals === 0 && Math.round(product.price * 100) % 100 !== 0) {
      return { ...base, number, action: "omitir", reason: "tiene centavos y esta balanza trabaja sin centavos: redondeá el precio en Patagonia" };
    }
    const priceRaw = priceToRaw(product.price, priceDecimals);
    if (priceRaw === null || priceRaw <= 0) {
      return { ...base, number, action: "omitir", reason: `precio fuera de lo que admite la balanza (máximo ${priceDecimals === 2 ? "$9.999,99" : "$999.999"})` };
    }
    const cur = byNumber.get(number) ?? null;
    const target = opts.ticketCodes ? (product.byWeight ? opts.ticketCodes.weighed : opts.ticketCodes.unit) : targetCodeFor(product.byWeight ? "P" : "U")!;
    const template = cur ? null : (models.find((p) => (p.saleType === "P" || p.saleType === "C") === product.byWeight) ?? models[0])?.raw ?? null;
    const fresh = !cur || !namesEquivalent(cur.name, product.name);
    const read = desiredRead(layout, number, product, priceRaw, cur?.raw ?? null, template, fresh);
    let data: string | null;
    if (layout === "cuora2") {
      // Sin código de barras por producto: la etiqueta sale con el formato general de la balanza (el código es el número).
      // Un producto nuevo o reemplazado no se queda con los ingredientes del registro que se usó de base.
      const same = !!cur && namesEquivalent(cur.name, product.name);
      const r = read && read.length > CUORA2_FIXED ? (same ? read : read.slice(0, CUORA2_FIXED) + "N") : null;
      const keepTotals = same && cur!.saleType === (product.byWeight ? "P" : "U") && cur!.code === number;
      data = r ? cuora2WriteData(r, keepTotals) : null;
    } else data = read ? buildBarcodeRewrite(read, layout, target, opts.mode ?? "ascii") : null;
    if (!data) return { ...base, number, current: cur?.raw ?? null, action: "omitir", reason: "el registro de la balanza no tiene la forma esperada" };
    if (!cur) return { ...base, number, data, action: "crear", reason: "nuevo en la balanza" };
    if (sameRecord(layout, expectedRead(layout, data, cur.raw[info.pluDigits]), cur.raw)) return { ...base, number, current: cur.raw, action: "sin_cambios", reason: "ya está igual" };
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
  /** La balanza contestó con un error a la escritura (no cambió nada): su código (E5, E8…). */
  rejected?: string;
}

/**
 * Reintentos de una escritura que la balanza no hizo: E1 (llegó mal por el cable), E2 (buffer lleno), E3 (no atendió),
 * o sin respuesta. Antes de cada uno se relee el producto: solo se reintenta si sigue exactamente como estaba.
 */
const WRITE_RETRY_ERRORS = new Set(["E1", "E2", "E3"]);
export const WRITE_RETRY_MS = [300, 1000, 2500];

export async function runSystelPush(client: SystelClient, layout: SystelLayout, plan: PushItem[], onProgress: (done: number, total: number) => void = () => {}, mode: TypeByteMode = "ascii"): Promise<PushResult> {
  const todo = plan.filter((x) => x.data && x.number !== null && (x.action === "crear" || x.action === "actualizar" || x.action === "reemplazar"));
  const done: PushResult["done"] = [];
  for (const [i, item] of todo.entries()) {
    onProgress(i + 1, todo.length);
    const n = item.number!;
    const isOriginal = (raw: string | null) => (item.current === null ? raw === null : !!raw && sameRecord(layout, item.current, raw));
    let reply: Awaited<ReturnType<SystelClient["writeProductRecord"]>> = null;
    let back: SystelPlu | null = null;
    let ok = false;
    for (let attempt = 0; ; attempt++) {
      // Justo antes de escribir (y antes de cada reintento): la balanza tiene que seguir como cuando se leyó.
      // Solo E7 ("no existe") cuenta como número libre: un error o el silencio no dicen nada, y ahí no se escribe (C9).
      const status = await client.readPluStatus(layout, n);
      if ("error" in status) {
        return { done, stoppedAt: n, detail: `no se pudo leer el producto ${n} antes de escribirlo (${status.error}): no se escribió`, restored: null };
      }
      const fresh = "plu" in status ? status.plu : null;
      if (!isOriginal(fresh?.raw ?? null)) {
        return { done, stoppedAt: n, detail: attempt === 0 ? "la balanza cambió desde que se leyó: no se escribió" : "después de un intento fallido la balanza no quedó como estaba: no se reintentó", restored: null };
      }
      reply = await client.writeProductRecord(layout, n, item.data!);
      if (reply === "bloqueado") return { done, stoppedAt: n, detail: "escritura bloqueada", restored: null };
      const transient = reply === null || (reply.kind === "error" && WRITE_RETRY_ERRORS.has(reply.errorCode ?? ""));
      if (reply && reply.kind === "error" && (!transient || attempt >= WRITE_RETRY_MS.length)) {
        return { done, stoppedAt: n, detail: `la balanza rechazó el producto ${n} (${reply.errorCode}); no cambió nada`, restored: null, rejected: reply.errorCode ?? "error" };
      }
      const backStatus = reply && reply.kind === "error" ? null : await client.readPluStatus(layout, n);
      back = backStatus && "plu" in backStatus ? backStatus.plu : null;
      ok = !!back && sameRecord(layout, expectedRead(layout, item.data!, back.raw[LAYOUT_INFO[layout].pluDigits]), back.raw);
      // Releído igual a lo mandado: quedó bien, aunque la confirmación (ACK) se haya perdido en el cable.
      if (ok) break;
      // Rechazo pasajero (E1/E2/E3: "no guardé nada") o sin respuesta y la balanza sigue como estaba: se vuelve a mandar.
      // REAL Quesar 17/11: E1 en el producto 163 de 241; al repetir todo a mano, pasó entero.
      // Una relectura que no contestó no prueba que siga como estaba (un producto nuevo daría "libre" sin serlo).
      const untouched = reply !== null && reply.kind === "error" ? true : !!backStatus && !("error" in backStatus) && isOriginal(back?.raw ?? null);
      if (!(transient && untouched && attempt < WRITE_RETRY_MS.length)) break;
      await new Promise((r) => setTimeout(r, WRITE_RETRY_MS[attempt]));
      await client.wake();
    }
    if (ok) {
      done.push({ number: n, action: item.action });
      continue;
    }
    // Diferencia o sin confirmación: si había algo, se vuelve a escribir tal cual estaba y se comprueba.
    let restored: boolean | null = null;
    if (item.current) {
      await client.writeProductRecord(layout, n, restoreData(layout, item.current, mode));
      const again = await client.readPlu(layout, n);
      restored = !!again && sameRecord(layout, item.current, again.raw);
    }
    return { done, stoppedAt: n, detail: !back ? "no se pudo releer el producto" : isOriginal(back.raw) ? "la balanza no guardó el producto después de varios intentos" : "lo releído no es lo que se mandó", restored };
  }
  return { done, stoppedAt: null, detail: "", restored: null };
}

/** Nombre del producto de prueba (queda en la balanza: Patagonia no borra nada; el cliente lo puede borrar en la balanza). */
export const PROOF_NAME = "PRUEBA PATAGONIA";

export interface WriteProofResult {
  ok: boolean;
  /** Número de la balanza donde se hizo la prueba (uno libre, o el producto de prueba de una vez anterior). */
  number: number | null;
  /** Cómo aceptó la balanza el tipo de código de barras ("ascii" = el dígito, "binario" = el byte). */
  mode: TypeByteMode | null;
  detail: string;
  tries: { mode: TypeByteMode; detail: string }[];
}

/**
 * Prueba de escritura en ESTA balanza antes de tocar un producto del cliente. Para los formatos de Cuora Max que se
 * leyeron bien en una balanza real pero cuya escritura todavía no se comprobó en una real (firmware 6.2 y 7.0): se
 * escribe un producto de prueba en un número LIBRE (o sobre el de prueba de una vez anterior), con el mismo armado que
 * el envío de verdad (sobre el registro de un producto que la balanza ya tiene, función 61), se relee y se compara completo.
 * - Si la balanza rechaza la escritura (no cambió nada), se prueba la otra forma del tipo de código (dígito o byte).
 * - Si la acepta pero lo releído no coincide, se frena: ningún producto del cliente se tocó.
 */
export async function proveSystelWrite(client: SystelClient, layout: SystelLayout, plus: SystelPlu[], priceDecimals: number, pluCapacity: number): Promise<WriteProofResult> {
  const info = LAYOUT_INFO[layout];
  const previous = plus.find((p) => p.name.trim() === PROOF_NAME) ?? null;
  let number = previous?.number ?? null;
  if (number === null) {
    const used = new Set(plus.map((p) => p.number));
    const top = Math.min(pluCapacity > 0 ? pluCapacity : info.maxPlu, info.maxPlu, info.maxCode);
    for (let n = top; n >= 1 && number === null; n--) if (!used.has(n)) number = n;
  }
  const out: WriteProofResult = { ok: false, number, mode: null, detail: "", tries: [] };
  if (number === null) return { ...out, detail: "la balanza no tiene un número libre para la prueba" };
  // Siempre un cambio real (si la prueba anterior quedó en $1, ahora $2), para que haya una escritura que comprobar.
  const pesos = previous && previous.prices[0] === priceToRaw(1, priceDecimals) ? 2 : 1;
  const product: PushProduct = { id: "prueba-patagonia", code: String(number), name: PROOF_NAME, byWeight: true, price: pesos };
  // La Cuora 2 no tiene byte de tipo de código: una sola forma.
  for (const mode of (layout === "cuora2" ? ["ascii"] : ["ascii", "binario"]) as TypeByteMode[]) {
    const plan = planSystelPush(plus, layout, priceDecimals, [product], { replace: true, mode });
    const item = plan[0];
    if (!item?.data) return { ...out, detail: `no se pudo armar el producto de prueba (${item?.reason ?? "sin plan"})` };
    const r = await runSystelPush(client, layout, plan, () => {}, mode);
    out.tries.push({ mode, detail: r.stoppedAt === null ? "releído igual" : r.detail });
    if (r.stoppedAt === null && r.done.length === 1) return { ...out, ok: true, mode, detail: `producto de prueba ${number} escrito y releído igual` };
    // Solo un rechazo deja la balanza como estaba: ahí sí se prueba la otra forma. Cualquier otra cosa frena.
    if (!r.rejected) return { ...out, detail: r.detail };
  }
  return { ...out, detail: `la balanza rechazó el producto de prueba de las dos formas (${out.tries.map((t) => t.detail).join(" / ")})` };
}

/** Nombre del sector que crea Patagonia cuando falta (la balanza no lo imprime en la etiqueta). */
export const SECTOR_NAME = "GENERAL";

/**
 * Balanza VACÍA: los productos nuevos se arman con el sector de los modelos (systel-empty-template.ts). Si alguien borró
 * los sectores en la balanza, cada producto da E7 (real Los gringos 13/11). Lee los sectores (11), crea solo los que faltan
 * (10, nunca uno que ya está: la 10 también le cambia el nombre) y relee. Si la 11 no se puede leer, no escribe nada y
 * frena (C16): sin saber qué sectores hay no se dan por buenos.
 */
export async function ensureSystelSectors(client: SystelClient, needed: number[]): Promise<{ ok: boolean; created: number[]; detail: string }> {
  const want = [...new Set(needed)].filter((n) => Number.isInteger(n) && n >= 1 && n <= 99);
  if (want.length === 0) return { ok: true, created: [], detail: "sin sectores para revisar" };
  const before = await client.sectors();
  if (!before) return { ok: false, created: [], detail: "no se pudo leer la lista de sectores (función 11): no se creó ninguno ni se mandó ningún producto" };
  const missing = want.filter((n) => !before.some((s) => s.number === n));
  if (missing.length === 0) return { ok: true, created: [], detail: `la balanza ya tiene el sector ${want.join(", ")}` };
  for (const n of missing) {
    const r = await client.writeSector(n, SECTOR_NAME);
    if (r === "bloqueado") return { ok: false, created: [], detail: "crear sectores está bloqueado en esta conexión" };
    if (!r || r.kind !== "ack") return { ok: false, created: [], detail: `la balanza no aceptó crear el sector ${n} (${!r ? "sin respuesta" : r.data})` };
  }
  const after = await client.sectors();
  const still = after ? missing.filter((n) => !after.some((s) => s.number === n)) : missing;
  if (still.length > 0) return { ok: false, created: [], detail: `después de crearlo, el sector ${still.join(", ")} no aparece en la balanza` };
  return { ok: true, created: missing, detail: `sector ${missing.join(", ")} creado y releído` };
}
