import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, MessageCircle, RefreshCw } from "lucide-react";
import { assignMpSubscription, getMpScheduleStatus, listMpSubscriptions, syncMercadoPago, type CompanySummary, type MpScheduleStatus } from "./admin-service";
import { mpFailedChargeMessage, mpProblem, mpStatusLabel, suggestCompany, toArDate, type MpSubscription } from "./mercadopago";
import { formatDayMonth } from "./company-billing";
import { whatsappLink } from "./sales-pipeline";
import { Alert, Button, Card, Select, useConfirm } from "./ui/components";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

/** Bloque "Mercado Pago" de la pestaña Clientes: trae los cobros de la
 * suscripción (Edge Function mp-sync) al abrir el panel, pide asignar una vez
 * cada suscriptor a su cliente y muestra a quién no le pasó el cobro. */
export function AdminMercadoPago({
  companies,
  onPaymentsChanged,
  onSubscriptions
}: {
  companies: CompanySummary[];
  onPaymentsChanged: () => void;
  onSubscriptions: (list: MpSubscription[]) => void;
}) {
  const [subs, setSubs] = useState<MpSubscription[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ask, confirmDialog] = useConfirm();
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [schedule, setSchedule] = useState<MpScheduleStatus | null>(null);
  const onChangedRef = useRef(onPaymentsChanged);
  const onSubsRef = useRef(onSubscriptions);
  onChangedRef.current = onPaymentsChanged;
  onSubsRef.current = onSubscriptions;

  const reloadList = useCallback(async () => {
    const list = await listMpSubscriptions();
    setSubs(list);
    onSubsRef.current(list);
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError("");
    setMessage("");
    try {
      const result = await syncMercadoPago();
      setConnected(result.connected);
      if (result.connected) {
        setLastSync(new Date());
        if (result.applied) {
          setMessage(`Se sumaron ${result.applied} ${result.applied === 1 ? "cobro" : "cobros"} de Mercado Pago.`);
          onChangedRef.current();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo traer los cobros de Mercado Pago.");
    } finally {
      try {
        await reloadList();
      } catch {
        // Base sin la migración 129: el panel sigue andando.
      }
      setSchedule(await getMpScheduleStatus());
      setSyncing(false);
    }
  }, [reloadList]);

  useEffect(() => {
    void sync();
  }, [sync]);

  async function assign(sub: MpSubscription, companyId: string) {
    if (!companyId) return;
    setBusyId(sub.id);
    setError("");
    try {
      const applied = await assignMpSubscription(sub.id, companyId);
      const name = companies.find((c) => c.id === companyId)?.name ?? "el cliente";
      setMessage(applied > 0 ? `Listo: ${name}. Se sumaron ${applied} ${applied === 1 ? "cobro" : "cobros"}.` : `Listo: ${name}. Los próximos cobros se suman solos.`);
      await reloadList();
      onChangedRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar la suscripción.");
    } finally {
      setBusyId(null);
    }
  }

  async function unassign(sub: MpSubscription) {
    if (!(await ask({ title: `¿Sacar esta suscripción de ${sub.companyName}?`, message: "Los pagos ya sumados quedan; los próximos no se suman.", confirmLabel: "Sacar suscripción", danger: true }))) return;
    setBusyId(sub.id);
    try {
      await assignMpSubscription(sub.id, null);
      await reloadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo desasignar.");
    } finally {
      setBusyId(null);
    }
  }

  const active = companies.filter((c) => c.active);
  const unassigned = subs.filter((s) => !s.companyId && s.status !== "cancelled");
  const problems = subs.filter((s) => s.companyId && mpProblem(s));
  const assigned = subs.filter((s) => s.companyId);

  if (connected === false) {
    return (
      <Card
        title={<span className="pa-row"><CreditCard size={16} aria-hidden /> Mercado Pago sin conectar</span>}
        subtitle="Para que los cobros de la suscripción se anoten solos, falta cargar el Access Token de tu cuenta de Mercado Pago en Supabase."
        actions={<Button variant="secondary" icon={RefreshCw} loading={syncing} onClick={() => void sync()}>Actualizar</Button>}
      >
        <details>
          <summary>Cómo conectarlo</summary>
          <ol>
            <li>En Mercado Pago entrá a <b>Tus integraciones</b> (mercadopago.com.ar/developers/panel/app), elegí o creá una aplicación y abrí <b>Credenciales de producción</b>.</li>
            <li>Copiá el <b>Access Token</b> (empieza con APP_USR-).</li>
            <li>En Supabase: proyecto de producción → <b>Edge Functions</b> → <b>Secrets</b> → <b>Add new secret</b>. Nombre: <code>MP_ACCESS_TOKEN</code>, valor: el token.</li>
            <li>Volvé acá y tocá <b>Actualizar</b>.</li>
          </ol>
        </details>
        {confirmDialog}
      </Card>
    );
  }

  const subtitle = [
    syncing ? "Buscando cobros…" : `${assigned.length} de ${subs.filter((s) => s.status !== "cancelled" || s.companyId).length} suscripciones asignadas`,
    lastSync && !syncing ? `actualizado ${lastSync.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}` : "",
    schedule?.scheduled
      ? `se buscan solos cada hora${schedule.lastRunAt ? ` (última vez ${new Date(schedule.lastRunAt).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })})` : ""}`
      : ""
  ].filter(Boolean).join(" · ");

  return (
    <Card
      title={<span className="pa-row"><CreditCard size={16} aria-hidden /> Mercado Pago</span>}
      subtitle={subtitle}
      actions={<Button variant="secondary" size="sm" icon={RefreshCw} loading={syncing} onClick={() => void sync()}>Actualizar</Button>}
    >
      {schedule?.lastError && <Alert tone="warn" title="La última búsqueda automática falló">{schedule.lastError}</Alert>}
      {message && <Alert tone="ok" onClose={() => setMessage("")}>{message}</Alert>}
      {error && <Alert tone="danger" onClose={() => setError("")}>{error}</Alert>}

      {problems.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <strong className="pa-text-danger">No pasó el cobro</strong>
          {problems.map((s) => {
            const company = companies.find((c) => c.id === s.companyId);
            const link = company ? whatsappLink(company.contactPhone, mpFailedChargeMessage(company.name, company.ownerFullName)) : null;
            return (
              <div key={s.id} className="pa-list-row">
                <span><b>{s.companyName}</b> · {mpProblem(s)}</span>
                {link && <a className="pa-btn pa-btn-whatsapp pa-btn-sm" href={link} target="_blank" rel="noreferrer"><MessageCircle size={14} /> Avisarle</a>}
              </div>
            );
          })}
        </div>
      )}

      {unassigned.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <strong>¿De qué cliente es cada suscripción?</strong>
          <span className="pa-muted" style={{ fontSize: 13 }}>Se elige una sola vez. Lo que ya habías anotado a mano no se suma de nuevo.</span>
          {unassigned.map((s) => {
            const suggested = suggestCompany(s, active);
            const value = choice[s.id] ?? suggested ?? "";
            return (
              <div key={s.id} className="pa-list-row">
                <span>
                  <b>{s.payerName || s.payerEmail || "Suscriptor sin nombre"}</b>
                  {s.payerName && s.payerEmail ? ` · ${s.payerEmail}` : ""}
                  {s.amount !== null ? ` · ${formatMoney(s.amount)}` : ""}
                  {` · ${mpStatusLabel(s.status)}`}
                  {s.dateCreated ? ` · desde ${formatDayMonth(toArDate(s.dateCreated))}` : ""}
                  {` · ${s.approvedCount} ${s.approvedCount === 1 ? "cobro" : "cobros"}`}
                </span>
                <div className="pa-row">
                  <Select aria-label="Cliente" value={value} onChange={(e) => setChoice({ ...choice, [s.id]: e.target.value })} style={{ maxWidth: 260 }}>
                    <option value="">Elegí el cliente…</option>
                    {active.map((c) => (
                      <option key={c.id} value={c.id}>{c.clientNumber !== undefined ? `N.º ${c.clientNumber} · ` : ""}{c.name}</option>
                    ))}
                  </Select>
                  <Button disabled={!value} loading={busyId === s.id} onClick={() => void assign(s, value)}>Asignar</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {assigned.length > 0 && (
        <details>
          <summary>Suscripciones asignadas ({assigned.length})</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {assigned.map((s) => (
              <div key={s.id} className="pa-list-row">
                <span>
                  <b>{s.companyName}</b> · {s.payerName || s.payerEmail || "-"} · {mpStatusLabel(s.status)}
                  {s.lastChargeDate ? ` · último cobro ${formatDayMonth(toArDate(s.lastChargeDate))}` : ""}
                </span>
                <Button variant="ghost" size="sm" disabled={busyId === s.id} onClick={() => void unassign(s)}>No es de este cliente</Button>
              </div>
            ))}
          </div>
        </details>
      )}
      {confirmDialog}
    </Card>
  );
}
