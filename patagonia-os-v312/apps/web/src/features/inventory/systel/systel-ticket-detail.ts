import type { Product } from "@patagonia/domain";
import type { SystelClient } from "./systel-client";
import type { SystelLayout } from "./systel-plu";
import { assignLineKeys, decodeSumCode, findTicketsForTotal, groupTickets, linkTicketLines, parseSalesReport, ticketLineKeys, type ScalePluInfo, type SystelTicket, type TicketCartLine } from "./systel-sales";

/**
 * Del código del TOTAL de un ticket de Systel al detalle de ese ticket, leído de la balanza por cable.
 * Solo lectura: 39 (configuración, para saber qué dice el código del TOTAL), 72 (reporte de ventas)
 * y 62/3 (cada producto del ticket, para vincularlo por su CÓDIGO y su tipo de venta).
 * No calcula ni supone cantidades ni importes: salen de la balanza. Si algo no coincide, no carga nada.
 */

export interface TicketCandidate {
  /** Identidades de sus artículos, unidas (para la pantalla). */
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
  | { ok: false; stage: "lectura" | "sin_ventas" | "formato" | "ticket" | "productos"; reason: string };

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
    /** Recibe la configuración leída (formato de los códigos de barras de la balanza). */
    onConfig?: (values: Record<string, string>) => void;
  }
): Promise<TicketDetailResult> {
  const now = input.now ?? new Date();
  const cache: PluCache = input.cache ?? { layout: null, plus: new Map() };

  // 1. Qué dice el código del TOTAL en ESTA balanza (importe, artículos, N.º de balanza).
  const config = await client.config();
  if (config) input.onConfig?.(config.values);
  const decoded = decodeSumCode(input.code, config?.values.E_S ?? null);
  if (!decoded.ok) return { ok: false, stage: "ticket", reason: decoded.reason };
  if (decoded.scale !== null && decoded.scale !== client.address) {
    return { ok: false, stage: "ticket", reason: `ese ticket es de la balanza N.º ${decoded.scale}, y la conectada a esta computadora es la N.º ${client.address}` };
  }

  // 2. Reporte de ventas de hoy.
  const report = await client.salesReport(now);
  if ("error" in report) {
    // E7 = "el dato pedido no existe". REAL (14/10): la balanza lo contesta a un rango inválido (inicio = fin),
    // no a "no hay ventas" (eso es un reporte vacío). No es un problema del cable: avisa a soporte.
    if (report.code === "E7") return { ok: false, stage: "formato", reason: "la balanza rechazó el pedido de ventas (E7); ya le llegó el aviso a soporte" };
    return { ok: false, stage: "lectura", reason: report.error };
  }
  const parsed = parseSalesReport(report.data);
  // REAL (14/10 09:29): sin ventas en el período la balanza contesta solo "F".
  if (parsed.ok && parsed.lines.length === 0) return { ok: false, stage: "sin_ventas", reason: "la balanza no tiene ventas guardadas de ayer ni de hoy (puede que se haya hecho \"Cerrar ventas\")" };
  if (!parsed.ok) return { ok: false, stage: "formato", reason: `el reporte de ventas de la balanza vino en un formato que Patagonia no reconoce: ${parsed.problem}` };

  // 3. Tickets con ese total exacto (y esa cantidad de artículos), sin artículos ya cobrados (identidad por artículo).
  const lines = assignLineKeys(parsed.lines, client.address);
  const used = new Set(input.usedKeys);
  let match = findTicketsForTotal(lines, input.amount, { articles: decoded.articles, usedKeys: used });
  if (!match.ok) return { ok: false, stage: "ticket", reason: match.reason };
  if (input.charged) {
    const charged = await input.charged([...new Set([...match.candidates, ...match.charged].flatMap(ticketLineKeys))]);
    if (charged.size) {
      match = findTicketsForTotal(lines, input.amount, { articles: decoded.articles, usedKeys: [...used, ...charged] });
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
    return { key: ticketLineKeys(t).join("|"), ticket: t, lines: linked.ok ? linked.lines : null, problem: linked.ok ? null : linked.reason };
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
