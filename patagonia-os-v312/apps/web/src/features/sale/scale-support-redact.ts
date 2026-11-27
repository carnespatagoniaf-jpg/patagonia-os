import type { SystelExchangeLog } from "../inventory/systel/systel-client";
import type { SystelLinkEvent } from "../inventory/systel/systel-serial";
import type { TicketCandidate } from "../inventory/systel/systel-ticket-detail";

/**
 * C26 (auditoría 26/11): el reporte a soporte que manda Mostrador al leer el detalle de un ticket de una Systel llevaba
 * los renglones de venta del cliente (productos, kilos e importes) y las respuestas crudas de la balanza (que traen las
 * ventas). Ahora va solo lo que sirve para soporte: el código escaneado, los formatos y el resultado de la lectura.
 * Puro (scale-support-redact.test.ts).
 */

type ReadResult = { ok: true; candidates: TicketCandidate[] } | { ok: false; stage: string; reason: string };

/** Saca importes de un texto ("$12.810", "$ 1.234,50"). */
export function withoutAmounts(text: string): string {
  return text.replace(/\$\s?[\d.,]+/g, "$…");
}

export function systelTicketSupportReport(input: {
  code: string;
  result: ReadResult;
  context: unknown;
  log: SystelExchangeLog[];
  events: SystelLinkEvent[];
}) {
  const { code, result: r } = input;
  const note = `Systel · Mostrador: detalle del ticket ${code} · ${r.ok ? `OK: ${r.candidates.length} ticket(s) posible(s)` : `${r.stage}: ${withoutAmounts(r.reason)}`}`;
  const result = r.ok
    ? r.candidates.map((c) => ({ key: c.key, articles: c.ticket.lines.length, plus: c.ticket.lines.map((l) => l.plu), linked: c.lines !== null, problem: c.problem ? withoutAmounts(c.problem) : null }))
    : { ok: false, stage: r.stage, reason: withoutAmounts(r.reason) };
  // Del intercambio por el cable: qué función se pidió, cuánto tardó y cómo terminó; sin las respuestas (traen las ventas).
  const log = input.log.slice(-200).map((e) => ({ step: e.step, fn: e.fn, tx: e.tx, rxBytes: e.rx ? e.rx.replace(/\s+/g, "").length / 2 : 0, ms: e.ms, result: withoutAmounts(e.result) }));
  const linkEvents = input.events.slice(-600).map((e) => (e.kind === "rx" ? { t: e.t, kind: e.kind, detail: withoutAmounts(e.detail) } : e));
  return { note, logText: JSON.stringify({ context: input.context, result }), diagnosticRecord: { log, linkEvents } };
}
