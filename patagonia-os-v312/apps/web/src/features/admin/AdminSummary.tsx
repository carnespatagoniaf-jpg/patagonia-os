import { useEffect, useMemo, useState } from "react";
import { Download, MessageCircle } from "lucide-react";
import { PLAN_LABELS, type Plan } from "../auth/permissions";
import { getPlatformSummary, listPaymentsForAdmin, type CompanyPlanInfo, type CompanySummary, type PlatformSummary } from "./admin-service";
import { billingLabel, formatDayMonth } from "./company-billing";
import { dueSoonList, monthChangePct, pageLabel } from "./platform-summary";
import { HEALTH_LABEL, healthMessage, type Health, type Upsell } from "./client-health";
import { whatsappLink } from "./sales-pipeline";
import { BRAND } from "../../lib/brand";
import { buildDailySummary } from "./daily-summary";
import { DailySummaryCard } from "./DailySummaryCard";
import { downloadCsv, toCsv } from "../../lib/csv";
import { Alert, Badge, Button, Card, Kpi, Select, Skeleton } from "./ui/components";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTHS_LONG = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

function shortMoney(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

function monthIndex(month: string) {
  return Number(month.slice(5, 7)) - 1;
}

/** Gráfico de barras de lo cobrado por mes (una sola serie: el mes actual más oscuro). */
function MonthlyChart({ data }: { data: PlatformSummary["monthly"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.amount), 1);
  const W = 600, H = 200, left = 8, bottom = 22, top = 22;
  const slot = (W - left) / data.length;
  const barW = Math.min(30, slot - 10);
  const plotH = H - bottom - top;
  return (
    <div className="admin-sum-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cobrado por mes, últimos 12 meses">
        <line x1={left} y1={H - bottom} x2={W} y2={H - bottom} stroke="var(--pa-line)" />
        {data.map((d, i) => {
          const h = d.amount > 0 ? Math.max(4, (d.amount / max) * plotH) : 0;
          const x = left + i * slot + (slot - barW) / 2;
          const y = H - bottom - h;
          const last = i === data.length - 1;
          return (
            <g key={d.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={left + i * slot} y={top - 18} width={slot} height={plotH + 18} fill="transparent" />
              {h > 0 && <path d={`M${x},${H - bottom} V${y + 4} Q${x},${y} ${x + 4},${y} H${x + barW - 4} Q${x + barW},${y} ${x + barW},${y + 4} V${H - bottom} Z`} fill={last ? "var(--pa-brand)" : hover === i ? "var(--pa-brand-ink)" : "var(--pa-chart-soft)"} />}
              {(last || hover === i) && d.amount > 0 && (
                <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--pa-ink)">{shortMoney(d.amount)}</text>
              )}
              <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize="11" fill={last ? "var(--pa-ink)" : "var(--pa-muted)"} fontWeight={last ? 700 : 400}>
                {MONTHS[monthIndex(d.month)]}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <p className="pa-muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {MONTHS_LONG[monthIndex(data[hover].month)]} {data[hover].month.slice(0, 4)}: <b>{formatMoney(data[hover].amount)}</b> · {data[hover].count} {data[hover].count === 1 ? "pago" : "pagos"}
        </p>
      )}
    </div>
  );
}

/** Pestaña "Resumen" del panel de plataforma: cómo va el negocio de un vistazo. */
export function AdminSummary({
  companies,
  plans,
  planPrice,
  monthlyFee,
  isAutoCharged,
  today,
  health,
  upsells,
  onOpenClient,
  overdue,
  overdueCount,
  collectedYesterday
}: {
  companies: CompanySummary[];
  plans: Record<string, CompanyPlanInfo>;
  planPrice: (companyId: string) => number;
  /** Abono mensual de los que pagan (lo que entra cada mes si nadie se va). */
  monthlyFee: number;
  /** true = suscripción de Mercado Pago al día (se cobra solo). */
  isAutoCharged: (companyId: string) => boolean;
  today: string;
  /** Semáforo de cada cliente activo (client-health.ts). */
  health: { company: CompanySummary; health: Health }[];
  /** A quién venderle más (por pantallas y locales). */
  upsells: Upsell[];
  onOpenClient: (companyId: string) => void;
  /** Para el resumen del día. */
  overdue: number;
  overdueCount: number;
  collectedYesterday: number;
}) {
  const [summary, setSummary] = useState<PlatformSummary | null>(null);
  const [error, setError] = useState("");
  const [exportMonth, setExportMonth] = useState(today.slice(0, 7));
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getPlatformSummary().then(setSummary).catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el resumen."));
  }, []);

  const byId = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);
  const active = companies.filter((c) => c.active);
  const paying = active.filter((c) => (c.paidUntil && c.paidUntil >= today) || isAutoCharged(c.id));
  const atRisk = health.filter((h) => h.health.level !== "ok").sort((a, b) => (a.health.level === b.health.level ? 0 : a.health.level === "risk" ? -1 : 1));
  const riskCount = health.filter((h) => h.health.level === "risk").length;
  const dueSoon = dueSoonList(companies, today, (c) => isAutoCharged(c.id));
  const nextMonthIdx = (Number(today.slice(5, 7)) % 12);

  const monthly = summary?.monthly ?? [];
  const current = monthly[monthly.length - 1]?.amount ?? 0;
  const previous = monthly[monthly.length - 2]?.amount ?? 0;
  const change = monthChangePct(current, previous);
  const usageMax = Math.max(active.length, 1);
  const monthOptions = monthly.map((m) => m.month).reverse();

  function exportClients() {
    const rows = [...companies]
      .sort((a, b) => (a.clientNumber ?? 0) - (b.clientNumber ?? 0))
      .map((c) => {
        const plan = plans[c.id]?.plan as Plan | undefined;
        return [
          c.clientNumber ?? "", c.name, c.ownerFullName ?? "", c.ownerEmail ?? "", c.contactPhone ?? "", c.province ?? "", c.city ?? "",
          plan ? PLAN_LABELS[plan] : "", planPrice(c.id) || "", c.active ? "Activo" : "Dado de baja",
          isAutoCharged(c.id) ? "Suscripción Mercado Pago al día" : billingLabel(c, today),
          c.paidUntil ? formatDayMonth(c.paidUntil) : "", c.lastPaymentDate ? formatDayMonth(c.lastPaymentDate) : "", c.lastPaymentAmount ?? ""
        ];
      });
    downloadCsv(
      `clientes-patagonia-${today}.csv`,
      toCsv(["N.º", "Negocio", "Dueño", "Email", "Teléfono", "Provincia", "Ciudad", "Plan", "Abono mensual", "Estado", "Pago", "Pagado hasta", "Último pago", "Monto último pago"], rows)
    );
  }

  async function exportPayments() {
    setExporting(true);
    try {
      const [y, m] = exportMonth.split("-").map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const rows = await listPaymentsForAdmin(`${exportMonth}-01`, `${exportMonth}-${String(last).padStart(2, "0")}`);
      const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
      downloadCsv(
        `pagos-patagonia-${exportMonth}.csv`,
        toCsv(
          ["Fecha", "N.º", "Cliente", "Monto", "Meses", "Pagado hasta", "Nota"],
          [
            ...rows.map((r) => [formatDayMonth(r.paymentDate), r.clientNumber ?? "", r.companyName, r.amount ?? "", r.months, formatDayMonth(r.paidUntil), r.note ?? ""]),
            ["", "", "TOTAL", total, "", "", ""]
          ]
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron bajar los pagos.");
    } finally {
      setExporting(false);
    }
  }

  const monthLabel = MONTHS_LONG[Number(today.slice(5, 7)) - 1];
  const prevMonthLabel = MONTHS_LONG[(Number(today.slice(5, 7)) + 10) % 12];

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {error && <Alert tone="warn" onClose={() => setError("")}>{error}</Alert>}

      <div className="pa-kpis">
        <Kpi label={`Cobrado en ${monthLabel}`} value={formatMoney(current)} delta={change} deltaLabel={`vs ${prevMonthLabel}`} />
        <Kpi label="Clientes que pagan" value={paying.length} hint={`de ${active.length} activos`} />
        <Kpi
          label="Altas / bajas del mes"
          value={summary ? `${summary.newThisMonth} / ${summary.lostThisMonth.length}` : "…"}
          hint={summary && summary.lostThisMonth.length > 0 ? `se fue: ${summary.lostThisMonth.join(", ")}` : "nadie se dio de baja"}
        />
        <Kpi label="En riesgo de irse" value={<span className={riskCount > 0 ? "pa-text-danger" : undefined}>{riskCount}</span>} hint={`${atRisk.length - riskCount} más para mirar`} />
        <Kpi label="Pruebas que pasaron a pago" value={summary ? `${summary.trials60dPaid} de ${summary.trials60d}` : "…"} hint="altas de los últimos 60 días" />
      </div>

      <DailySummaryCard
        text={buildDailySummary({
          brandName: BRAND.name,
          today,
          activeClients: active.length,
          collectedThisMonth: current,
          collectedYesterday,
          overdue,
          overdueCount,
          dueSoon: dueSoon.map(({ company, days }) => ({ name: company.name, days })),
          atRisk: atRisk.map(({ company, health: h }) => ({ name: company.name, level: h.level === "risk" ? "risk" : "warn", reason: h.reasons[0] ?? "" })),
          upsellCount: upsells.length
        })}
      />

      <Card
        title="Clientes que pueden irse"
        subtitle={atRisk.length === 0 ? "Todos los clientes activos venden y están al día." : "Venden menos que antes, no venden hace días o no arrancaron. Escribiles antes de que se vayan."}
      >
        {atRisk.map(({ company, health: h }) => {
          const link = whatsappLink(company.contactPhone, healthMessage(BRAND.name, company.name, company.ownerFullName, h));
          return (
            <div key={company.id} className="pa-list-row">
              <span style={{ flex: 1, minWidth: 0 }}>
                <button type="button" className="pa-link" onClick={() => onOpenClient(company.id)}>{company.name}</button>
                <span className="pa-muted"> · {h.reasons.join(" · ")}</span>
              </span>
              <span className="pa-row" style={{ gap: 6 }}>
                <Badge tone={h.level === "risk" ? "danger" : "warn"}>{HEALTH_LABEL[h.level]}</Badge>
                {link && <a className="pa-btn pa-btn-whatsapp pa-btn-sm" href={link} target="_blank" rel="noreferrer"><MessageCircle size={14} /> Escribirle</a>}
              </span>
            </div>
          );
        })}
      </Card>

      <div className="pa-sum-grid">
        <Card title="Cobrado mes a mes" subtitle={<>Si nadie se va, en {MONTHS_LONG[nextMonthIdx]} cobrás <b>{formatMoney(monthlyFee)}</b>.</>}>
          {monthly.length > 0 ? <MonthlyChart data={monthly} /> : <Skeleton lines={5} />}
          {monthly.length > 0 && monthly[0].amount === 0 && (
            <span className="pa-muted" style={{ fontSize: 12 }}>Los meses en 0 son de antes de que se empezaran a anotar los pagos en el panel.</span>
          )}
        </Card>

        <div style={{ display: "grid", gap: 16, alignContent: "start", minWidth: 0 }}>
          <Card title="Vencen esta semana" subtitle={dueSoon.length === 0 ? "Nadie vence en los próximos 7 días (los que pagan por suscripción se cobran solos)." : undefined}>
            {dueSoon.map(({ company, days }) => (
              <div key={company.id} className="pa-list-row">
                <span><b>{company.name}</b></span>
                <span className="pa-row" style={{ gap: 6 }}>
                  <Badge tone={days <= 1 ? "warn" : "neutral"}>{days === 0 ? "vence hoy" : days === 1 ? "vence mañana" : `en ${days} días`}</Badge>
                  <span className="pa-num">{formatMoney(planPrice(company.id))}</span>
                </span>
              </div>
            ))}
          </Card>

          {upsells.length > 0 && (
            <Card title="A quién venderle más" subtitle="Según las pantallas que le faltan y los locales que tiene.">
              {upsells.map((u, i) => {
                const c = byId.get(u.companyId);
                const plan = plans[u.companyId]?.plan as Plan | undefined;
                return c ? (
                  <div key={`${u.companyId}-${i}`} className="pa-list-row" style={{ alignItems: "flex-start" }}>
                    <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
                      <span><button type="button" className="pa-link" onClick={() => onOpenClient(c.id)}>{c.name}</button> · <b>{u.offer}</b></span>
                      <span className="pa-muted" style={{ fontSize: 13 }}>{u.reason}</span>
                    </span>
                    {plan && <Badge tone="brand" dot={false}>{PLAN_LABELS[plan]}</Badge>}
                  </div>
                ) : null;
              })}
            </Card>
          )}

          <Card title="Bajar a Excel">
            <div className="pa-row">
              <Button variant="secondary" icon={Download} onClick={exportClients}>Clientes</Button>
              <Select aria-label="Mes de los pagos" value={exportMonth} onChange={(e) => setExportMonth(e.target.value)} style={{ width: "auto" }}>
                {(monthOptions.length ? monthOptions : [today.slice(0, 7)]).map((m) => (
                  <option key={m} value={m}>{MONTHS_LONG[monthIndex(m)]} {m.slice(0, 4)}</option>
                ))}
              </Select>
              <Button variant="secondary" icon={Download} loading={exporting} onClick={() => void exportPayments()}>Pagos del mes</Button>
            </div>
          </Card>
        </div>
      </div>

      <div className="pa-sum-grid">
        <Card
          title="Qué usan tus clientes"
          subtitle={`Cuántos clientes usaron cada pantalla en los últimos 30 días${summary?.usageSince ? ` (se registra desde el ${formatDayMonth(summary.usageSince)})` : ""}.`}
        >
          {!summary && <Skeleton lines={4} />}
          {summary && summary.usage30d.length === 0 && <span className="pa-muted">Todavía no hay datos: se empieza a contar a medida que tus clientes usan el sistema.</span>}
          {summary?.usage30d.map((u) => (
            <div key={u.page} className="pa-bar">
              <span>{pageLabel(u.page)}</span>
              <div className="pa-bar-track"><div style={{ width: `${Math.round((u.companies / usageMax) * 100)}%` }} /></div>
              <span className="pa-muted pa-num">{u.companies} / {active.length}</span>
            </div>
          ))}
        </Card>

        <Card title="Lo que el chat de ayuda no supo contestar" subtitle="Últimos 7 días · dónde se traban tus clientes">
          {!summary && <Skeleton lines={3} />}
          {summary && summary.unanswered7d.length === 0 && <span className="pa-muted">Ninguna pregunta sin respuesta esta semana.</span>}
          {summary?.unanswered7d.map((q, i) => (
            <div key={i} className="pa-list-row" title={q.companies.join(", ")}>
              <span style={{ flex: 1, minWidth: 0 }}>“{q.question}”{q.companies.length ? <span className="pa-muted"> · {q.companies.slice(0, 2).join(", ")}{q.companies.length > 2 ? "…" : ""}</span> : null}</span>
              <Badge tone="brand" dot={false}>{q.count} {q.count === 1 ? "vez" : "veces"}</Badge>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
