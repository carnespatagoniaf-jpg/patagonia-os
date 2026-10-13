import type { Product } from "@patagonia/domain";

/**
 * Detalle de un ticket de una Systel Cuora Max leído de la propia balanza: función 72, "Reporte de
 * ventas" (SOLO LECTURA). DOCUMENTADO, igual en V6.0 (pág. 33), V6.2 (pág. 33) y V7 (págs. 30-31):
 *
 * Pedido: día, mes y año de inicio + día, mes y año de fin, 2 números cada uno ("131026131026").
 * Respuesta: por cada artículo vendido, separados por "^" (0x5E):
 *   Ticket Id (9) ^ fecha "dd/mm/aa" (8) ^ hora "hh:mm:ss" (8) ^ vendedor (2) ^ N.º de PLU (6) ^
 *   sector (2) ^ unidades (4, solo unitarios) ^ gramos (5, pesables/congelados) ^ drenado (5) ^
 *   importe (12, × 100)
 * y al final la letra "F". El documento dice que esos campos "pueden repetirse" pero no muestra si
 * entre un artículo y el siguiente hay otro "^": se aceptan las dos formas.
 *
 * Por qué (real, Los gringos 13/10, op. 20-3095): el ticket trae un solo código de barras, el del
 * TOTAL ($73.118, 2 artículos), y debajo de cada artículo un código en ceros. El detalle (cajón 1 un
 * + trozadito 0,215 kg) está en la memoria de la balanza: se lee de ahí, no se calcula.
 *
 * NUNCA probado contra una balanza real: el formato sale del documento. Por eso todo lo que no encaje
 * exactamente con ese formato se rechaza (no se "adivina") y se manda a soporte tal cual llegó.
 */

export interface SystelSaleLine {
  ticketId: string;
  date: string; // "dd/mm/aa"
  time: string; // "hh:mm:ss"
  seller: string;
  plu: number;
  sector: string;
  units: number;
  grams: number;
  drained: number;
  /** Importe en pesos (el campo viene × 100). */
  amount: number;
}

export interface SystelSalesReport {
  ok: boolean;
  lines: SystelSaleLine[];
  /** Por qué no se pudo usar (formato que no coincide con el documento). */
  problem: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Datos del pedido de la función 72 para un día (o un rango). */
export function salesReportRequest(from: Date, to: Date = from): string {
  const part = (d: Date) => `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${pad2(d.getFullYear() % 100)}`;
  return part(from) + part(to);
}

// Un artículo, con los anchos del documento. El "^" después del importe es opcional (ver arriba).
const LINE = /(\d{9})\^(\d\d\/\d\d\/\d\d)\^(\d\d:\d\d:\d\d)\^(\d{2})\^(\d{6})\^(\d{2})\^(\d{4})\^(\d{5})\^(\d{5})\^(\d{12})\^?/y;

/** Interpreta los datos de la respuesta (sin dirección, función ni verificación). */
export function parseSalesReport(data: string): SystelSalesReport {
  if (!data.endsWith("F")) return { ok: false, lines: [], problem: `la respuesta no termina en "F" (${data.length} caracteres): está incompleta o tiene otro formato` };
  const body = data.slice(0, -1);
  const lines: SystelSaleLine[] = [];
  LINE.lastIndex = 0;
  let pos = 0;
  while (pos < body.length) {
    LINE.lastIndex = pos;
    const m = LINE.exec(body);
    if (!m) {
      return { ok: false, lines, problem: `a partir del carácter ${pos} no coincide con el formato del documento: "${body.slice(pos, pos + 80)}"` };
    }
    lines.push({
      ticketId: m[1],
      date: m[2],
      time: m[3],
      seller: m[4],
      plu: Number(m[5]),
      sector: m[6],
      units: Number(m[7]),
      grams: Number(m[8]),
      drained: Number(m[9]),
      amount: Number(m[10]) / 100
    });
    pos = LINE.lastIndex;
  }
  return { ok: true, lines, problem: null };
}

export interface SystelTicket {
  ticketId: string;
  date: string;
  time: string;
  lines: SystelSaleLine[];
  total: number;
}

export function groupTickets(lines: SystelSaleLine[]): SystelTicket[] {
  const map = new Map<string, SystelTicket>();
  for (const l of lines) {
    const key = `${l.date}|${l.ticketId}`;
    const t = map.get(key) ?? { ticketId: l.ticketId, date: l.date, time: l.time, lines: [], total: 0 };
    t.lines.push(l);
    t.total = Math.round((t.total + l.amount) * 100) / 100;
    if (l.time > t.time) t.time = l.time;
    map.set(key, t);
  }
  return [...map.values()];
}

const stamp = (t: SystelTicket) => {
  const [d, m, y] = t.date.split("/");
  return `${y}${m}${d}${t.time.replace(/:/g, "")}`;
};

export type TicketMatch =
  | { ok: true; ticket: SystelTicket; otherCandidates: number }
  | { ok: false; reason: string };

/**
 * El ticket cuyo total es EXACTAMENTE el importe del código escaneado (y, si se sabe, con esa cantidad
 * de artículos), que no se haya cobrado ya en Patagonia. Si hay varios, el más reciente, y se avisa.
 */
export function findTicketForTotal(tickets: SystelTicket[], amount: number, opts: { articles?: number | null; usedKeys?: string[] } = {}): TicketMatch {
  const used = new Set(opts.usedKeys ?? []);
  const same = tickets.filter((t) => Math.round(t.total * 100) === Math.round(amount * 100));
  if (same.length === 0) return { ok: false, reason: `la balanza no tiene hoy ningún ticket de $${amount.toLocaleString("es-AR")}` };
  const withCount = opts.articles ? same.filter((t) => t.lines.length === opts.articles) : same;
  if (withCount.length === 0) return { ok: false, reason: `la balanza tiene tickets de $${amount.toLocaleString("es-AR")}, pero ninguno con ${opts.articles} artículos` };
  const free = withCount.filter((t) => !used.has(ticketKey(t)));
  if (free.length === 0) return { ok: false, reason: `el ticket de $${amount.toLocaleString("es-AR")} ya está cargado en esta venta o ya se cobró en Patagonia` };
  const sorted = [...free].sort((a, b) => stamp(b).localeCompare(stamp(a)));
  return { ok: true, ticket: sorted[0], otherCandidates: sorted.length - 1 };
}

export const ticketKey = (t: SystelTicket) => `systel-ticket-${t.date}-${t.ticketId}`;

export interface TicketCartLine {
  product: Product;
  quantity: number;
  amount: number;
  plu: number;
}

export type TicketToCart = { ok: true; lines: TicketCartLine[] } | { ok: false; reason: string };

/**
 * Cada artículo del ticket → producto de Patagonia con la cantidad que registró la balanza.
 * El N.º de PLU de la balanza se busca como código de producto (en Los gringos son iguales: el ticket
 * imprime "(C.PLU) 2" y en Patagonia el cajón es el código 2). Como el reporte da el N.º y no el código,
 * se comprueba cada artículo: cantidad × precio de Patagonia tiene que dar el importe que cobró la
 * balanza (±$1 por redondeo). Si no da, NO se carga nada: el producto o el precio no coinciden.
 */
export function ticketToCart(ticket: SystelTicket, products: Product[]): TicketToCart {
  const active = products.filter((p) => p.active ?? true);
  const out: TicketCartLine[] = [];
  for (const l of ticket.lines) {
    const p = active.find((x) => x.code === String(l.plu));
    if (!p) return { ok: false, reason: `el artículo N.º ${l.plu} de la balanza ($${l.amount.toLocaleString("es-AR")}) no existe como producto activo en Patagonia (código ${l.plu})` };
    if (l.drained > 0) return { ok: false, reason: `${p.name} es un producto escurrido en la balanza: Patagonia todavía no lo interpreta` };
    let quantity: number;
    if (p.unit === "kg") {
      if (!(l.grams > 0)) return { ok: false, reason: `${p.name} se vende por kg en Patagonia, pero la balanza lo vendió por unidad (${l.units} u.)` };
      quantity = l.grams / 1000;
    } else {
      if (!(l.units > 0)) return { ok: false, reason: `${p.name} se vende por unidad en Patagonia, pero la balanza lo pesó (${l.grams} g)` };
      quantity = l.units;
    }
    const expected = Math.round(quantity * p.priceRetail * 100) / 100;
    if (Math.abs(expected - l.amount) > 1) {
      return {
        ok: false,
        reason: `${p.name}: la balanza cobró $${l.amount.toLocaleString("es-AR")} por ${p.unit === "kg" ? `${quantity.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : `${quantity} u.`}, y con el precio de Patagonia ($${p.priceRetail.toLocaleString("es-AR")}) da $${expected.toLocaleString("es-AR")}. No se cargó nada: el precio de la balanza y el de Patagonia tienen que ser iguales`
      };
    }
    out.push({ product: p, quantity, amount: l.amount, plu: l.plu });
  }
  return { ok: true, lines: out };
}
