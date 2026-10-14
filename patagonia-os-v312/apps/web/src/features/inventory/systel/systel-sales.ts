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
  /** Identidad del artículo (`assignLineKeys`). */
  key?: string;
}

export interface SystelSalesReport {
  ok: boolean;
  lines: SystelSaleLine[];
  /** Por qué no se pudo usar (formato que no coincide con el documento). */
  problem: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Datos del pedido de la función 72: día-mes-año de inicio + día-mes-año de FIN SIN INCLUIR.
 * REAL (Los gringos, 14/10 09:29): "141026141026" (hoy a hoy, como se lee el documento) → E7;
 * "141026151026" (hoy a mañana) → reporte válido (vacío: "F", todavía no había ventas). O sea, la fecha de
 * fin no se incluye y un rango de un solo día con la misma fecha es inválido (E7).
 * Por defecto se piden AYER y HOY (por si se escanea un ticket impreso antes de la medianoche): un ticket ya
 * cobrado no se vuelve a cargar porque la identidad es por artículo.
 */
export function salesReportRequest(from: Date, toExclusive?: Date): string {
  const part = (d: Date) => `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${pad2(d.getFullYear() % 100)}`;
  const end = toExclusive ?? new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  return part(from) + part(end);
}

/** Pedido de Mostrador: ayer y hoy (fin = mañana, sin incluir). */
export function mostradorSalesRequest(today: Date): string {
  return salesReportRequest(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1), new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
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

/**
 * Identidad de UN ARTÍCULO del reporte (no del ticket): balanza + fecha + N.º + vendedor + hora + PLU, y
 * un orden si hubiera dos renglones idénticos. Se guarda en cada renglón de la venta (pos_sale_items.scale_ticket):
 * así ningún artículo de la balanza se puede cobrar dos veces, se agrupe como se agrupe.
 */
export function assignLineKeys(lines: SystelSaleLine[], scale: number): SystelSaleLine[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = `systel:${scale}:${l.date}:${Number(l.ticketId)}:${l.seller}:${l.time}:${l.plu}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...l, key: `${base}:${n}` };
  });
}

export interface SystelTicket {
  /** Para mostrar: "3095" o, si cada artículo trae su propio N.º, "38-39". */
  ticketId: string;
  date: string;
  firstTime: string;
  time: string;
  seller: string;
  lines: SystelSaleLine[];
  total: number;
}

function makeTicket(lines: SystelSaleLine[]): SystelTicket {
  const ids = [...new Set(lines.map((l) => Number(l.ticketId)))].sort((a, b) => a - b);
  const times = lines.map((l) => l.time).sort();
  return {
    ticketId: ids.length === 1 ? String(ids[0]) : `${ids[0]}-${ids[ids.length - 1]}`,
    date: lines[0].date,
    firstTime: times[0],
    time: times[times.length - 1],
    seller: lines[0].seller,
    lines,
    total: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
  };
}

/** Artículos con el mismo N.º de ticket, fecha y vendedor (si la balanza numera por ticket). */
export function groupTickets(lines: SystelSaleLine[]): SystelTicket[] {
  const map = new Map<string, SystelSaleLine[]>();
  for (const l of lines) {
    const k = `${l.date}|${Number(l.ticketId)}|${l.seller}`;
    map.set(k, [...(map.get(k) ?? []), l]);
  }
  return [...map.values()].map(makeTicket);
}

const MAX_RUN = 15;
const MAX_RUN_MINUTES = 30;
const minutes = (t: string) => {
  const [h, m, s] = t.split(":").map(Number);
  return h * 60 + m + s / 60;
};

/**
 * Tickets posibles para un TOTAL. El documento no dice si el "Ticket Id" es por ticket o por artículo, y el
 * "Detalle de ventas" impreso del manual de la Cuora Max numera CADA artículo ("VENTA Nº38… Nº39… Nº40").
 * Por eso se consideran las dos formas:
 * - artículos con el mismo N.º (numeración por ticket);
 * - artículos de N.º CONSECUTIVOS, del mismo vendedor y del mismo día, dentro de 30 minutos (numeración por
 *   artículo), con la cantidad de artículos que dice el código si la dice.
 * En los dos casos la suma tiene que ser EXACTAMENTE el total. Se descartan repetidos (mismo conjunto de artículos).
 */
export function candidateTickets(lines: SystelSaleLine[], amount: number, articles: number | null): SystelTicket[] {
  const cents = Math.round(amount * 100);
  const out = new Map<string, SystelTicket>();
  const add = (ls: SystelSaleLine[]) => {
    if (Math.round(ls.reduce((s, l) => s + l.amount, 0) * 100) !== cents) return;
    if (articles && ls.length !== articles) return;
    const id = ls.map((l) => l.key ?? `${l.ticketId}:${l.plu}:${l.time}`).sort().join("|");
    if (!out.has(id)) out.set(id, makeTicket(ls));
  };
  for (const t of groupTickets(lines)) add(t.lines);
  const bySeller = new Map<string, SystelSaleLine[]>();
  for (const l of lines) {
    const k = `${l.date}|${l.seller}`;
    bySeller.set(k, [...(bySeller.get(k) ?? []), l]);
  }
  for (const ls of bySeller.values()) {
    const sorted = [...ls].sort((a, b) => Number(a.ticketId) - Number(b.ticketId) || a.time.localeCompare(b.time));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i; j < sorted.length && j - i < MAX_RUN; j++) {
        if (j > i && Number(sorted[j].ticketId) !== Number(sorted[j - 1].ticketId) + 1) break;
        if (minutes(sorted[j].time) - minutes(sorted[i].time) > MAX_RUN_MINUTES) break;
        add(sorted.slice(i, j + 1));
      }
    }
  }
  return [...out.values()];
}

export type TicketMatch =
  /** `charged`: tickets iguales con algún artículo YA cobrado (el papel escaneado podría ser uno de esos). */
  | { ok: true; candidates: SystelTicket[]; charged: SystelTicket[] }
  | { ok: false; reason: string };

/**
 * Tickets que pueden ser el del código escaneado (ver `candidateTickets`), separando los que tienen algún
 * artículo ya cobrado. Puede devolver más de uno: entonces NO se elige a ciegas.
 */
export function findTicketsForTotal(lines: SystelSaleLine[], amount: number, opts: { articles?: number | null; usedKeys?: Iterable<string> }): TicketMatch {
  const used = new Set(opts.usedKeys ?? []);
  const money = (n: number) => `${n.toLocaleString("es-AR")}`;
  const all = candidateTickets(lines, amount, opts.articles ?? null);
  if (all.length === 0) {
    const anyAmount = candidateTickets(lines, amount, null).length > 0;
    return { ok: false, reason: anyAmount && opts.articles ? `la balanza tiene ventas de ${money(amount)}, pero ninguna con ${opts.articles} artículos` : `la balanza no tiene hoy ningún ticket de ${money(amount)}` };
  }
  const isUsed = (t: SystelTicket) => t.lines.some((l) => l.key && used.has(l.key));
  const free = all.filter((t) => !isUsed(t));
  if (free.length === 0) return { ok: false, reason: all.length === 1 ? `ese ticket de ${money(amount)} ya está cargado en esta venta o ya se cobró` : `los ${all.length} tickets de ${money(amount)} de hoy ya se cobraron` };
  const newest = (x: SystelTicket, y: SystelTicket) => `${y.date}${y.time}`.localeCompare(`${x.date}${x.time}`);
  return { ok: true, candidates: [...free].sort(newest), charged: all.filter(isUsed).sort(newest) };
}

/** Las identidades de los artículos de un ticket (lo que se guarda y se consulta para no cobrar dos veces). */
export const ticketLineKeys = (t: SystelTicket): string[] => t.lines.map((l) => l.key ?? "");

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
  /** Identidad del artículo de la balanza (se guarda en el renglón de la venta). */
  lineKey: string;
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
    out.push({ product: p, quantity: weighed ? l.grams / 1000 : l.units, amount: l.amount, plu: l.plu, scaleName: info.name.trim(), lineKey: l.key ?? "" });
  }
  return { ok: true, lines: out };
}
