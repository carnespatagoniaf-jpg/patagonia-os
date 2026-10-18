import { useEffect, useMemo, useState } from "react";
import { Download, MessageCircle } from "lucide-react";
import { PLAN_LABELS, PLAN_LIMITS, type Plan } from "../auth/permissions";
import { getPlatformSummary, listPaymentsForAdmin, listSalesPipeline, type CompanyPlanInfo, type CompanySummary, type PlatformSummary } from "./admin-service";
import { billingLabel, formatDayMonth } from "./company-billing";
import { dueSoonList, monthChangePct, pageLabel, riskList, upgradeCandidates } from "./platform-summary";
import type { CompanyUsage } from "./sales-pipeline";
import { whatsappLink } from "./sales-pipeline";
import { downloadCsv, toCsv } from "../../lib/csv";

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

function firstName(full: string | null) {
  return full?.trim().split(/\s+/)[0] ?? "";
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
        <line x1={left} y1={H - bottom} x2={W} y2={H - bottom} stroke="#e5e7eb" />
        {data.map((d, i) => {
          const h = d.amount > 0 ? Math.max(4, (d.amount / max) * plotH) : 0;
          const x = left + i * slot + (slot - barW) / 2;
          const y = H - bottom - h;
          const last = i === data.length - 1;
          return (
            <g key={d.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={left + i * slot} y={top - 18} width={slot} height={plotH + 18} fill="transparent" />
              {h > 0 && <path d={`M${x},${H - bottom} V${y + 4} Q${x},${y} ${x + 4},${y} H${x + barW - 4} Q${x + barW},${y} ${x + barW},${y + 4} V${H - bottom} Z`} fill={last ? "#8b1e1e" : hover === i ? "#b45c5c" : "#d9a7a7"} />}
              {(last || hover === i) && d.amount > 0 && (
                <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize="12" fontWeight="700" fill="#18202b">{shortMoney(d.amount)}</text>
              )}
              <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize="11" fill={last ? "#18202b" : "#697386"} fontWeight={last ? 700 : 400}>
                {MONTHS[monthIndex(d.month)]}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <p className="admin-sum-hint">
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
  today
}: {
  companies: CompanySummary[];
  plans: Record<string, CompanyPlanInfo>;
  planPrice: (companyId: string) => number;
  /** Abono mensual de los que pagan (lo que entra cada mes si nadie se va). */
  monthlyFee: number;
  /** true = suscripción de Mercado Pago al día (se cobra solo). */
  isAutoCharged: (companyId: string) => boolean;
  today: string;
}) {
  const [summary, setSummary] = useState<PlatformSummary | null>(null);
  const [usage, setUsage] = useState<Record<string, CompanyUsage>>({});
  const [error, setError] = useState("");
  const [exportMonth, setExportMonth] = useState(today.slice(0, 7));
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getPlatformSummary().then(setSummary).catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el resumen."));
    listSalesPipeline().then(setUsage).catch(() => setUsage({}));
  }, []);

  const byId = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);
  const active = companies.filter((c) => c.active);
  const paying = active.filter((c) => (c.paidUntil && c.paidUntil >= today) || isAutoCharged(c.id));
  const risks = riskList(companies, usage, today);
  const upgrades = upgradeCandidates(active.map((c) => c.id), plans, PLAN_LIMITS as Record<string, { maxBranches: number | null; maxUsers: number | null }>);
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

  return (
    <div className="admin-sum">
      <div className="admin-sum-export">
        <button className="secondary" onClick={exportClients}><Download size={14} style={{ verticalAlign: "-2px" }} /> Bajar clientes (Excel)</button>
        <span className="admin-sum-export-pay">
          <select value={exportMonth} onChange={(e) => setExportMonth(e.target.value)}>
            {(monthOptions.length ? monthOptions : [today.slice(0, 7)]).map((m) => (
              <option key={m} value={m}>{MONTHS_LONG[monthIndex(m)]} {m.slice(0, 4)}</option>
            ))}
          </select>
          <button className="secondary" disabled={exporting} onClick={() => void exportPayments()}>
            <Download size={14} style={{ verticalAlign: "-2px" }} /> {exporting ? "…" : "Bajar pagos (Excel)"}
          </button>
        </span>
      </div>

      {error && <div className="message warning">{error}</div>}

      <div className="admin-kpis">
        <div className="kpi-card">
          <span>Cobrado en {MONTHS_LONG[Number(today.slice(5, 7)) - 1]}</span>
          <strong>{formatMoney(current)}</strong>
          {change !== null && <small className={change >= 0 ? "admin-sum-up" : "admin-sum-down"}>{change >= 0 ? "▲" : "▼"} {Math.abs(change)}% vs {MONTHS_LONG[(Number(today.slice(5, 7)) + 10) % 12]}</small>}
        </div>
        <div className="kpi-card"><span>Clientes que pagan</span><strong>{paying.length}</strong><small className="muted">de {active.length} activos</small></div>
        <div className="kpi-card">
          <span>Altas / bajas del mes</span>
          <strong>{summary ? `${summary.newThisMonth} / ${summary.lostThisMonth.length}` : "…"}</strong>
          {summary && summary.lostThisMonth.length > 0 && <small className="muted">se fue: {summary.lostThisMonth.join(", ")}</small>}
        </div>
        <div className="kpi-card">
          <span>Pruebas que pasaron a pago</span>
          <strong>{summary ? `${summary.trials60dPaid} de ${summary.trials60d}` : "…"}</strong>
          <small className="muted">altas de los últimos 60 días</small>
        </div>
      </div>

      <div className="admin-sum-grid">
        <section className="panel admin-sum-card">
          <h2>Cobrado mes a mes</h2>
          <p className="muted admin-sum-sub">
            Si nadie se va, en {MONTHS_LONG[nextMonthIdx]} cobrás <b>{formatMoney(monthlyFee)}</b>.
          </p>
          {monthly.length > 0 ? <MonthlyChart data={monthly} /> : <p className="muted">Cargando…</p>}
          {monthly.length > 0 && monthly[0].amount === 0 && (
            <p className="muted admin-sum-sub">Los meses en 0 son de antes de que se empezaran a anotar los pagos en el panel.</p>
          )}
        </section>

        <div className="admin-sum-stack">
          <section className="panel admin-sum-card">
            <h2>Vencen esta semana</h2>
            {dueSoon.length === 0 ? (
              <p className="muted admin-sum-sub">Nadie vence en los próximos 7 días (los que pagan por suscripción se cobran solos).</p>
            ) : (
              dueSoon.map(({ company, days }) => (
                <div key={company.id} className="admin-mp-row">
                  <span><b>{company.name}</b> · {days === 0 ? "vence hoy" : days === 1 ? "vence mañana" : `vence en ${days} días`} · {formatMoney(planPrice(company.id))}</span>
                </div>
              ))
            )}
          </section>

          <section className="panel admin-sum-card">
            <h2>Clientes en riesgo</h2>
            {risks.length === 0 ? (
              <p className="muted admin-sum-sub">Todos usan el sistema. 👍</p>
            ) : (
              risks.map((r) => {
                const c = byId.get(r.companyId);
                if (!c) return null;
                const link = whatsappLink(c.contactPhone, `¡Hola${firstName(c.ownerFullName) ? ` ${firstName(c.ownerFullName)}` : ""}! Te escribo de Patagonia OS. Vi que hace unos días no usás el sistema, ¿está todo bien? ¿Te puedo ayudar con algo?`);
                return (
                  <div key={r.companyId} className="admin-mp-row admin-mp-problem">
                    <span><b>{c.name}</b> · {r.reason}</span>
                    {link && <a className="sales-wa-button" href={link} target="_blank" rel="noreferrer"><MessageCircle size={14} /> Escribirle</a>}
                  </div>
                );
              })
            )}
          </section>

          {upgrades.length > 0 && (
            <section className="panel admin-sum-card">
              <h2>Podrían subir de plan</h2>
              {upgrades.map((u) => {
                const c = byId.get(u.companyId);
                const plan = plans[u.companyId]?.plan as Plan | undefined;
                return c ? (
                  <div key={u.companyId} className="admin-mp-row">
                    <span><b>{c.name}</b> · {plan ? PLAN_LABELS[plan] : ""}: {u.reason}</span>
                  </div>
                ) : null;
              })}
            </section>
          )}
        </div>
      </div>

      <div className="admin-sum-grid">
        <section className="panel admin-sum-card">
          <h2>Qué usan tus clientes</h2>
          <p className="muted admin-sum-sub">
            Cuántos clientes usaron cada pantalla en los últimos 30 días
            {summary?.usageSince ? ` (se registra desde el ${formatDayMonth(summary.usageSince)})` : ""}.
          </p>
          {summary && summary.usage30d.length === 0 && <p className="muted">Todavía no hay datos: se empieza a contar a medida que tus clientes usan el sistema.</p>}
          {summary?.usage30d.map((u) => (
            <div key={u.page} className="admin-sum-bar">
              <span>{pageLabel(u.page)}</span>
              <div className="admin-sum-track"><div style={{ width: `${Math.round((u.companies / usageMax) * 100)}%` }} /></div>
              <span className="muted">{u.companies} / {active.length}</span>
            </div>
          ))}
        </section>

        <section className="panel admin-sum-card">
          <h2>Lo que el chat de ayuda no supo contestar</h2>
          <p className="muted admin-sum-sub">Últimos 7 días · dónde se traban tus clientes</p>
          {summary && summary.unanswered7d.length === 0 && <p className="muted">Ninguna pregunta sin respuesta esta semana.</p>}
          {summary?.unanswered7d.map((q, i) => (
            <div key={i} className="admin-mp-row" title={q.companies.join(", ")}>
              <span>“{q.question}”{q.companies.length ? <span className="muted"> · {q.companies.slice(0, 2).join(", ")}{q.companies.length > 2 ? "…" : ""}</span> : null}</span>
              <b className="admin-sum-count">{q.count} {q.count === 1 ? "vez" : "veces"}</b>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
