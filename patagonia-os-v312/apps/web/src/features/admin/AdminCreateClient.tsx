import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, KeyRound, LayoutDashboard, LifeBuoy, LogOut, MapPin, MessageCircle, Plus, Trash2, TrendingUp, Users, Wallet } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import {
  COMPANY_FEATURES, PROVINCES, createClient, deleteClient, deleteCompanyPayment, listCompanies, listCompanyFeatures, listCompanyPayments, listCompanyPlans, registerCompanyPayment,
  setCompanyActive, setCompanyFeature, setCompanyLocation, setCompanyPaidUntil, setCompanyPlan, setCompanyTrial, listSalesPipeline,
  listScaleSupportReports, resetUserPassword, saveLead, type CompanyPayment, type CompanyPlanInfo, type CompanySummary, type CreateClientResult
} from "./admin-service";
import { PLAN_LABELS, PLAN_LIMITS, type Plan } from "../auth/permissions";
import { billingLabel, billingReminderMessage, billingStatus, formatDayMonth, revenueSummary, matchesBillingFilter, matchesCompanySearch, STATUS_ORDER, type BillingStatus } from "./company-billing";
import type { CompanyUsage } from "./sales-pipeline";
import { AdminThemeRoot } from "./ui/theme";
import { Alert, Badge, BrandMark, Button, Checkbox, Field, Input, Kpi, Modal, Select, Skeleton, Tabs, ThemeToggle, useConfirm, type Tone } from "./ui/components";
import { DataTable, type Column, type TableFilter } from "./ui/DataTable";
import { BRAND } from "../../lib/brand";
import { todayIso } from "../shifts/format";
import { grantScaleSupportAccess, listScaleSupportAccess, revokeScaleSupportAccess } from "../scales/support-access";
import { parseAmount } from "../../lib/money";
import { AdminSalesPipeline } from "./AdminSalesPipeline";
import { whatsappLink, type Lead } from "./sales-pipeline";
import { AdminScaleReports } from "./AdminScaleReports";
import { AdminMercadoPago } from "./AdminMercadoPago";
import { AdminSummary } from "./AdminSummary";
import { AdminDailyChecks } from "./AdminDailyChecks";
import { AdminContacts } from "./AdminContacts";
import { AdminFinance } from "./AdminFinance";
import { mpFailedChargeMessage, mpProblem, toArDate, type MpSubscription } from "./mercadopago";

/** Planes que se ofrecen hoy. Básico ya no se vende (dueño, 03/11/2026): solo aparece en un cliente que todavía lo tiene. */
const PLAN_OPTIONS: Plan[] = ["estandar", "full", "empresa", "planta"];
/** Todos cuestan lo mismo por local; los planes solo cambian las pantallas que incluyen (dueño, 03/11/2026). */
const PRICE_PER_LOCAL = "$39.000 por local";
function planOptionsFor(current?: Plan): Plan[] {
  return current && !PLAN_OPTIONS.includes(current) ? [current, ...PLAN_OPTIONS] : PLAN_OPTIONS;
}
const PLAN_PRICE_VALUES: Record<Plan, number> = { basico: 20000, estandar: 39000, full: 69000, empresa: 0, planta: 0 };
const MONTH_OPTIONS = [1, 2, 3, 6, 12];

const BILLING_TONE: Record<BillingStatus, Tone> = {
  paid: "ok",
  due_soon: "warn",
  overdue: "danger",
  trial: "info",
  trial_expired: "danger",
  none: "neutral"
};

type AdminTab = "resumen" | "clientes" | "ventas" | "contactos" | "finanzas" | "soporte";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

/** Mensaje listo para pegar en WhatsApp/mail y mandarle al dueño nuevo --
 * evita tener que copiar el usuario y la contraseña por separado a mano. */
function buildWelcomeMessage(companyName: string, result: CreateClientResult) {
  return `¡Hola! Ya está listo el acceso a ${BRAND.name} para ${companyName}.

Entrá en: ${BRAND.appUrl}
Usuario: ${result.email}
Contraseña temporal: ${result.tempPassword}

Te recomendamos cambiarla la primera vez que entres (arriba a la izquierda, "Cambiar contraseña").`;
}

/** Mensaje para mandarle al dueño su contraseña nueva. */
function passwordMessage(company: CompanySummary, password: string) {
  // \s = espacio. Antes decía /s+/ y cortaba el nombre en la primera "s" ("Marcos" → "Marco").
  const name = company.ownerFullName?.trim().split(/\s+/)[0];
  return `¡Hola${name ? ` ${name}` : ""}! Te dejo una contraseña nueva para entrar a ${BRAND.name}.

Entrá en: ${BRAND.appUrl}
Usuario: ${company.ownerEmail ?? ""}
Contraseña: ${password}

Cuando entres cambiala por una tuya (arriba a la izquierda, "Cambiar contraseña").`;
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

export function AdminCreateClient() {
  const { signOut } = useAuth();
  const [ask, confirmDialog] = useConfirm();
  /** Cliente con la ficha abierta. */
  const [detailId, setDetailId] = useState<string | null>(null);
  /** Uso real de cada cliente (última venta, ventas de la semana, último ingreso), el mismo dato que usa Ventas. */
  const [usage, setUsage] = useState<Record<string, CompanyUsage>>({});
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateClientResult | null>(null);
  const [resultCompanyName, setResultCompanyName] = useState("");
  const [copied, setCopied] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState<AdminTab>("resumen");
  /** Interesado del embudo de ventas que se está dando de alta con el formulario. */
  const [leadForForm, setLeadForForm] = useState<Lead | null>(null);
  const [pipelineReloadKey, setPipelineReloadKey] = useState(0);

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
  /** Pantallas a pedido de cada empresa (companies.features, migración 169). */
  const [features, setFeatures] = useState<Record<string, string[]>>({});
  const [featureBusyId, setFeatureBusyId] = useState<string | null>(null);
  /** Acceso de soporte a las herramientas técnicas de balanza (migración 120): empresa → vence. */
  const [supportAccess, setSupportAccess] = useState<Record<string, string>>({});
  const [supportBusyId, setSupportBusyId] = useState<string | null>(null);

  useEffect(() => {
    void listScaleSupportAccess().then(setSupportAccess);
  }, []);

  async function toggleSupportAccess(company: CompanySummary) {
    setSupportBusyId(company.id);
    try {
      if (supportAccess[company.id]) {
        await revokeScaleSupportAccess(company.id);
        const next = { ...supportAccess };
        delete next[company.id];
        setSupportAccess(next);
      } else {
        const until = await grantScaleSupportAccess(company.id, 2, "sesión de soporte de balanza");
        setSupportAccess({ ...supportAccess, [company.id]: until });
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cambiar el acceso de soporte.");
    } finally {
      setSupportBusyId(null);
    }
  }

  const [payingId, setPayingId] = useState<string | null>(null);
  const [payMonths, setPayMonths] = useState(1);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(todayIso());
  const [payNote, setPayNote] = useState("");
  /** Pase libre: se extiende el "pagado hasta" sin cobro (no suma plata en Finanzas). */
  const [payFree, setPayFree] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<CompanyPayment[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editPaidUntil, setEditPaidUntil] = useState("");
  /** Contraseña temporal recién generada (se muestra una sola vez). */
  const [newPassword, setNewPassword] = useState<{ companyId: string; password: string } | null>(null);
  const [passwordBusyId, setPasswordBusyId] = useState<string | null>(null);
  const [passwordCopied, setPasswordCopied] = useState(false);

  async function resetOwnerPassword(company: CompanySummary) {
    if (!company.ownerId) return;
    if (!(await ask({ title: "¿Cambiar la contraseña del dueño?", message: `${company.ownerFullName ?? "El dueño"} (${company.name}) va a recibir una contraseña nueva. La que tiene ahora deja de andar.`, confirmLabel: "Cambiar contraseña" }))) return;
    setPasswordBusyId(company.id);
    setMessage("");
    try {
      const password = await resetUserPassword(company.ownerId);
      setNewPassword({ companyId: company.id, password });
      setPasswordCopied(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo cambiar la contraseña.");
    } finally {
      setPasswordBusyId(null);
    }
  }
  /** Pagos del mes en curso de todos los clientes, para "Cobrado este mes". */
  const [monthPayments, setMonthPayments] = useState<CompanyPayment[]>([]);
  const [pendingReports, setPendingReports] = useState(0);
  /** Suscripción de Mercado Pago de cada cliente (la última asignada). */
  const [mpByCompany, setMpByCompany] = useState<Record<string, MpSubscription>>({});
  const handleMpSubscriptions = useCallback((list: MpSubscription[]) => {
    const map: Record<string, MpSubscription> = {};
    // Si un cliente tiene más de una, gana la activa.
    for (const sub of list) if (sub.companyId && (!map[sub.companyId] || sub.status === "authorized")) map[sub.companyId] = sub;
    setMpByCompany(map);
  }, []);

  const reloadPendingReports = useCallback(() => {
    listScaleSupportReports()
      .then((list) => setPendingReports(list.filter((r) => !r.resolvedAt).length))
      .catch(() => setPendingReports(0));
  }, []);

  useEffect(() => {
    reloadPendingReports();
  }, [reloadPendingReports]);

  useEffect(() => {
    // Solo puede tener pagos este mes quien tiene su último pago este mes.
    const month = todayIso().slice(0, 7);
    const withPayments = companies.filter((c) => c.lastPaymentDate?.slice(0, 7) === month);
    let cancelled = false;
    void Promise.all(withPayments.map((c) => listCompanyPayments(c.id).catch(() => [] as CompanyPayment[]))).then((lists) => {
      if (!cancelled) setMonthPayments(lists.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [companies]);

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
      try {
        setFeatures(await listCompanyFeatures());
      } catch {
        // Base sin la migración 169 todavía: no se muestran los tildes.
        setFeatures({});
      }
      try {
        setUsage(await listSalesPipeline());
      } catch {
        // Sin el dato de uso, la lista igual se ve (la columna "Última venta" queda vacía).
        setUsage({});
      }
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  async function toggleFeature(company: CompanySummary, feature: string, enabled: boolean) {
    setFeatureBusyId(company.id);
    setMessage("");
    try {
      const next = await setCompanyFeature(company.id, feature, enabled);
      setFeatures((prev) => ({ ...prev, [company.id]: next }));
    } catch (error) {
      setMessage((error as { message?: string } | null)?.message ?? "No se pudo cambiar la pantalla.");
    } finally {
      setFeatureBusyId(null);
    }
  }

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
      if (!(await ask({ title: `¿Pasar a ${company.name} al plan ${PLAN_LABELS[plan]}?`, message: `Tiene ${detail}. No se borra ni se desactiva nada: solo no va a poder agregar más.`, confirmLabel: "Cambiar el plan" }))) return;
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

  /**
   * Lo que paga por mes: su último pago de un mes (si lo hay) o el precio del Estándar. NO el precio del plan: los
   * clientes que se pasaron a Full siguen pagando su abono, y con el del plan un pago de 12 meses se completaba
   * solo en $828.000 (real 05/10, Carnes Patagonia y Lo de menon).
   */
  function planPrice(companyId: string) {
    const last = companies.find((c) => c.id === companyId)?.lastPaymentAmount ?? null;
    return last && last > 0 && last <= PLAN_PRICE_VALUES.full ? last : PLAN_PRICE_VALUES.estandar;
  }

  function openPayment(company: CompanySummary) {
    setHistoryId(null);
    setPayingId(company.id);
    setPayMonths(1);
    const price = planPrice(company.id);
    setPayAmount(price ? String(price) : "");
    setPayDate(todayIso());
    setPayNote("");
    setPayFree(false);
  }

  function changePayMonths(company: CompanySummary, months: number) {
    setPayMonths(months);
    const price = planPrice(company.id);
    if (price) setPayAmount(String(price * months));
  }

  async function savePayment(company: CompanySummary) {
    const amount = payFree ? undefined : payAmount.trim() ? parseAmount(payAmount) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
      setMessage("El monto no es válido.");
      return;
    }
    setPayBusy(true);
    setMessage("");
    try {
      const until = await registerCompanyPayment({ companyId: company.id, months: payMonths, amount, paymentDate: payDate || undefined, note: payFree ? ["Pase libre (sin cobro)", payNote.trim()].filter(Boolean).join(" · ") : payNote.trim() || undefined });
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
    if (!(await ask({ title: `¿Borrar el pago del ${formatDayMonth(payment.paymentDate)}${amountText}?`, message: "La fecha de “pagado hasta” vuelve a la que tenía antes.", confirmLabel: "Borrar pago", danger: true }))) return;
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
      // Pagado hasta una fecha futura = ya no está de prueba (si no, el cliente seguía viendo el cartel; real El Dorado).
      if (value && value >= todayIso() && company.trialEndsAt) await setCompanyTrial(company.id, null);
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
    const ok = await ask({
      title: `¿Borrar ${company.name} para siempre?`,
      message: "Esto no se puede deshacer. Si ya tiene productos, ventas o cualquier otro dato cargado, el sistema no lo deja borrar (en ese caso, desactivalo).",
      confirmLabel: "Borrar para siempre",
      danger: true,
      typeToConfirm: company.name
    });
    if (!ok) return;
    setMessage("");
    setDeletingId(company.id);
    try {
      await deleteClient(company.id);
      setDetailId(null);
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
      if (leadForForm) {
        try {
          const { createdAt: _createdAt, ...lead } = leadForForm;
          await saveLead({ ...lead, stage: "alta", companyId: created.companyId, nextContactOn: null });
        } catch {
          setMessage("El cliente se creó, pero no se pudo marcar al interesado como dado de alta. Hacelo desde Ventas.");
        }
        setLeadForForm(null);
        setPipelineReloadKey((k) => k + 1);
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
  const statusOf = (c: CompanySummary) => billingStatus(c, today);

  const activeCompanies = useMemo(() => companies.filter((c) => c.active), [companies]);
  const inactiveCompanies = companies.filter((c) => !c.active);
  const billingCounts = { all: activeCompanies.length, paid: 0, owes: 0, trial: 0, none: 0 };
  for (const c of activeCompanies) {
    for (const f of ["paid", "owes", "trial", "none"] as const) if (matchesBillingFilter(statusOf(c), f)) billingCounts[f] += 1;
  }
  const revenue = revenueSummary(activeCompanies, (c) => planPrice(c.id), monthPayments, today);
  const monthName = new Date(`${today}T12:00:00`).toLocaleDateString("es-AR", { month: "long" });
  const trialAlerts = activeCompanies
    .filter((c) => !c.paidUntil)
    .map((c) => ({ company: c, days: trialDaysLeft(c) }))
    .filter((x): x is { company: CompanySummary; days: number } => x.days !== null && x.days <= 2)
    .sort((a, b) => a.days - b.days);

  function createFromLead(lead: Lead) {
    setLeadForForm(lead);
    setResult(null);
    setShowForm(true);
    setDraft({
      ...emptyDraft(),
      companyName: lead.businessName,
      branchName: lead.city ? `Sucursal ${lead.city}` : "Principal",
      ownerFullName: lead.contactName ?? "",
      contactPhone: lead.phone ?? "",
      province: lead.province ?? "",
      city: lead.city ?? ""
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Cómo está el cobro de un cliente, mirando también Mercado Pago (igual que la tarjeta de antes). */
  function collectInfo(company: CompanySummary) {
    const status = statusOf(company);
    const mp = mpByCompany[company.id];
    const mpIssue = mp ? mpProblem(mp) : null;
    // Suscripción activa y cobrando bien: Mercado Pago cobra solo, no hay que perseguirlo.
    const mpOk = !!mp && mp.status === "authorized" && !mpIssue;
    const needsCollect = !mpOk && (mpIssue !== null || status === "overdue" || status === "trial_expired" || status === "due_soon");
    const nextCharge = mp?.nextPaymentDate ? toArDate(mp.nextPaymentDate) : company.paidUntil;
    const reminder = !company.active
      ? null
      : mpIssue
        ? mpFailedChargeMessage(company.name, company.ownerFullName)
        : needsCollect
          ? billingReminderMessage(company, planPrice(company.id), today)
          : null;
    const waLink = reminder ? whatsappLink(company.contactPhone, reminder) : null;
    const label = mpOk ? "Mercado Pago al día" : mpIssue ?? billingLabel(company, today);
    const tone: Tone = mpOk ? "ok" : mpIssue ? "danger" : BILLING_TONE[status];
    // Para ordenar: primero a quién hay que cobrarle (mismo orden que antes).
    const rank = mpOk ? STATUS_ORDER.paid : mpIssue ? -1 : STATUS_ORDER[status];
    return { status, mp, mpIssue, mpOk, needsCollect, nextCharge, reminder, waLink, label, tone, rank };
  }

  /** Días desde la última venta por Mostrador (null = nunca vendió). */
  function daysSinceSale(company: CompanySummary): number | null {
    const last = usage[company.id]?.lastSaleAt;
    return last ? Math.max(0, Math.floor((Date.now() - new Date(last).getTime()) / DAY_MS)) : null;
  }

  function saleText(days: number | null) {
    if (days === null) return "Nunca vendió";
    return days === 0 ? "Hoy" : days === 1 ? "Ayer" : `Hace ${days} días`;
  }

  function signInText(iso: string | null | undefined) {
    if (!iso) return "Nunca";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
    return days <= 0 ? "Hoy" : days === 1 ? "Ayer" : `Hace ${days} días`;
  }

  const clientColumns: Column<CompanySummary>[] = [
    { key: "n", header: "N.º", render: (c) => c.clientNumber ?? "-", sortValue: (c) => c.clientNumber ?? null, align: "right", hideOn: "sm" },
    {
      key: "name",
      header: "Cliente",
      main: true,
      render: (c) => (
        <div style={{ minWidth: 0 }}>
          <strong>{c.name}</strong>
          <div className="pa-muted" style={{ fontSize: 12, fontWeight: 400 }}>{[c.ownerFullName, c.contactPhone].filter(Boolean).join(" · ") || "Sin dueño cargado"}</div>
        </div>
      ),
      sortValue: (c) => c.name,
      csvValue: (c) => c.name
    },
    { key: "owner", header: "Dueño", render: () => null, csvValue: (c) => c.ownerFullName ?? "", csvOnly: true },
    { key: "phone", header: "Teléfono", render: () => null, csvValue: (c) => c.contactPhone ?? "", csvOnly: true },
    { key: "email", header: "Email", render: () => null, csvValue: (c) => c.ownerEmail ?? "", csvOnly: true },
    { key: "place", header: "Ubicación", render: (c) => [c.city, c.province].filter(Boolean).join(", ") || <span className="pa-muted">-</span>, sortValue: (c) => [c.province, c.city].filter(Boolean).join(" ") || null, csvValue: (c) => [c.city, c.province].filter(Boolean).join(", "), hideOn: "md" },
    { key: "plan", header: "Plan", render: (c) => (plans[c.id] ? <Badge tone="brand" dot={false}>{PLAN_LABELS[plans[c.id].plan]}</Badge> : "-"), sortValue: (c) => (plans[c.id] ? PLAN_LABELS[plans[c.id].plan] : null), hideOn: "md" },
    {
      key: "status",
      header: "Cobro",
      render: (c) => <Badge tone={collectInfo(c).tone}>{collectInfo(c).label}</Badge>,
      sortValue: (c) => collectInfo(c).rank,
      csvValue: (c) => collectInfo(c).label
    },
    {
      key: "sale",
      header: "Última venta",
      render: (c) => {
        if (!usage[c.id]) return <span className="pa-muted">-</span>;
        const days = daysSinceSale(c);
        const cls = days === null || days >= 7 ? "pa-text-warn" : undefined;
        return (
          <div>
            <span className={cls} style={{ fontWeight: cls ? 650 : undefined }}>{saleText(days)}</span>
            <div className="pa-muted" style={{ fontSize: 12 }}>{usage[c.id].salesLast7d} ventas en 7 días</div>
          </div>
        );
      },
      sortValue: (c) => (usage[c.id] ? daysSinceSale(c) ?? 9999 : null),
      firstDir: "desc",
      csvValue: (c) => (usage[c.id] ? saleText(daysSinceSale(c)) : "")
    },
    {
      key: "due",
      header: "Próximo cobro",
      render: (c) => {
        const next = collectInfo(c).nextCharge;
        return next ? formatDayMonth(next) : <span className="pa-muted">-</span>;
      },
      sortValue: (c) => collectInfo(c).nextCharge ?? null,
      hideOn: "sm"
    },
    { key: "fee", header: "Abono", render: (c) => formatMoney(planPrice(c.id)), sortValue: (c) => planPrice(c.id), align: "right", hideOn: "sm" },
    {
      key: "action",
      header: "",
      render: (c) => {
        const { waLink, mpIssue } = collectInfo(c);
        return waLink ? (
          <a className="pa-btn pa-btn-whatsapp pa-btn-sm" href={waLink} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            <MessageCircle size={14} /> {mpIssue ? "Avisarle" : "Cobrar"}
          </a>
        ) : null;
      }
    }
  ];

  const riskTest = (c: CompanySummary) => {
    if (!usage[c.id]) return false;
    const days = daysSinceSale(c);
    return days === null ? usage[c.id].productCount > 0 || statusOf(c) !== "none" : days >= 7;
  };

  const clientFilters: TableFilter<CompanySummary>[] = [
    { key: "owes", label: "Deben", test: (c) => matchesBillingFilter(statusOf(c), "owes") },
    { key: "due", label: "Vencen pronto", test: (c) => statusOf(c) === "due_soon" },
    { key: "risk", label: "Sin vender 7 días o más", test: riskTest },
    { key: "trial", label: "En prueba", test: (c) => matchesBillingFilter(statusOf(c), "trial") },
    { key: "paid", label: "Pagaron", test: (c) => matchesBillingFilter(statusOf(c), "paid") },
    { key: "none", label: "Sin pagos", test: (c) => matchesBillingFilter(statusOf(c), "none") }
  ];

  function renderDetail(company: CompanySummary) {
    const editing = editingLocationId === company.id;
    const info = collectInfo(company);
    const planInfo = plans[company.id];
    const u = usage[company.id];
    const days = daysSinceSale(company);
    const trialDays = trialDaysLeft(company);
    const trialBusy = trialBusyId === company.id;
    return (
      <>
        <div className="pa-row">
          <Badge tone={info.tone}>{info.label}</Badge>
          {planInfo && <Badge tone="brand" dot={false}>Plan {PLAN_LABELS[planInfo.plan]}</Badge>}
          {!company.active && <Badge tone="neutral">Desactivado</Badge>}
          {info.mpOk && info.nextCharge && <span className="pa-muted" style={{ fontSize: 13 }}>Próximo cobro automático: {formatDayMonth(info.nextCharge)}</span>}
        </div>

        {u && (
          <div className="pa-mini-kpis">
            <div><span>Última venta</span><strong className={days === null || days >= 7 ? "pa-text-warn" : undefined}>{saleText(days)}</strong></div>
            <div><span>Ventas en 7 días</span><strong>{u.salesLast7d}</strong></div>
            <div><span>Último ingreso</span><strong>{signInText(u.lastSignInAt)}</strong></div>
            <div><span>Productos cargados</span><strong>{u.productCount}</strong></div>
          </div>
        )}

        <section className="pa-section">
          <h3 className="pa-section-title">Cobro</h3>
          {company.lastPaymentDate && (
            <span className="pa-muted" style={{ fontSize: 13 }}>
              Último pago: {formatDayMonth(company.lastPaymentDate)}
              {company.lastPaymentAmount !== null ? ` · ${formatMoney(company.lastPaymentAmount)}` : ""}
            </span>
          )}
          <div className="pa-row">
            {info.waLink && (
              <a className="pa-btn pa-btn-whatsapp" href={info.waLink} target="_blank" rel="noreferrer"><MessageCircle size={16} /> {info.mpIssue ? "Avisarle por WhatsApp" : "Cobrar por WhatsApp"}</a>
            )}
            <Button variant={info.needsCollect && !info.mpOk ? "primary" : "secondary"} disabled={payBusy} onClick={() => (payingId === company.id ? setPayingId(null) : openPayment(company))}>
              {payingId === company.id ? "Cancelar pago" : info.mpOk ? "Registrar pago a mano" : "Registrar pago"}
            </Button>
            <Button variant="secondary" onClick={() => void openHistory(company)}>{historyId === company.id ? "Cerrar pagos" : "Ver pagos"}</Button>
          </div>
          {info.reminder && !info.waLink && <span className="pa-muted" style={{ fontSize: 12 }}>Para escribirle por WhatsApp falta su teléfono.</span>}

          {payingId === company.id && (
            <div className="pa-card" style={{ background: "var(--pa-surface-2)" }}>
              <div className="pa-form-grid">
                <Field label="Meses que paga">
                  {(id) => (
                    <Select id={id} value={payMonths} onChange={(e) => changePayMonths(company, Number(e.target.value))}>
                      {MONTH_OPTIONS.map((m) => <option key={m} value={m}>{m} {m === 1 ? "mes" : "meses"}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Monto (opcional)">
                  {(id) => <Input id={id} className="pa-num" inputMode="decimal" value={payFree ? "" : payAmount} disabled={payFree} onChange={(e) => setPayAmount(e.target.value)} placeholder={payFree ? "sin cobro" : "$"} />}
                </Field>
                <Field label="Fecha del pago">{(id) => <Input id={id} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />}</Field>
                <Field label="Nota">{(id) => <Input id={id} placeholder="Ej.: transferencia, efectivo" value={payNote} onChange={(e) => setPayNote(e.target.value)} />}</Field>
              </div>
              <Checkbox label="Pase libre (sin cobro)" checked={payFree} onChange={(e) => setPayFree(e.target.checked)} />
              <span className="pa-muted" style={{ fontSize: 12 }}>
                Se suma a partir de {company.paidUntil && company.paidUntil >= today ? `su vencimiento (${formatDayMonth(company.paidUntil)})` : "hoy"}.
                {company.trialEndsAt ? " Se le saca el aviso de prueba gratuita." : ""}
              </span>
              <div className="pa-form-actions">
                <Button variant="secondary" onClick={() => setPayingId(null)}>Cancelar</Button>
                <Button loading={payBusy} onClick={() => void savePayment(company)}>Guardar pago</Button>
              </div>
            </div>
          )}

          {historyId === company.id && (
            <div style={{ display: "grid", gap: 6 }}>
              {historyLoading && <Skeleton lines={2} />}
              {!historyLoading && history.length === 0 && <span className="pa-muted">Todavía no hay pagos registrados.</span>}
              {history.map((payment, index) => (
                <div key={payment.id} className="pa-list-row">
                  <span className="pa-num">
                    <b>{formatDayMonth(payment.paymentDate)}</b> · {payment.months} {payment.months === 1 ? "mes" : "meses"}
                    {payment.amount !== null ? ` · ${formatMoney(payment.amount)}` : ""} · hasta {formatDayMonth(payment.paidUntil)}
                    {payment.note ? ` · ${payment.note}` : ""}
                  </span>
                  {index === 0 && <Button variant="ghost" size="sm" disabled={payBusy} onClick={() => void removeLastPayment(company, payment)}>Borrar</Button>}
                </div>
              ))}
              <div className="pa-row" style={{ alignItems: "flex-end" }}>
                <Field label="Corregir “pagado hasta”">{(id) => <Input id={id} type="date" value={editPaidUntil} onChange={(e) => setEditPaidUntil(e.target.value)} />}</Field>
                <Button variant="secondary" disabled={payBusy || !editPaidUntil} onClick={() => void savePaidUntil(company, editPaidUntil)}>Guardar fecha</Button>
                {company.paidUntil && <Button variant="secondary" disabled={payBusy} onClick={() => void savePaidUntil(company, null)}>Dejar sin pago</Button>}
              </div>
            </div>
          )}

          {!company.paidUntil && (
            <div className="pa-row-between">
              <span>
                Prueba gratuita:{" "}
                <b>{trialDays === null ? "sin prueba" : trialDays <= 0 ? "vencida" : trialDays === 1 ? "vence mañana" : `quedan ${trialDays} días`}</b>
              </span>
              <div className="pa-row">
                {trialDays === null ? (
                  <Button variant="secondary" size="sm" loading={trialBusy} onClick={() => void changeTrial(company, new Date(Date.now() + TRIAL_DAYS * DAY_MS))}>Iniciar prueba de {TRIAL_DAYS} días</Button>
                ) : (
                  <>
                    <Button variant="secondary" size="sm" disabled={trialBusy} onClick={() => void changeTrial(company, new Date(Math.max(Date.now(), new Date(company.trialEndsAt!).getTime()) + TRIAL_DAYS * DAY_MS))}>+{TRIAL_DAYS} días</Button>
                    <Button variant="secondary" size="sm" disabled={trialBusy} onClick={() => void changeTrial(company, null)}>Quitar prueba</Button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        {planInfo && (() => {
          const limits = PLAN_LIMITS[planInfo.plan];
          const limitText = (count: number, max: number | null, one: string, many: string) => `${count}${max !== null ? `/${max}` : ""} ${count === 1 && max === null ? one : many}`;
          return (
            <section className="pa-section">
              <h3 className="pa-section-title">Plan y pantallas</h3>
              <div className="pa-row" style={{ alignItems: "flex-end" }}>
                <Field label="Plan" hint={`Todos cuestan ${PRICE_PER_LOCAL}; cambian las pantallas que incluyen`}>
                  {(id) => (
                    <Select id={id} value={planInfo.plan} disabled={planBusyId === company.id} onChange={(e) => void changePlan(company, e.target.value as Plan)}>
                      {planOptionsFor(planInfo.plan).map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}{PLAN_OPTIONS.includes(p) ? "" : " (ya no se vende)"}</option>)}
                    </Select>
                  )}
                </Field>
                <span className="pa-muted" style={{ fontSize: 13, paddingBottom: 10 }}>
                  {limitText(planInfo.activeBranches, limits.maxBranches, "sucursal", "sucursales")} · {limitText(planInfo.activeUsers, limits.maxUsers, "usuario", "usuarios")}
                </span>
              </div>
              {features[company.id] && (
                <details>
                  <summary>
                    Pantallas a pedido{" "}
                    <span className="pa-muted" style={{ fontWeight: 400, fontSize: 13 }}>
                      · {COMPANY_FEATURES.filter((f) => features[company.id].includes(f.key)).map((f) => f.short).join(", ") || "ninguna"}
                    </span>
                  </summary>
                  <div style={{ display: "grid", marginTop: 4 }}>
                    {COMPANY_FEATURES.map((f) => (
                      <Checkbox key={f.key} label={f.label} checked={features[company.id].includes(f.key)} disabled={featureBusyId === company.id} onChange={(e) => void toggleFeature(company, f.key, e.target.checked)} />
                    ))}
                  </div>
                </details>
              )}
            </section>
          );
        })()}

        <section className="pa-section">
          <h3 className="pa-section-title">Datos y acceso</h3>
          <dl className="pa-dl">
            <div><dt>Email del dueño</dt><dd>{company.ownerEmail ?? "-"}</dd></div>
            <div><dt>Teléfono</dt><dd>{company.contactPhone ?? "-"}</dd></div>
            <div><dt>Sucursales · usuarios</dt><dd>{company.branchCount} · {company.userCount}</dd></div>
            <div><dt>Cliente desde</dt><dd>{formatDate(company.createdAt)}</dd></div>
          </dl>
          {editing ? (
            <div className="pa-row" style={{ alignItems: "flex-end" }}>
              <Field label="Provincia">
                {(id) => (
                  <Select id={id} value={editProvince} onChange={(e) => setEditProvince(e.target.value)}>
                    <option value="">Provincia…</option>
                    {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Ciudad">{(id) => <Input id={id} value={editCity} onChange={(e) => setEditCity(e.target.value)} />}</Field>
              <Button loading={savingLocation} onClick={() => void saveLocation(company)}>Guardar</Button>
              <Button variant="secondary" onClick={() => setEditingLocationId(null)}>Cancelar</Button>
            </div>
          ) : (
            <div className="pa-row">
              <Button variant="secondary" size="sm" icon={MapPin} onClick={() => startEditLocation(company)}>
                {[company.city, company.province].filter(Boolean).join(", ") || "Agregar ubicación"}
              </Button>
              {company.ownerId && (
                <Button variant="secondary" size="sm" icon={KeyRound} loading={passwordBusyId === company.id} onClick={() => void resetOwnerPassword(company)}>Cambiar contraseña del dueño</Button>
              )}
            </div>
          )}
          {newPassword?.companyId === company.id && (() => {
            const text = passwordMessage(company, newPassword.password);
            const link = whatsappLink(company.contactPhone, text);
            return (
              <Alert
                tone="ok"
                title="Contraseña nueva (copiala ahora, no se vuelve a mostrar)"
                onClose={() => setNewPassword(null)}
                action={
                  <div className="pa-row">
                    {link && <a className="pa-btn pa-btn-whatsapp pa-btn-sm" href={link} target="_blank" rel="noreferrer"><MessageCircle size={14} /> Mandársela por WhatsApp</a>}
                    <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard.writeText(text); setPasswordCopied(true); }}>{passwordCopied ? "¡Copiado!" : "Copiar mensaje"}</Button>
                  </div>
                }
              >
                {company.ownerEmail} · <span className="pa-secret">{newPassword.password}</span>
              </Alert>
            );
          })()}
        </section>

        <section className="pa-section">
          <h3 className="pa-section-title">Soporte</h3>
          <div className="pa-row-between">
            <span style={{ fontSize: 13 }}>
              {supportAccess[company.id]
                ? `Herramientas técnicas de balanza abiertas hasta las ${new Date(supportAccess[company.id]).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`
                : "Herramientas técnicas de balanza: cerradas"}
            </span>
            <Button variant="secondary" size="sm" loading={supportBusyId === company.id} onClick={() => void toggleSupportAccess(company)}>
              {supportAccess[company.id] ? "Cerrar" : "Abrir por 2 horas"}
            </Button>
          </div>
        </section>

        <section className="pa-section">
          <h3 className="pa-section-title">Activar o borrar</h3>
          <div className="pa-row-between">
            <span className="pa-muted" style={{ fontSize: 13 }}>
              {company.active ? "Si lo desactivás, nadie de ese negocio puede entrar. Se puede volver a activar." : "Está desactivado: nadie de ese negocio puede entrar."}
            </span>
            <div className="pa-row">
              <Button variant="secondary" loading={togglingId === company.id} onClick={() => void toggleActive(company)}>{company.active ? "Desactivar" : "Activar"}</Button>
              <Button variant="danger" icon={Trash2} loading={deletingId === company.id} onClick={() => void handleDeleteClient(company)}>Borrar</Button>
            </div>
          </div>
        </section>
      </>
    );
  }

  const detailCompany = detailId ? companies.find((c) => c.id === detailId) ?? null : null;
  const tabTitles: Record<AdminTab, string> = { resumen: "Resumen", clientes: "Clientes", ventas: "Ventas", contactos: "Contactos", finanzas: "Finanzas", soporte: "Soporte" };
  return (
    <AdminThemeRoot className="pa-shell">
      <div className="pa-container">
        <header className="pa-topbar">
          <BrandMark suffix="Panel" />
          <div className="pa-row">
            <ThemeToggle />
            <Button icon={Plus} onClick={() => { setShowForm(true); setResult(null); setLeadForForm(null); }}>Nuevo cliente</Button>
            <Button variant="secondary" icon={LogOut} onClick={() => void signOut()}>Salir</Button>
          </div>
        </header>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "resumen", label: "Resumen", icon: LayoutDashboard },
            { key: "clientes", label: "Clientes", icon: Building2 },
            { key: "ventas", label: "Ventas", icon: TrendingUp },
            { key: "contactos", label: "Contactos", icon: Users },
            { key: "finanzas", label: "Finanzas", icon: Wallet },
            { key: "soporte", label: "Soporte", icon: LifeBuoy, count: pendingReports }
          ]}
        />
        <h1 className="pa-sr-only">{tabTitles[tab]}</h1>

        {message && !detailCompany && !showForm && <Alert tone={message.startsWith("Pago registrado") ? "ok" : "warn"} onClose={() => setMessage("")}>{message}</Alert>}

        {/* Ventas, Contactos y Finanzas todavía usan piezas viejas: "pa-legacy" las pinta con los colores nuevos. */}
        <div className="pa-legacy">
          {tab === "finanzas" && <AdminFinance />}

          {tab === "soporte" && <AdminScaleReports onChange={reloadPendingReports} />}

          {tab === "resumen" && <AdminDailyChecks />}
          {tab === "resumen" && (
            <AdminSummary
              companies={companies}
              plans={plans}
              planPrice={planPrice}
              monthlyFee={revenue.monthly}
              isAutoCharged={(id) => {
                const mp = mpByCompany[id];
                return !!mp && mp.status === "authorized" && !mpProblem(mp);
              }}
              today={today}
            />
          )}

          {tab === "contactos" && <AdminContacts onScheduled={() => setPipelineReloadKey((k) => k + 1)} />}

          {tab === "ventas" && <AdminSalesPipeline companies={companies} onCreateFromLead={createFromLead} reloadKey={pipelineReloadKey} />}
        </div>

        {tab === "clientes" && (
          <div className="pa-kpis">
            <Kpi label="Clientes activos" value={activeCompanies.length} hint={`${billingCounts.paid} pagaron · ${billingCounts.trial} en prueba`} />
            <Kpi label="Abono mensual" value={formatMoney(revenue.monthly)} hint="lo que entra por mes si nadie se va" />
            <Kpi label={`Cobrado en ${monthName}`} value={formatMoney(revenue.collectedThisMonth)} />
            <Kpi
              label="Vencido sin cobrar"
              value={<span className={revenue.overdue > 0 ? "pa-text-danger" : undefined}>{formatMoney(revenue.overdue)}</span>}
              hint={revenue.overdueCount > 0 ? `${revenue.overdueCount} ${revenue.overdueCount === 1 ? "cliente" : "clientes"}` : "nadie debe"}
            />
            <Kpi
              label={`Falta cobrar en ${monthName}`}
              value={formatMoney(revenue.dueThisMonth)}
              hint={revenue.dueThisMonthCount > 0 ? `${revenue.dueThisMonthCount} ${revenue.dueThisMonthCount === 1 ? "cliente" : "clientes"}, contando lo vencido` : undefined}
            />
          </div>
        )}

        {/* Siempre montado: le pasa al panel las suscripciones de Mercado Pago aunque se esté en otra pestaña. */}
        <div style={tab === "clientes" ? undefined : { display: "none" }}>
          <AdminMercadoPago companies={companies} onPaymentsChanged={() => void reloadCompanies()} onSubscriptions={handleMpSubscriptions} />
        </div>

        {tab === "clientes" && (
          <>
            {trialAlerts.length > 0 && (
              <Alert tone="warn" title="Prueba gratuita por vencer o vencida">
                {trialAlerts.map(({ company, days }, i) => (
                  <span key={company.id}>
                    {i > 0 ? " · " : ""}
                    <button type="button" className="pa-link" onClick={() => setDetailId(company.id)}>{company.name}</button> ({trialLabel(days).toLowerCase()})
                  </span>
                ))}
                . No se bloquea nada al vencer: desde la ficha podés sumarle días o sacarle la prueba.
              </Alert>
            )}

            <DataTable
              rows={activeCompanies}
              columns={clientColumns}
              rowKey={(c) => c.id}
              matches={(c, q) => matchesCompanySearch(c, q)}
              searchPlaceholder="Buscar por número, negocio, dueño, mail, teléfono o ciudad"
              filters={clientFilters}
              defaultSort={{ key: "status", dir: "asc" }}
              exportName="clientes"
              loading={companiesLoading}
              onRowClick={(c) => setDetailId(c.id)}
              emptyTitle="Todavía no diste de alta ningún cliente"
              emptyText="Tocá “Nuevo cliente” arriba para crear el primero."
            />

            {inactiveCompanies.length > 0 && (
              <details className="pa-card">
                <summary>Clientes desactivados ({inactiveCompanies.length})</summary>
                <div style={{ display: "grid", gap: 6 }}>
                  {inactiveCompanies.map((c) => (
                    <button key={c.id} type="button" className="pa-list-row pa-list-button" onClick={() => setDetailId(c.id)}>
                      <span><b>{c.name}</b> <span className="pa-muted">· {[c.ownerFullName, c.city].filter(Boolean).join(" · ")}</span></span>
                      <span className="pa-muted">Ver ficha</span>
                    </button>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>

      <Modal
        open={detailCompany !== null}
        size="lg"
        title={detailCompany ? `${detailCompany.clientNumber !== undefined ? `N.º ${detailCompany.clientNumber} · ` : ""}${detailCompany.name}` : ""}
        headerExtra={detailCompany && <span className="pa-muted" style={{ fontSize: 13 }}>{[detailCompany.ownerFullName, [detailCompany.city, detailCompany.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</span>}
        onClose={() => { setDetailId(null); setPayingId(null); setHistoryId(null); setEditingLocationId(null); }}
      >
        {message && <Alert tone={message.startsWith("Pago registrado") ? "ok" : "warn"} onClose={() => setMessage("")}>{message}</Alert>}
        {detailCompany && renderDetail(detailCompany)}
      </Modal>

      <Modal
        open={showForm || result !== null}
        title={result ? "Cliente creado" : leadForForm ? `Dar de alta a ${leadForForm.businessName}` : "Dar de alta un cliente"}
        onClose={() => { setShowForm(false); setResult(null); setLeadForForm(null); }}
      >
        {result ? (
          <>
            <Alert tone="ok" title="Listo. Mandale estos datos al dueño">
              Usuario: <b>{result.email}</b>
              <br />
              Contraseña temporal (copiala ahora, no se vuelve a mostrar): <span className="pa-secret">{result.tempPassword}</span>
            </Alert>
            <div className="pa-form-actions">
              <Button variant="secondary" onClick={() => { setResult(null); setShowForm(true); }}>Crear otro cliente</Button>
              <Button onClick={() => { void navigator.clipboard.writeText(buildWelcomeMessage(resultCompanyName, result)); setCopied(true); }}>
                {copied ? "¡Copiado!" : "Copiar mensaje para el cliente"}
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
            <div className="pa-form-grid">
              <Field label="Nombre del negocio">{(id) => <Input id={id} value={draft.companyName} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} required />}</Field>
              <Field label="Primera sucursal">{(id) => <Input id={id} value={draft.branchName} onChange={(e) => setDraft({ ...draft, branchName: e.target.value })} required />}</Field>
              <Field label="Nombre del dueño">{(id) => <Input id={id} value={draft.ownerFullName} onChange={(e) => setDraft({ ...draft, ownerFullName: e.target.value })} required />}</Field>
              <Field label="Email del dueño">{(id) => <Input id={id} type="email" value={draft.ownerEmail} onChange={(e) => setDraft({ ...draft, ownerEmail: e.target.value })} required />}</Field>
              <Field label="Teléfono" hint="Uso interno, para escribirle por WhatsApp">{(id) => <Input id={id} inputMode="tel" value={draft.contactPhone} onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} />}</Field>
              <Field label="Plan" hint={`Todos cuestan ${PRICE_PER_LOCAL}`}>
                {(id) => (
                  <Select id={id} value={draft.plan} onChange={(e) => setDraft({ ...draft, plan: e.target.value as Plan })}>
                    {PLAN_OPTIONS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Provincia (opcional)">
                {(id) => (
                  <Select id={id} value={draft.province} onChange={(e) => setDraft({ ...draft, province: e.target.value })}>
                    <option value="">Sin especificar</option>
                    {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Ciudad (opcional)">{(id) => <Input id={id} value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />}</Field>
            </div>
            {message && <Alert tone="warn">{message}</Alert>}
            <div className="pa-form-actions">
              <Button variant="secondary" onClick={() => { setShowForm(false); setLeadForForm(null); }}>Cancelar</Button>
              <Button type="submit" loading={busy}>{busy ? "Creando…" : "Crear cliente"}</Button>
            </div>
          </form>
        )}
      </Modal>

      {confirmDialog}
    </AdminThemeRoot>
  );
}
