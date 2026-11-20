/**
 * Resumen del día del panel de plataforma, en texto para WhatsApp (Etapa 4, 20/11/2026).
 * Lógica pura, testeada en daily-summary.test.ts. Hoy se manda con un toque desde Resumen; el mismo texto sirve
 * si después se automatiza el envío (mail o WhatsApp de la API de Meta).
 */

export interface DailySummaryInput {
  brandName: string;
  /** YYYY-MM-DD de hoy (hora argentina). */
  today: string;
  activeClients: number;
  collectedThisMonth: number;
  collectedYesterday: number;
  overdue: number;
  overdueCount: number;
  dueSoon: { name: string; days: number }[];
  /** Clientes en rojo o amarillo, el más grave primero. */
  atRisk: { name: string; level: "risk" | "warn"; reason: string }[];
  upsellCount: number;
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function formatPesos(value: number) {
  return `$${Math.round(value).toLocaleString("es-AR")}`;
}

function dueText(days: number) {
  return days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`;
}

/** Hasta `max` nombres y "y N más". */
function listNames(names: string[], max = 4) {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} y ${names.length - max} más`;
}

export function buildDailySummary(s: DailySummaryInput): string {
  const date = new Date(`${s.today}T12:00:00`);
  const month = MONTHS[date.getMonth()];
  const lines: string[] = [];
  lines.push(`*${s.brandName} · ${WEEKDAYS[date.getDay()]} ${s.today.slice(8, 10)}/${s.today.slice(5, 7)}*`);
  lines.push("");
  lines.push(`💰 Cobrado en ${month}: ${formatPesos(s.collectedThisMonth)}${s.collectedYesterday > 0 ? ` (ayer ${formatPesos(s.collectedYesterday)})` : ""}`);
  lines.push(s.overdueCount > 0 ? `🔴 Deben: ${s.overdueCount} ${s.overdueCount === 1 ? "cliente" : "clientes"}, ${formatPesos(s.overdue)}` : "✅ Nadie debe el abono");
  if (s.dueSoon.length > 0) lines.push(`⏰ Vencen esta semana: ${listNames(s.dueSoon.map((d) => `${d.name} (${dueText(d.days)})`))}`);

  const risk = s.atRisk.filter((r) => r.level === "risk");
  const warn = s.atRisk.filter((r) => r.level === "warn");
  if (risk.length > 0) {
    lines.push("");
    lines.push(`⚠️ Pueden irse (${risk.length}):`);
    for (const r of risk.slice(0, 5)) lines.push(`• ${r.name}: ${r.reason}`);
    if (risk.length > 5) lines.push(`• y ${risk.length - 5} más`);
  }
  if (warn.length > 0) lines.push(`👀 Para mirar: ${listNames(warn.map((r) => r.name))}`);
  if (risk.length === 0 && warn.length === 0) lines.push("✅ Todos los clientes venden y están al día");
  if (s.upsellCount > 0) lines.push(`📈 ${s.upsellCount} ${s.upsellCount === 1 ? "oportunidad" : "oportunidades"} de venderle más (ver Resumen)`);

  lines.push("");
  lines.push(`Clientes activos: ${s.activeClients}`);
  return lines.join("\n");
}

/** Día anterior en YYYY-MM-DD. */
export function previousDay(todayIso: string): string {
  const d = new Date(`${todayIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
