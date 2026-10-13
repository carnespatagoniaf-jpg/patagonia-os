import type { Product } from "@patagonia/domain";
import type { SystelClient } from "./systel-client";
import type { SystelLayout } from "./systel-plu";
import { decodeSumCode, findTicketsForTotal, groupTickets, linkTicketLines, parseSalesReport, ticketKey, type ScalePluInfo, type SystelTicket, type TicketCartLine } from "./systel-sales";

/**
 * Del código del TOTAL de un ticket de Systel al detalle de ese ticket, leído de la balanza por cable.
 * Solo lectura: 39 (configuración, para saber qué dice el código del TOTAL), 72 (reporte de ventas)
 * y 62/3 (cada producto del ticket, para vincularlo por su CÓDIGO y su tipo de venta).
 * No calcula ni supone cantidades ni importes: salen de la balanza. Si algo no coincide, no carga nada.
 */

export interface TicketCandidate {
  key: string;
  ticket: SystelTicket;
  /** null si algún artículo no se pudo vincular (ver `problem`). */
  lines: TicketCartLine[] | null;
  problem: string | null;
}

export type TicketDetailResult =
  /**
   * `charged`: tickets iguales (mismo total y artículos) ya cobrados. Si hay alguno, el escaneo puede ser
   * un reescaneo de ese mismo papel: Mostrador pide confirmar aunque quede un solo candidato.
   */
  | { ok: true; candidates: TicketCandidate[]; charged: SystelTicket[]; articles: number | null }
  | { ok: false; stage: "lectura" | "formato" | "ticket" | "productos"; reason: string };

export interface PluCache {
  layout: SystelLayout | null;
  plus: Map<number, ScalePluInfo>;
}

const MAX_CANDIDATES = 5;

export async function readTicketDetail(
  client: SystelClient,
  input: {
    code: string;
    amount: number;
    products: Product[];
    /** Identidades de tickets ya cargados en esta venta o cobrados (también se consulta `charged`). */
    usedKeys: Iterable<string>;
    /** Cuáles de estas identidades ya están en una venta no anulada (base de datos). */
    charged?: (keys: string[]) => Promise<Set<string>>;
    now?: Date;
    cache?: PluCache;
  }
): Promise<TicketDetailResult> {
  const now = input.now ?? new Date();
  const cache: PluCache = input.cache ?? { layout: null, plus: new Map() };

  // 1. Qué dice el código del TOTAL en ESTA balanza (importe, artículos, N.º de balanza).
  const config = await client.config();
  const decoded = decodeSumCode(input.code, config?.values.E_S ?? null);
  if (!decoded.ok) return { ok: false, stage: "ticket", reason: decoded.reason };
  if (decoded.scale !== null && decoded.scale !== client.address) {
    return { ok: false, stage: "ticket", reason: `ese ticket es de la balanza N.º ${decoded.scale}, y la conectada a esta computadora es la N.º ${client.address}` };
  }

  // 2. Reporte de ventas de hoy.
  const report = await client.salesReport(now);
  if ("error" in report) return { ok: false, stage: "lectura", reason: report.error };
  const parsed = parseSalesReport(report.data);
  if (!parsed.ok) return { ok: false, stage: "formato", reason: `el reporte de ventas de la balanza vino en un formato que Patagonia no reconoce: ${parsed.problem}` };

  // 3. Tickets con ese total exacto (y esa cantidad de artículos), sin los ya cobrados por identidad.
  const used = new Set(input.usedKeys);
  let match = findTicketsForTotal(groupTickets(parsed.lines), input.amount, { scale: client.address, articles: decoded.articles, usedKeys: used });
  if (!match.ok) return { ok: false, stage: "ticket", reason: match.reason };
  if (input.charged) {
    const charged = await input.charged(match.candidates.map((t) => ticketKey(client.address, t)));
    if (charged.size) {
      match = findTicketsForTotal(groupTickets(parsed.lines), input.amount, { scale: client.address, articles: decoded.articles, usedKeys: [...used, ...charged] });
      if (!match.ok) return { ok: false, stage: "ticket", reason: match.reason };
    }
  }
  const tickets = match.candidates.slice(0, MAX_CANDIDATES);

  // 4. Cada producto de esos tickets, leído de la balanza (código y tipo de venta).
  for (const n of [...new Set(tickets.flatMap((t) => t.lines.map((l) => l.plu)))]) {
    if (cache.plus.has(n)) continue;
    const info = await readPluInfo(client, cache, n);
    if (info) cache.plus.set(n, info);
  }

  const candidates = tickets.map((t) => {
    const linked = linkTicketLines(t, cache.plus, input.products);
    return { key: ticketKey(client.address, t), ticket: t, lines: linked.ok ? linked.lines : null, problem: linked.ok ? null : linked.reason };
  });
  if (candidates.length === 1 && !candidates[0].lines) return { ok: false, stage: "productos", reason: candidates[0].problem ?? "no se pudo vincular" };
  return { ok: true, candidates, charged: match.charged, articles: decoded.articles };
}

async function readPluInfo(client: SystelClient, cache: PluCache, n: number): Promise<ScalePluInfo | null> {
  if (!cache.layout) {
    // El formato del producto depende del firmware: se reconoce leyendo (62 de 4 dígitos, 3, o 62 de 6).
    for (const digits of [4, 6] as const) {
      const r = await client.detectLayout(n, digits);
      if (r.layout) {
        cache.layout = r.layout;
        return { number: n, code: r.plu.code, name: r.plu.name, saleType: r.plu.saleType };
      }
    }
    return null;
  }
  const plu = await client.readPlu(cache.layout, n);
  return plu ? { number: n, code: plu.code, name: plu.name, saleType: plu.saleType } : null;
}

/**
 * Diagnóstico de SOLO LECTURA para soporte: configuración (39), reporte de ventas de hoy (72) y el
 * código/tipo de los productos vendidos hoy (62/3, hasta 30). No carga nada en ninguna venta.
 */
export async function readTodaySalesDiagnostic(client: SystelClient, now = new Date()): Promise<{ summary: string; ok: boolean; plus: ScalePluInfo[] }> {
  const config = await client.config();
  const report = await client.salesReport(now);
  if ("error" in report) return { ok: false, summary: `configuración: ${config ? "leída" : "no se pudo leer"} · reporte de ventas: ${report.error}`, plus: [] };
  const parsed = parseSalesReport(report.data);
  if (!parsed.ok) return { ok: false, summary: `reporte de ventas de ${report.data.length} caracteres que no coincide con el documento: ${parsed.problem}`, plus: [] };
  const tickets = groupTickets(parsed.lines);
  const cache: PluCache = { layout: null, plus: new Map() };
  for (const n of [...new Set(parsed.lines.map((l) => l.plu))].slice(0, 30)) {
    const info = await readPluInfo(client, cache, n);
    if (info) cache.plus.set(n, info);
  }
  const plus = [...cache.plus.values()];
  return {
    ok: true,
    summary: `reporte de ventas leído: ${parsed.lines.length} artículos en ${tickets.length} tickets hoy · formato de sumas ${config?.values.E_S ?? "?"} · productos leídos ${plus.length} (formato ${cache.layout ?? "no reconocido"}): ${plus.map((p) => `N.º ${p.number} = código ${p.code} ${p.saleType} "${p.name.trim()}"`).join(", ")}`,
    plus
  };
}
