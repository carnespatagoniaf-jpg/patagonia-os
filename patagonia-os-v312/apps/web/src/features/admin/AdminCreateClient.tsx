import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Building2, LockKeyhole, MapPin, Plus, Search } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import {
  PROVINCES, createClient, deleteClient, deleteCompanyPayment, listCompanies, listCompanyPayments, listCompanyPlans, registerCompanyPayment,
  setCompanyActive, setCompanyLocation, setCompanyPaidUntil, setCompanyPlan, setCompanyTrial,
  type CompanyPayment, type CompanyPlanInfo, type CompanySummary, type CreateClientResult
} from "./admin-service";
import { PLAN_LABELS, PLAN_LIMITS, type Plan } from "../auth/permissions";
import { billingLabel, billingStatus, formatDayMonth, matchesBillingFilter, matchesCompanySearch, sortByBilling, type BillingFilter, type BillingStatus } from "./company-billing";
import { todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";

const PLAN_OPTIONS: Plan[] = ["basico", "estandar", "full"];
const PLAN_PRICES: Record<Plan, string> = { basico: "$20.000", estandar: "$39.000", full: "$69.000" };
const PLAN_PRICE_VALUES: Record<Plan, number> = { basico: 20000, estandar: 39000, full: 69000 };
const MONTH_OPTIONS = [1, 2, 3, 6, 12];

const BILLING_TONE: Record<BillingStatus, string> = {
  paid: "admin-trial-ok",
  due_soon: "admin-trial-soon",
  overdue: "admin-trial-expired",
  trial: "admin-trial-trial",
  trial_expired: "admin-trial-expired",
  none: "admin-trial-none"
};

type SortMode = "status" | "number" | "province";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

/** Mensaje listo para pegar en WhatsApp/mail y mandarle al dueño nuevo --
 * evita tener que copiar el usuario y la contraseña por separado a mano. */
function buildWelcomeMessage(companyName: string, result: CreateClientResult) {
  return `¡Hola! Ya está listo el acceso a Patagonia OS para ${companyName}.

Entrá en: https://app.patagoniasystem.com.ar
Usuario: ${result.email}
Contraseña temporal: ${result.tempPassword}

Te recomendamos cambiarla la primera vez que entres (arriba a la izquierda, "Cambiar contraseña").`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR");
}

interface Draft {
  companyName: string;
  branchName: string;
  ownerFullName: string;
  ownerEmail: string;
  contactPhone: string;
  province: string;
  city: string;
  plan: Plan;
}

function emptyDraft(): Draft {
  return { companyName: "", branchName: "", ownerFullName: "", ownerEmail: "", contactPhone: "", province: "", city: "", plan: "estandar" };
}

const NO_LOCATION = "Sin ubicación";
const TRIAL_DAYS = 7;
const DAY_MS = 86_400_000;

/** null = sin vencimiento (cliente pago o excepción). */
function trialDaysLeft(company: CompanySummary): number | null {
  if (!company.trialEndsAt) return null;
  return Math.ceil((new Date(company.trialEndsAt).getTime() - Date.now()) / DAY_MS);
}

function trialLabel(days: number) {
  if (days <= 0) return "Prueba vencida";
  return days === 1 ? "Prueba: vence mañana" : `Prueba: ${days} días`;
}

function trialTone(days: number) {
  return days <= 0 ? "admin-trial-expired" : days <= 2 ? "admin-trial-soon" : "admin-trial-ok";
}

function groupByProvince(list: CompanySummary[]) {
  const map = new Map<string, CompanySummary[]>();
  for (const c of list) {
    const key = c.province ?? NO_LOCATION;
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  return Array.from(map).sort(([a], [b]) => (a === NO_LOCATION ? 1 : b === NO_LOCATION ? -1 : a.localeCompare(b, "es")));
}

export function AdminCreateClient() {
  const { signOut } = useAuth();
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateClientResult | null>(null);
  const [resultCompanyName, setResultCompanyName] = useState("");
  const [copied, setCopied] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");

  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [editProvince, setEditProvince] = useState("");
  const [editCity, setEditCity] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);
  const [trialBusyId, setTrialBusyId] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, CompanyPlanInfo>>({});
  const [planBusyId, setPlanBusyId] = useState<string | null>(null);

  const [billingFilter, setBillingFilter] = useState<BillingFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("status");
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payMonths, setPayMonths] = useState(1);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(todayIso());
  const [payNote, setPayNote] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<CompanyPayment[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editPaidUntil, setEditPaidUntil] = useState("");

  const reloadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    try {
      setCompanies(await listCompanies());
      try {
        setPlans(await listCompanyPlans());
      } catch {
        // Base sin la migración 101 todavía: la lista de clientes igual se ve.
        setPlans({});
      }
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadCompanies();
  }, [reloadCompanies]);

  async function toggleActive(company: CompanySummary) {
    setTogglingId(company.id);
    try {
      await setCompanyActive(company.id, !company.active);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar el cliente.");
    } finally {
      setTogglingId(null);
    }
  }

  async function changePlan(company: CompanySummary, plan: Plan) {
    const info = plans[company.id];
    const limits = PLAN_LIMITS[plan];
    const overBranches = info && limits.maxBranches !== null && info.activeBranches > limits.maxBranches;
    const overUsers = info && limits.maxUsers !== null && info.activeUsers > limits.maxUsers;
    if (overBranches || overUsers) {
      const detail = [
        overBranches ? `${info.activeBranches} sucursales (el plan permite ${limits.maxBranches})` : "",
        overUsers ? `${info.activeUsers} usuarios (el plan permite ${limits.maxUsers})` : ""
      ].filter(Boolean).join(" y ");
      if (!window.confirm(`${company.name} tiene ${detail}. No se borra ni se desactiva nada: solo no va a poder agregar más. ¿Pasarlo igual a ${PLAN_LABELS[plan]}?`)) return;
    }
    setPlanBusyId(company.id);
    try {
      await setCompanyPlan(company.id, plan);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo cambiar el plan.");
    } finally {
      setPlanBusyId(null);
    }
  }

  async function changeTrial(company: CompanySummary, trialEndsAt: Date | null) {
    setTrialBusyId(company.id);
    try {
      await setCompanyTrial(company.id, trialEndsAt ? trialEndsAt.toISOString() : null);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar la prueba.");
    } finally {
      setTrialBusyId(null);
    }
  }

  function planPrice(companyId: string) {
    const plan = plans[companyId]?.plan;
    return plan ? PLAN_PRICE_VALUES[plan] : 0;
  }

  function openPayment(company: CompanySummary) {
    setHistoryId(null);
    setPayingId(company.id);
    setPayMonths(1);
    const price = planPrice(company.id);
    setPayAmount(price ? String(price) : "");
    setPayDate(todayIso());
    setPayNote("");
  }

  function changePayMonths(company: CompanySummary, months: number) {
    setPayMonths(months);
    const price = planPrice(company.id);
    if (price) setPayAmount(String(price * months));
  }

  async function savePayment(company: CompanySummary) {
    const amount = payAmount.trim() ? parseAmount(payAmount) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
      setMessage("El monto no es válido.");
      return;
    }
    setPayBusy(true);
    setMessage("");
    try {
      const until = await registerCompanyPayment({ companyId: company.id, months: payMonths, amount, paymentDate: payDate || undefined, note: payNote.trim() || undefined });
      setPayingId(null);
      setMessage(`Pago registrado: ${company.name} queda pagado hasta el ${formatDayMonth(until)}.`);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo registrar el pago.");
    } finally {
      setPayBusy(false);
    }
  }

  async function openHistory(company: CompanySummary) {
    setPayingId(null);
    if (historyId === company.id) {
      setHistoryId(null);
      return;
    }
    setHistoryId(company.id);
    setEditPaidUntil(company.paidUntil ?? "");
    setHistory([]);
    setHistoryLoading(true);
    try {
      setHistory(await listCompanyPayments(company.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudieron cargar los pagos.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function removeLastPayment(company: CompanySummary, payment: CompanyPayment) {
    const amountText = payment.amount !== null ? ` por ${formatMoney(payment.amount)}` : "";
    if (!window.confirm(`¿Borrar el pago del ${formatDayMonth(payment.paymentDate)}${amountText}? La fecha de "pagado hasta" vuelve a la que tenía antes.`)) return;
    setPayBusy(true);
    try {
      await deleteCompanyPayment(payment.id);
      await reloadCompanies();
      setHistory(await listCompanyPayments(company.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo borrar el pago.");
    } finally {
      setPayBusy(false);
    }
  }

  async function savePaidUntil(company: CompanySummary, value: string | null) {
    setPayBusy(true);
    try {
      await setCompanyPaidUntil(company.id, value);
      setEditPaidUntil(value ?? "");
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar la fecha.");
    } finally {
      setPayBusy(false);
    }
  }

  function startEditLocation(company: CompanySummary) {
    setEditingLocationId(company.id);
    setEditProvince(company.province ?? "");
    setEditCity(company.city ?? "");
  }

  async function saveLocation(company: CompanySummary) {
    setSavingLocation(true);
    try {
      await setCompanyLocation(company.id, editProvince, editCity);
      setEditingLocationId(null);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar la ubicación.");
    } finally {
      setSavingLocation(false);
    }
  }

  /** Borrado real (no desactivar) -- el servidor ya rechaza esto solo si la
   * empresa tiene cualquier actividad real cargada, así que acá solo hace
   * falta la confirmación de "estás seguro" antes de intentarlo. */
  async function handleDeleteClient(company: CompanySummary) {
    if (!window.confirm(`¿Borrar "${company.name}" para siempre? Esto no se puede deshacer. Si ya tiene productos, ventas o cualquier otro dato cargado, el sistema va a rechazar el borrado solo.`)) {
      return;
    }
    setMessage("");
    setDeletingId(company.id);
    try {
      await deleteClient(company.id);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo borrar el cliente.");
    } finally {
      setDeletingId(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    if (!draft.companyName.trim()) { setMessage("Ingresá el nombre del negocio."); return; }
    if (!draft.branchName.trim()) { setMessage("Ingresá el nombre de la primera sucursal."); return; }
    if (!draft.ownerFullName.trim()) { setMessage("Ingresá el nombre del dueño."); return; }
    if (!draft.ownerEmail.trim()) { setMessage("Ingresá el email del dueño."); return; }

    setBusy(true);
    try {
      const created = await createClient({
        companyName: draft.companyName.trim(),
        branchName: draft.branchName.trim(),
        ownerFullName: draft.ownerFullName.trim(),
        ownerEmail: draft.ownerEmail.trim(),
        contactPhone: draft.contactPhone.trim() || undefined
      });
      try {
        await setCompanyPlan(created.companyId, draft.plan);
      } catch {
        setMessage("El cliente se creó, pero no se pudo guardar el plan. Elegilo desde su tarjeta.");
      }
      if (draft.province || draft.city.trim()) {
        try {
          await setCompanyLocation(created.companyId, draft.province, draft.city);
        } catch {
          setMessage("El cliente se creó, pero no se pudo guardar la ubicación. Cargala desde la lista.");
        }
      }
      setResult(created);
      setResultCompanyName(draft.companyName.trim());
      setCopied(false);
      setDraft(emptyDraft());
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo crear el cliente.");
    } finally {
      setBusy(false);
    }
  }

  const today = todayIso();
  const matches = (c: CompanySummary) => matchesCompanySearch(c, search);
  const statusOf = (c: CompanySummary) => billingStatus(c, today);

  const activeCompanies = useMemo(() => companies.filter((c) => c.active), [companies]);
  const inactiveCompanies = companies.filter((c) => !c.active && matches(c));
  const visibleActive = activeCompanies.filter((c) => matches(c) && matchesBillingFilter(statusOf(c), billingFilter));
  const activeGroups = groupByProvince(visibleActive);
  const sortedActive =
    sortMode === "number" ? [...visibleActive].sort((a, b) => (a.clientNumber ?? 0) - (b.clientNumber ?? 0)) : sortByBilling(visibleActive, today);
  const billingCounts = { all: activeCompanies.length, paid: 0, owes: 0, trial: 0, none: 0 };
  for (const c of activeCompanies) {
    for (const f of ["paid", "owes", "trial", "none"] as const) if (matchesBillingFilter(statusOf(c), f)) billingCounts[f] += 1;
  }
  const trialAlerts = activeCompanies
    .filter((c) => !c.paidUntil)
    .map((c) => ({ company: c, days: trialDaysLeft(c) }))
    .filter((x): x is { company: CompanySummary; days: number } => x.days !== null && x.days <= 2)
    .sort((a, b) => a.days - b.days);

  function renderCard(company: CompanySummary) {
    const editing = editingLocationId === company.id;
    return (
      <article key={company.id} className={`admin-card admin-card-${statusOf(company)}${company.active ? "" : " admin-card-off"}`}>
        <header className="admin-card-head">
          <h3>
            {company.clientNumber !== undefined && <span className="admin-client-number">N.º {company.clientNumber}</span>}
            {company.name}
          </h3>
          {editing ? null : (
            <button className="admin-link" onClick={() => startEditLocation(company)}>
              <MapPin size={13} />
              {[company.city, company.province].filter(Boolean).join(", ") || "Agregar ubicación"}
            </button>
          )}
        </header>

        {editing && (
          <div className="admin-edit-location">
            <select value={editProvince} onChange={(e) => setEditProvince(e.target.value)}>
              <option value="">Provincia…</option>
              {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input placeholder="Ciudad" value={editCity} onChange={(e) => setEditCity(e.target.value)} />
            <div className="admin-actions">
              <button disabled={savingLocation} onClick={() => void saveLocation(company)}>{savingLocation ? "…" : "Guardar"}</button>
              <button className="secondary" onClick={() => setEditingLocationId(null)}>Cancelar</button>
            </div>
          </div>
        )}

        <dl className="admin-card-data">
          <div><dt>Dueño</dt><dd>{company.ownerFullName ?? "-"}</dd></div>
          <div><dt>Email</dt><dd>{company.ownerEmail ?? "-"}</dd></div>
          <div><dt>Teléfono</dt><dd>{company.contactPhone ?? "-"}</dd></div>
        </dl>

        <div className="admin-trial-row">
          <span className={`admin-trial ${BILLING_TONE[statusOf(company)]}`}>{billingLabel(company, today)}</span>
          <div className="admin-actions">
            <button disabled={payBusy} onClick={() => (payingId === company.id ? setPayingId(null) : openPayment(company))}>
              {payingId === company.id ? "Cancelar" : "Registrar pago"}
            </button>
            <button className="secondary" onClick={() => void openHistory(company)}>{historyId === company.id ? "Cerrar" : "Pagos"}</button>
          </div>
        </div>
        {company.lastPaymentDate && (
          <span className="muted" style={{ fontSize: 12 }}>
            Último pago: {formatDayMonth(company.lastPaymentDate)}
            {company.lastPaymentAmount !== null ? ` · ${formatMoney(company.lastPaymentAmount)}` : ""}
          </span>
        )}

        {payingId === company.id && (
          <div className="admin-edit-location">
            <label className="admin-pay-field">
              Meses que paga
              <select value={payMonths} onChange={(e) => changePayMonths(company, Number(e.target.value))}>
                {MONTH_OPTIONS.map((m) => <option key={m} value={m}>{m} {m === 1 ? "mes" : "meses"}</option>)}
              </select>
            </label>
            <label className="admin-pay-field">
              Monto (opcional)
              <input type="text" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="$" />
            </label>
            <label className="admin-pay-field">
              Fecha del pago
              <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </label>
            <input placeholder="Nota (ej. transferencia, efectivo)" value={payNote} onChange={(e) => setPayNote(e.target.value)} />
            <span className="muted" style={{ fontSize: 12 }}>
              Se suma a partir de {company.paidUntil && company.paidUntil >= today ? `su vencimiento (${formatDayMonth(company.paidUntil)})` : "hoy"}.
              {company.trialEndsAt ? " Se le saca el aviso de prueba gratuita." : ""}
            </span>
            <div className="admin-actions">
              <button disabled={payBusy} onClick={() => void savePayment(company)}>{payBusy ? "…" : "Guardar pago"}</button>
            </div>
          </div>
        )}

        {historyId === company.id && (
          <div className="admin-edit-location">
            {historyLoading && <span className="muted">Cargando…</span>}
            {!historyLoading && history.length === 0 && <span className="muted">Todavía no hay pagos registrados.</span>}
            {history.map((payment, index) => (
              <div key={payment.id} className="admin-pay-history-row">
                <span>
                  <b>{formatDayMonth(payment.paymentDate)}</b> · {payment.months} {payment.months === 1 ? "mes" : "meses"}
                  {payment.amount !== null ? ` · ${formatMoney(payment.amount)}` : ""} · hasta {formatDayMonth(payment.paidUntil)}
                  {payment.note ? ` · ${payment.note}` : ""}
                </span>
                {index === 0 && (
                  <button className="admin-link" disabled={payBusy} onClick={() => void removeLastPayment(company, payment)}>Borrar</button>
                )}
              </div>
            ))}
            <label className="admin-pay-field">
              Corregir “pagado hasta”
              <input type="date" value={editPaidUntil} onChange={(e) => setEditPaidUntil(e.target.value)} />
            </label>
            <div className="admin-actions">
              <button className="secondary" disabled={payBusy || !editPaidUntil} onClick={() => void savePaidUntil(company, editPaidUntil)}>Guardar fecha</button>
              {company.paidUntil && (
                <button className="secondary" disabled={payBusy} onClick={() => void savePaidUntil(company, null)}>Dejar sin pago</button>
              )}
            </div>
          </div>
        )}

        {!company.paidUntil && (() => {
          const days = trialDaysLeft(company);
          const busy = trialBusyId === company.id;
          return (
            <div className="admin-trial-row">
              <span className="muted" style={{ fontSize: 13 }}>Prueba gratuita</span>
              <div className="admin-actions">
                {days === null ? (
                  <button className="secondary" disabled={busy} onClick={() => void changeTrial(company, new Date(Date.now() + TRIAL_DAYS * DAY_MS))}>
                    Iniciar prueba de {TRIAL_DAYS} días
                  </button>
                ) : (
                  <>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void changeTrial(company, new Date(Math.max(Date.now(), new Date(company.trialEndsAt!).getTime()) + TRIAL_DAYS * DAY_MS))}
                    >
                      +{TRIAL_DAYS} días
                    </button>
                    <button className="secondary" disabled={busy} onClick={() => void changeTrial(company, null)}>Quitar prueba</button>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {plans[company.id] && (() => {
          const info = plans[company.id];
          const limits = PLAN_LIMITS[info.plan];
          const limitText = (count: number, max: number | null, one: string, many: string) =>
            `${count}${max !== null ? `/${max}` : ""} ${count === 1 && max === null ? one : many}`;
          return (
            <div className="admin-trial-row">
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong>Plan</strong>
                <select value={info.plan} disabled={planBusyId === company.id} onChange={(e) => void changePlan(company, e.target.value as Plan)}>
                  {PLAN_OPTIONS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]} ({PLAN_PRICES[p]})</option>)}
                </select>
              </label>
              <span className="muted" style={{ fontSize: 13 }}>
                {limitText(info.activeBranches, limits.maxBranches, "sucursal", "sucursales")} · {limitText(info.activeUsers, limits.maxUsers, "usuario", "usuarios")}
              </span>
            </div>
          );
        })()}

        <div className="admin-chips">
          <span>{company.branchCount} {company.branchCount === 1 ? "sucursal" : "sucursales"}</span>
          <span>{company.userCount} {company.userCount === 1 ? "usuario" : "usuarios"}</span>
          <span>Alta {formatDate(company.createdAt)}</span>
        </div>

        <div className="admin-actions">
          <button className="secondary" disabled={togglingId === company.id} onClick={() => void toggleActive(company)}>
            {togglingId === company.id ? "…" : company.active ? "Desactivar" : "Activar"}
          </button>
          <button className="danger" disabled={deletingId === company.id} onClick={() => void handleDeleteClient(company)}>
            {deletingId === company.id ? "…" : "Borrar"}
          </button>
        </div>
      </article>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div className="admin-brand">
          <div className="login-logo" style={{ margin: 0 }}><LockKeyhole /></div>
          <div>
            <p className="eyebrow">PATAGONIA OS · ADMIN</p>
            <h1>Clientes</h1>
          </div>
        </div>
        <div className="admin-actions">
          <button onClick={() => { setShowForm((v) => !v); setResult(null); }}>
            <Plus size={16} style={{ verticalAlign: "-3px" }} /> {showForm ? "Cerrar" : "Nuevo cliente"}
          </button>
          <button className="secondary" onClick={() => void signOut()}>Salir</button>
        </div>
      </header>

      <div className="admin-kpis">
        <div className="kpi-card"><span>Clientes activos</span><strong>{activeCompanies.length}</strong></div>
        <div className="kpi-card"><span>Pagaron</span><strong>{billingCounts.paid}</strong></div>
        <div className="kpi-card"><span>Deben</span><strong>{billingCounts.owes}</strong></div>
        <div className="kpi-card"><span>En prueba</span><strong>{billingCounts.trial}</strong></div>
      </div>

      {(showForm || result) && (
        <section className="panel admin-form-panel">
          <div className="panel-title">
            <h2>{result ? "Cliente creado" : "Dar de alta un cliente"}</h2>
          </div>
          {result ? (
            <div className="message" style={{ borderColor: "#2f9e44" }}>
              Login del dueño: <strong>{result.email}</strong>
              <br />
              Contraseña temporal (copiala ahora, no se vuelve a mostrar):{" "}
              <code style={{ fontSize: 16, fontWeight: 700 }}>{result.tempPassword}</code>
              <div className="admin-actions" style={{ marginTop: 10 }}>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(buildWelcomeMessage(resultCompanyName, result));
                    setCopied(true);
                  }}
                >
                  {copied ? "¡Copiado!" : "Copiar mensaje para el cliente"}
                </button>
                <button className="secondary" onClick={() => setResult(null)}>Crear otro cliente</button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="admin-form">
              <label>Nombre del negocio<input value={draft.companyName} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} required /></label>
              <label>Nombre de la primera sucursal<input value={draft.branchName} onChange={(e) => setDraft({ ...draft, branchName: e.target.value })} required /></label>
              <label>Nombre del dueño<input value={draft.ownerFullName} onChange={(e) => setDraft({ ...draft, ownerFullName: e.target.value })} required /></label>
              <label>Email del dueño<input value={draft.ownerEmail} onChange={(e) => setDraft({ ...draft, ownerEmail: e.target.value })} type="email" required /></label>
              <label>
                Provincia (opcional)
                <select value={draft.province} onChange={(e) => setDraft({ ...draft, province: e.target.value })}>
                  <option value="">Sin especificar</option>
                  {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label>Ciudad (opcional)<input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} /></label>
              <label>
                Plan
                <select value={draft.plan} onChange={(e) => setDraft({ ...draft, plan: e.target.value as Plan })}>
                  {PLAN_OPTIONS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]} ({PLAN_PRICES[p]})</option>)}
                </select>
              </label>
              <label>Teléfono de contacto (opcional, uso interno)<input value={draft.contactPhone} onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} /></label>
              <div className="admin-form-submit">
                <button className="charge-button" disabled={busy}>{busy ? "Creando…" : "Crear cliente"}</button>
              </div>
            </form>
          )}
        </section>
      )}

      {message && <div className="message warning">{message}</div>}

      {trialAlerts.length > 0 && (
        <section className="admin-trial-alert">
          <strong>Prueba gratuita por vencer o vencida</strong>
          <ul>
            {trialAlerts.map(({ company, days }) => (
              <li key={company.id}>
                <span className={`admin-trial ${trialTone(days)}`}>{trialLabel(days)}</span> {company.name}
                {company.contactPhone ? ` · ${company.contactPhone}` : ""}
                {company.ownerEmail ? ` · ${company.ownerEmail}` : ""}
              </li>
            ))}
          </ul>
          <span className="muted">No se bloquea nada al vencer: podés extender los días o dejarlo sin vencimiento desde cada tarjeta.</span>
        </section>
      )}


      <div className="admin-search">
        <Search size={16} />
        <input placeholder="Buscar por número, negocio, dueño, mail, teléfono, ciudad o provincia" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="admin-filters">
        <div className="admin-actions">
          {(
            [
              ["all", `Todos (${billingCounts.all})`],
              ["owes", `Deben (${billingCounts.owes})`],
              ["paid", `Pagaron (${billingCounts.paid})`],
              ["trial", `En prueba (${billingCounts.trial})`],
              ["none", `Sin pagos (${billingCounts.none})`]
            ] as [BillingFilter, string][]
          ).map(([value, label]) => (
            <button key={value} className={billingFilter === value ? "" : "secondary"} onClick={() => setBillingFilter(value)}>{label}</button>
          ))}
        </div>
        <label className="admin-sort">
          Ordenar
          <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
            <option value="status">Primero los que deben</option>
            <option value="number">Por número</option>
            <option value="province">Por provincia</option>
          </select>
        </label>
      </div>

      {companiesLoading && companies.length === 0 && <p className="muted">Cargando…</p>}
      {!companiesLoading && activeCompanies.length === 0 && <p className="muted">Todavía no diste de alta ningún cliente.</p>}
      {!companiesLoading && activeCompanies.length > 0 && visibleActive.length === 0 && <p className="muted">Ningún cliente coincide con la búsqueda o el filtro.</p>}

      {sortMode === "province"
        ? activeGroups.map(([province, group]) => (
            <Fragment key={province}>
              <h2 className="admin-group-title"><Building2 size={16} /> {province} <span>{group.length}</span></h2>
              <div className="admin-grid">{group.map(renderCard)}</div>
            </Fragment>
          ))
        : visibleActive.length > 0 && <div className="admin-grid">{sortedActive.map(renderCard)}</div>}

      {inactiveCompanies.length > 0 && (
        <details className="admin-inactive">
          <summary className="admin-group-title">Clientes desactivados <span>{inactiveCompanies.length}</span></summary>
          <div className="admin-grid" style={{ marginTop: 12 }}>{inactiveCompanies.map(renderCard)}</div>
        </details>
      )}
    </main>
  );
}
