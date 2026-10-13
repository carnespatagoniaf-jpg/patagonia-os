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
  /** Hora del primer artículo (con la fecha y el N.º, identifica el ticket). */
  firstTime: string;
  time: string;
  seller: string;
  lines: SystelSaleLine[];
  total: number;
}

/** Artículos de un mismo ticket: misma fecha, mismo N.º de ticket y mismo vendedor. */
export function groupTickets(lines: SystelSaleLine[]): SystelTicket[] {
  const map = new Map<string, SystelTicket>();
  for (const l of lines) {
    const key = `${l.date}|${l.ticketId}|${l.seller}`;
    const t = map.get(key) ?? { ticketId: l.ticketId, date: l.date, firstTime: l.time, time: l.time, seller: l.seller, lines: [], total: 0 };
    t.lines.push(l);
    t.total = Math.round((t.total + l.amount) * 100) / 100;
    if (l.time > t.time) t.time = l.time;
    if (l.time < t.firstTime) t.firstTime = l.time;
    map.set(key, t);
  }
  return [...map.values()];
}

/**
 * Identidad del ticket (NO su importe ni el código del TOTAL: dos ventas legítimas pueden dar lo mismo):
 * N.º de balanza + fecha + N.º de ticket + vendedor + hora del primer artículo. La hora queda por si
 * la balanza reinicia la numeración el mismo día (cierre de ventas).
 */
export const ticketKey = (scale: number, t: SystelTicket) => `systel:${scale}:${t.date}:${Number(t.ticketId)}:${t.seller}:${t.firstTime}`;

/**
 * Lo que dice el código del TOTAL según el formato de "sumas" que tiene ESA balanza (configuración 39,
 * campo E_S; real Los gringos 09/10 "22BBIIIIIIII", 13/10 en pantalla "22AAIIIIIIII"):
 * I = importe, A = cantidad de artículos, B = N.º de balanza, números = fijos.
 */
export function decodeSumCode(code: string, template: string | null): { ok: true; amount: number | null; articles: number | null; scale: number | null } | { ok: false; reason: string } {
  if (!template || !/^[0-9IAB]{12}$/.test(template)) return { ok: true, amount: null, articles: null, scale: null };
  if (!/^\d{13}$/.test(code)) return { ok: false, reason: "el código del TOTAL no tiene 13 números" };
  let i = "";
  let a = "";
  let b = "";
  for (let k = 0; k < 12; k++) {
    const t = template[k];
    const d = code[k];
    if (t === "I") i += d;
    else if (t === "A") a += d;
    else if (t === "B") b += d;
    else if (t !== d) return { ok: false, reason: `el código del TOTAL no coincide con el formato de sumas de la balanza (${template})` };
  }
  return { ok: true, amount: i ? Number(i) : null, articles: a ? Number(a) : null, scale: b ? Number(b) : null };
}

export type TicketMatch =
  | { ok: true; candidates: SystelTicket[] }
  | { ok: false; reason: string };

/**
 * Tickets que pueden ser el del código escaneado: total EXACTO y, si el código lo dice, la misma
 * cantidad de artículos; sin los que ya se cobraron (por identidad). Puede devolver más de uno:
 * entonces NO se elige a ciegas (lo elige la persona con la hora y el N.º de operación impresos).
 */
export function findTicketsForTotal(tickets: SystelTicket[], amount: number, opts: { scale: number; articles?: number | null; usedKeys?: Iterable<string> }): TicketMatch {
  const used = new Set(opts.usedKeys ?? []);
  const money = (n: number) => `$${n.toLocaleString("es-AR")}`;
  const same = tickets.filter((t) => Math.round(t.total * 100) === Math.round(amount * 100));
  if (same.length === 0) return { ok: false, reason: `la balanza no tiene hoy ningún ticket de ${money(amount)}` };
  const withCount = opts.articles ? same.filter((t) => t.lines.length === opts.articles) : same;
  if (withCount.length === 0) return { ok: false, reason: `la balanza tiene tickets de ${money(amount)}, pero ninguno con ${opts.articles} artículos` };
  const free = withCount.filter((t) => !used.has(ticketKey(opts.scale, t)));
  if (free.length === 0) return { ok: false, reason: withCount.length === 1 ? `ese ticket de ${money(amount)} ya está cargado en esta venta o ya se cobró` : `los ${withCount.length} tickets de ${money(amount)} de hoy ya se cobraron` };
  return { ok: true, candidates: [...free].sort((x, y) => `${y.date}${y.time}`.localeCompare(`${x.date}${x.time}`)) };
}

/** Lo que dice la balanza de un PLU (función 62): su CÓDIGO y su tipo de venta. */
export interface ScalePluInfo {
  number: number;
  code: number;
  name: string;
  saleType: "P" | "U" | "E" | "C";
}

export interface TicketCartLine {
  product: Product;
  quantity: number;
  /** Importe que cobró la balanza por este artículo. */
  amount: number;
  plu: number;
  scaleName: string;
}

export type TicketToCart = { ok: true; lines: TicketCartLine[] } | { ok: false; reason: string };

/**
 * Cada artículo → producto de Patagonia, con la cantidad y el importe de la BALANZA:
 * - vínculo por CÓDIGO: el reporte da el N.º de PLU; su código se lee de la balanza (62) y se busca
 *   el producto de Patagonia con ese código;
 * - unidad de venta: pesable/congelado en la balanza ↔ por kg en Patagonia; unitario ↔ por unidad o caja;
 *   y el artículo del reporte tiene que traer gramos (pesable) o unidades (unitario), no lo otro;
 * - el importe es el de la balanza (no depende del precio de Patagonia, que no se toca).
 * Si un artículo no cumple todo, no se carga NINGUNO.
 */
export function linkTicketLines(ticket: SystelTicket, plus: Map<number, ScalePluInfo>, products: Product[]): TicketToCart {
  const active = products.filter((p) => p.active ?? true);
  const out: TicketCartLine[] = [];
  for (const l of ticket.lines) {
    const info = plus.get(l.plu);
    if (!info) return { ok: false, reason: `no se pudo leer en la balanza el producto N.º ${l.plu}` };
    const label = `"${info.name.trim()}" (N.º ${l.plu} de la balanza, código ${info.code})`;
    const p = active.find((x) => x.code === String(info.code));
    if (!p) return { ok: false, reason: `${label} no tiene un producto activo con el código ${info.code} en Patagonia` };
    if (info.saleType === "E" || l.drained > 0) return { ok: false, reason: `${label} es un producto escurrido: Patagonia todavía no lo interpreta` };
    const weighed = info.saleType === "P" || info.saleType === "C";
    if (weighed !== (p.unit === "kg")) {
      return { ok: false, reason: `${label} en la balanza se vende ${weighed ? "por peso" : "por unidad"} y en Patagonia "${p.name}" se vende ${p.unit === "kg" ? "por kg" : "por unidad"}` };
    }
    if (weighed ? !(l.grams > 0 && l.units === 0) : !(l.units > 0 && l.grams === 0)) {
      return { ok: false, reason: `${label}: el reporte de la balanza trae ${l.units} unidades y ${l.grams} g, que no corresponde a un producto ${weighed ? "pesable" : "por unidad"}` };
    }
    if (!(l.amount > 0)) return { ok: false, reason: `${label}: la balanza registró importe $0` };
    out.push({ product: p, quantity: weighed ? l.grams / 1000 : l.units, amount: l.amount, plu: l.plu, scaleName: info.name.trim() });
  }
  return { ok: true, lines: out };
}
