import type { SystelBackup } from "./systel-backup";
import type { SystelClient, WriteOutcome } from "./systel-client";
import { toCuoraText } from "./systel-frame";
import { LAYOUT_INFO, priceToRaw, rawToPesos, type SystelLayout, type SystelPlu } from "./systel-plu";

/**
 * Plan y envío de productos de Patagonia a una Cuora. Reglas:
 * - El número de PLU (y el código de barras) es el código del producto en Patagonia.
 * - Si el PLU ya está en la balanza con ESE código y el mismo tipo: se cambia solo
 *   el precio (función 33, conserva todo lo demás).
 * - Si está con otro código o con otro tipo: "revisar", no se toca.
 * - Si no está: se crea (función 61/4), por kilo (P) o por unidad (U).
 * - Nunca se borra nada. Se frena ante la primera diferencia.
 * - Sin precio en Patagonia (0): no se manda; la balanza conserva el suyo (real: Los gringos tenía
 *   102 de 103 productos en $0, 2026-10-09).
 * - Mismo número pero OTRO producto (el nombre no se parece): "revisar", no se toca. Si no, un
 *   "5 = Pata muslo" de Patagonia le cambiaba el precio al "5 = Pollo entero" de la balanza.
 * - Se crean primero los nuevos (números libres, no arriesgan nada) y después se cambian precios.
 */

/** "Pata Muslo x kg" ≈ "PATA MUSLO": mayúsculas, sin acentos ni signos, y se parecen si uno contiene al otro o comparten la primera palabra. */
export function namesLookAlike(a: string, b: string): boolean {
  const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return x.split(" ")[0] === y.split(" ")[0];
}

export interface SystelProductInput {
  code: string;
  name: string;
  byWeight: boolean;
  /** Pesos, como en Patagonia. */
  price: number;
}

export type SystelPlanAction = "actualizar" | "crear" | "sin_cambios" | "revisar" | "omitir";

export interface SystelPlanItem {
  number: number | null;
  name: string;
  action: SystelPlanAction;
  reason: string;
  priceRaw: number | null;
  byWeight: boolean;
  current: SystelPlu | null;
}

export function planSystelSync(backup: SystelBackup, products: SystelProductInput[]): SystelPlanItem[] {
  const layout = backup.layout;
  const decimals = backup.signature?.priceDecimals;
  const byNumber = new Map(backup.plus.map((p) => [p.number, p]));
  return products.map((p) => {
    const base = { name: p.name, byWeight: p.byWeight, current: null as SystelPlu | null };
    if (!layout) return { ...base, number: null, action: "omitir" as const, reason: "no se reconoció el formato de esta balanza", priceRaw: null };
    if (decimals !== 0 && decimals !== 2) return { ...base, number: null, action: "omitir" as const, reason: "la balanza no informó cuántos decimales usa en el precio", priceRaw: null };
    const info = LAYOUT_INFO[layout];
    const number = /^\d+$/.test(p.code.trim()) ? Number(p.code.trim()) : NaN;
    if (!Number.isInteger(number) || number < 1 || number > Math.min(info.maxPlu, info.maxCode)) {
      return { ...base, number: null, action: "omitir" as const, reason: `el código "${p.code}" no es un número de 1 a ${Math.min(info.maxPlu, info.maxCode)}`, priceRaw: null };
    }
    if (!(p.price > 0)) {
      return { ...base, number, action: "omitir" as const, reason: "no tiene precio en Patagonia: en la balanza queda el que tiene", priceRaw: null };
    }
    const priceRaw = priceToRaw(p.price, decimals);
    if (priceRaw === null) {
      const max = decimals === 2 ? "$9.999,99" : "$999.999";
      return { ...base, number, action: "omitir" as const, reason: `precio fuera de lo que admite la balanza (máximo ${max})`, priceRaw: null };
    }
    if (backup.unreadable.includes(number)) return { ...base, number, action: "revisar" as const, reason: "ese PLU no se pudo leer en el respaldo", priceRaw };
    const current = byNumber.get(number) ?? null;
    if (!current) return { ...base, number, action: "crear" as const, reason: p.byWeight ? "nuevo, por kilo" : "nuevo, por unidad", priceRaw };
    const wantType = p.byWeight ? "P" : "U";
    if (current.code !== number) return { ...base, current, number, action: "revisar" as const, reason: `en la balanza el PLU ${number} tiene otro código de barras (${current.code}); no se toca`, priceRaw };
    if (!namesLookAlike(current.name, p.name)) {
      return { ...base, current, number, action: "revisar" as const, reason: `en la balanza el ${number} es "${current.name.trim()}" y en Patagonia "${p.name}": parecen productos distintos; no se toca`, priceRaw };
    }
    const typeOk = wantType === "P" ? current.saleType !== "U" : current.saleType === "U";
    if (!typeOk) return { ...base, current, number, action: "revisar" as const, reason: `en la balanza es "${current.name.trim()}" ${current.saleType === "U" ? "por unidad" : "por kilo"} y en Patagonia ${p.byWeight ? "por kilo" : "por unidad"}; no se toca`, priceRaw };
    if (current.prices[0] === priceRaw) return { ...base, current, number, action: "sin_cambios" as const, reason: "ya tiene ese precio", priceRaw };
    const nameNote = current.name !== toCuoraText(p.name, 18) ? ` (en la balanza se llama "${current.name.trim()}"; el nombre no se cambia)` : "";
    return {
      ...base,
      current,
      number,
      action: "actualizar" as const,
      reason: `precio ${rawToPesos(current.prices[0], decimals)} → ${p.price}, conserva código, tipo y lo demás${nameNote}`,
      priceRaw
    };
  });
}

export interface SystelSyncItemResult {
  number: number;
  action: "actualizar" | "crear";
  outcome: WriteOutcome;
}

export interface SystelSyncResult {
  done: SystelSyncItemResult[];
  stoppedAt: SystelSyncItemResult | null;
  pending: number;
}

/**
 * Manda el plan de a uno. Antes de cada cambio de precio relee el PLU (si cambió
 * desde el respaldo, frena). Después de cada escritura compara la relectura.
 * Se frena en el primer problema; lo ya confirmado queda confirmado, y volver a
 * planificar desde un respaldo nuevo retoma lo que falta sin repetir nada.
 */
export async function runSystelSync(client: SystelClient, layout: SystelLayout, plan: SystelPlanItem[], onProgress: (text: string) => void = () => {}): Promise<SystelSyncResult> {
  const work = plan
    .filter((p) => (p.action === "actualizar" || p.action === "crear") && p.number !== null && p.priceRaw !== null)
    // Primero los nuevos (números libres): si algo del protocolo no anda, frena sin haber tocado un producto existente.
    .sort((a, b) => Number(a.action === "actualizar") - Number(b.action === "actualizar"));
  const list = await client.list();
  if (!list) {
    return { done: [], stoppedAt: { number: 0, action: "actualizar", outcome: { ok: false, verdict: "sin_relectura", detail: "no se pudo leer la lista de productos antes de empezar", readBack: null, diff: [] } }, pending: work.length };
  }
  const known = new Set(list.entries.map((e) => e.number));
  const done: SystelSyncItemResult[] = [];
  for (const [i, item] of work.entries()) {
    onProgress(`Enviando ${i + 1} de ${work.length} (PLU ${item.number})…`);
    let outcome: WriteOutcome;
    if (item.action === "actualizar") {
      const fresh = await client.readPlu(layout, item.number!);
      if (!fresh) outcome = { ok: false, verdict: "sin_relectura", detail: `no se pudo leer el PLU ${item.number} antes de cambiarle el precio`, readBack: null, diff: [] };
      else if (item.current && fresh.raw !== item.current.raw) outcome = { ok: false, verdict: "diferencia", detail: `el PLU ${item.number} cambió en la balanza desde el respaldo: hacé un respaldo nuevo`, readBack: fresh, diff: [] };
      else outcome = await client.changePrice(fresh, item.priceRaw!);
    } else {
      outcome = await client.createPlu(layout, { number: item.number!, name: item.name, code: item.number!, saleType: item.byWeight ? "P" : "U", priceRaw: item.priceRaw! }, known);
      if (outcome.ok) known.add(item.number!);
    }
    const result = { number: item.number!, action: item.action as "actualizar" | "crear", outcome };
    if (!outcome.ok) return { done, stoppedAt: result, pending: work.length - i - 1 };
    done.push(result);
  }
  return { done, stoppedAt: null, pending: 0 };
}
