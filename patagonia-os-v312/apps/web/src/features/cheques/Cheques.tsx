import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { useCustomers } from "../customers/useCustomers";
import { useSuppliers } from "../purchases/useSuppliers";
import { formatMoney, localDateIso } from "../shifts/format";
import { useTreasury } from "../shifts/useTreasury";
import { ChequeFields, EMPTY_CHEQUE, readChequeForm, type ChequeForm } from "./ChequeFields";
import {
  STATUS_LABELS,
  chequeAlerts,
  chequeTitle,
  cleanCuit,
  dueInfo,
  formatDay,
  isOpen,
  lastDepositDay,
  openTotal,
  sortCheques,
  undoLabel,
  type Cheque,
  type ChequeKind
} from "./cheque-logic";
import {
  depositCheque,
  endorseCheque,
  issueCheque,
  listCheques,
  markChequeDebited,
  receiveCustomerCheque,
  rejectCheque,
  undoChequeStep
} from "./cheques-service";

// Cheques (migración 150, plan Full, dueño/admin). Dos listas: "Para cobrar"
// (los que te dieron) y "Para pagar" (los propios). Cada cheque abierto tiene
// los botones de su próximo paso; el historial queda plegado.

type Action = "deposit" | "endorse" | "reject" | "debit";

const TONE_CLASS = { late: "num-negative", soon: "", ok: "muted" } as const;

export function Cheques() {
  const { branchId } = useActiveBranch();
  const { customers } = useCustomers();
  const { suppliers } = useSuppliers();
  const { accounts } = useTreasury();
  const moneyAccounts = useMemo(() => accounts.filter((a) => !a.isSafe), [accounts]);
  const today = localDateIso();

  const [cheques, setCheques] = useState<Cheque[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<ChequeKind>("received");
  const [showHistory, setShowHistory] = useState(false);
  const [newForm, setNewForm] = useState<ChequeKind | null>(null);

  const reload = useCallback(async () => {
    try {
      setCheques(await listCheques());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron cargar los cheques.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(work: () => Promise<void>, done: string): Promise<boolean> {
    setBusy(true);
    setMessage("");
    try {
      await work();
      await reload();
      setMessage(done);
      return true;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const alerts = chequeAlerts(cheques, today);
  const list = sortCheques(cheques.filter((c) => c.kind === tab));
  const open = list.filter(isOpen);
  const history = list.filter((c) => !isOpen(c));

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">FINANZAS</p>
          <h1>Cheques</h1>
          <p className="muted">Los cheques que te dieron y los que diste, con su fecha de cobro. Cada uno se mueve con un botón.</p>
        </div>
      </header>

      {!isSupabaseConfigured && <div className="message">Modo demostración: los cheques necesitan la base conectada.</div>}
      {message && <div className="message">{message}</div>}

      <section className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <SummaryCard
          title="Para cobrar"
          value={formatMoney(openTotal(cheques, "received"))}
          detail={alerts.expiring.count > 0
            ? `${alerts.expiring.count} por vencer: depositalos ya`
            : alerts.toDeposit.count > 0 ? `${alerts.toDeposit.count} para depositar esta semana (${formatMoney(alerts.toDeposit.total)})` : "En cartera"}
          warn={alerts.expiring.count > 0}
        />
        <SummaryCard
          title="Para pagar"
          value={formatMoney(openTotal(cheques, "issued"))}
          detail={alerts.toDebit.count > 0 ? `Te debitan ${formatMoney(alerts.toDebit.total)} en los próximos 7 días` : "Cheques propios por debitar"}
          warn={alerts.toDebit.count > 0}
        />
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title" style={{ flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={tab === "received" ? "" : "secondary"} onClick={() => setTab("received")}>Para cobrar</button>
            <button className={tab === "issued" ? "" : "secondary"} onClick={() => setTab("issued")}>Para pagar</button>
          </div>
          <button className="secondary" onClick={() => setNewForm(newForm === tab ? null : tab)}>
            {newForm === tab ? "Cancelar" : tab === "received" ? "+ Recibí un cheque" : "+ Di un cheque propio"}
          </button>
        </div>

        {newForm === "received" && tab === "received" && (
          <ReceiveForm
            customers={customers}
            busy={busy}
            onSubmit={(input) => run(async () => {
              if (!branchId) throw new Error("Elegí una sucursal.");
              await receiveCustomerCheque({ ...input, branchId });
            }, "Cheque cargado: la deuda del cliente ya bajó y el cheque quedó en cartera.").then((ok) => ok && setNewForm(null))}
          />
        )}
        {newForm === "issued" && tab === "issued" && (
          <IssueForm
            suppliers={suppliers}
            accounts={moneyAccounts}
            busy={busy}
            onSubmit={(input) => run(async () => {
              if (!branchId) throw new Error("Elegí una sucursal.");
              await issueCheque({ ...input, branchId });
            }, "Cheque propio cargado: la deuda con el proveedor ya bajó y la plata sale del banco en la fecha del cheque.").then((ok) => ok && setNewForm(null))}
          />
        )}

        {loading ? (
          <p className="muted">Cargando…</p>
        ) : open.length === 0 ? (
          <p className="muted">
            {tab === "received"
              ? "No hay cheques en cartera. Se cargan acá o en Clientes → Registrar pago → \"Cheque\"."
              : "No hay cheques propios por debitar. Se cargan acá o en Compras → Registrar pago → \"Cheque propio\"."}
          </p>
        ) : (
          <ChequeList
            cheques={open}
            today={today}
            busy={busy}
            accounts={moneyAccounts}
            suppliers={suppliers}
            run={run}
            branchId={branchId}
          />
        )}

        {history.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button className="link-button" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? "Ocultar historial" : `Ver historial (${history.length})`}
            </button>
            {showHistory && (
              <ChequeList cheques={history} today={today} busy={busy} accounts={moneyAccounts} suppliers={suppliers} run={run} branchId={branchId} />
            )}
          </div>
        )}
      </section>
    </>
  );
}

function SummaryCard({ title, value, detail, warn }: { title: string; value: string; detail: string; warn: boolean }) {
  return (
    <div className="panel" style={{ padding: "14px 16px" }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{title}</p>
      <strong style={{ fontSize: 24 }}>{value}</strong>
      <p className={warn ? "num-negative" : "muted"} style={{ margin: "4px 0 0", fontSize: 13 }}>{detail}</p>
    </div>
  );
}

type Run = (work: () => Promise<void>, done: string) => Promise<boolean>;

function ChequeList({ cheques, today, busy, accounts, suppliers, run, branchId }: {
  cheques: Cheque[];
  today: string;
  busy: boolean;
  accounts: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  run: Run;
  branchId: string | null;
}) {
  const [active, setActive] = useState<{ id: string; action: Action } | null>(null);
  const [accountId, setAccountId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");

  function open(id: string, action: Action) {
    setActive({ id, action });
    setDate(today);
    setNote("");
  }

  async function confirm(c: Cheque) {
    if (!active) return;
    const close = (ok: boolean) => ok && setActive(null);
    if (active.action === "deposit") {
      if (!accountId) return void run(async () => { throw new Error("Elegí a qué cuenta lo depositás."); }, "");
      close(await run(() => depositCheque(c.id, accountId, date), "Cheque depositado: pasó de la cartera al banco."));
    } else if (active.action === "endorse") {
      if (!supplierId) return void run(async () => { throw new Error("Elegí a qué proveedor se lo das."); }, "");
      close(await run(() => endorseCheque(c.id, supplierId, branchId ?? "", date), "Cheque endosado: bajó lo que le debés al proveedor."));
    } else if (active.action === "reject") {
      close(await run(() => rejectCheque(c.id, date, note), `Cheque rechazado: ${c.customerName ?? "el cliente"} vuelve a deber ${formatMoney(c.amount)}.`));
    } else {
      close(await run(() => markChequeDebited(c.id, date), "Listo: el cheque salió del banco."));
    }
  }

  async function undo(c: Cheque) {
    const label = undoLabel(c);
    const warning = c.status === "in_portfolio"
      ? `¿Borrar ${chequeTitle(c)}? También se borra el cobro a ${c.customerName ?? "el cliente"}, que vuelve a deber ${formatMoney(c.amount)}.`
      : c.status === "pending"
        ? `¿Borrar ${chequeTitle(c)}? También se borra el pago a ${c.supplierName ?? "el proveedor"}.`
        : `¿${label}?`;
    if (!window.confirm(warning)) return;
    await run(() => undoChequeStep(c.id), "Listo, quedó como antes.");
  }

  return (
    <div style={{ overflowX: "auto", marginTop: 10 }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Cheque</th>
            <th>{cheques[0]?.kind === "issued" ? "A quién" : "De quién"}</th>
            <th className="num">Monto</th>
            <th>Se cobra</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {cheques.map((c) => {
            const due = dueInfo(c, today);
            const isActive = active?.id === c.id;
            return (
              <Fragment key={c.id}>
                <tr>
                  <td>
                    <strong>{chequeTitle(c)}</strong>
                    {c.drawerName && <span className="muted" style={{ display: "block", fontSize: 12 }}>Firma {c.drawerName}{c.drawerCuit ? ` · CUIT ${formatCuit(c.drawerCuit)}` : ""}</span>}
                  </td>
                  <td>{c.kind === "received" ? c.customerName ?? "-" : c.supplierName ?? "-"}</td>
                  <td className="num"><strong>{formatMoney(c.amount)}</strong></td>
                  <td>
                    {formatDay(c.payDate)}
                    {due && <span className={TONE_CLASS[due.tone]} style={{ display: "block", fontSize: 12 }}>{due.text}</span>}
                    {c.kind === "received" && c.status === "in_portfolio" && !due?.text.includes("plazo") && c.payDate <= today && (
                      <span className="muted" style={{ display: "block", fontSize: 12 }}>hasta el {formatDay(lastDepositDay(c))}</span>
                    )}
                  </td>
                  <td>
                    {STATUS_LABELS[c.status]}
                    {statusDetail(c) && <span className="muted" style={{ display: "block", fontSize: 12 }}>{statusDetail(c)}</span>}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {c.status === "in_portfolio" && (
                        <>
                          <button disabled={busy} onClick={() => open(c.id, "deposit")}>Depositar</button>
                          <button className="secondary" disabled={busy} onClick={() => open(c.id, "endorse")}>Endosar</button>
                        </>
                      )}
                      {(c.status === "in_portfolio" || c.status === "deposited") && (
                        <button className="secondary" disabled={busy} onClick={() => open(c.id, "reject")}>Rechazado</button>
                      )}
                      {c.status === "pending" && <button disabled={busy} onClick={() => open(c.id, "debit")}>Ya se debitó</button>}
                      <button className="link-button" disabled={busy} onClick={() => void undo(c)}>{undoLabel(c)}</button>
                    </div>
                  </td>
                </tr>
                {isActive && (
                  <tr>
                    <td colSpan={6}>
                      <div className="cash-banner-form" style={{ flexWrap: "wrap", padding: "6px 0" }}>
                        {active.action === "deposit" && (
                          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                            <option value="">¿A qué cuenta?</option>
                            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                        )}
                        {active.action === "endorse" && (
                          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                            <option value="">¿A qué proveedor?</option>
                            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        )}
                        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {active.action === "reject" ? "Rechazado el" : active.action === "debit" ? "Debitado el" : "Fecha"}
                          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                        </label>
                        {active.action === "reject" && (
                          <input placeholder="Motivo (ej. sin fondos)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 200 }} />
                        )}
                        <button disabled={busy} onClick={() => void confirm(c)}>
                          {active.action === "deposit" ? "Depositar" : active.action === "endorse" ? "Endosar" : active.action === "reject" ? "Marcar rechazado" : "Confirmar débito"}
                        </button>
                        <button className="secondary" onClick={() => setActive(null)}>Cancelar</button>
                      </div>
                      {active.action === "reject" && (
                        <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
                          {c.status === "deposited" ? `La plata sale de ${c.bankAccountName ?? "la cuenta donde se depositó"}` : "El cheque sale de la cartera"} y {c.customerName ?? "el cliente"} vuelve a deber {formatMoney(c.amount)}.
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function statusDetail(c: Cheque): string | null {
  const when = c.stepDate ? ` el ${formatDay(c.stepDate)}` : "";
  switch (c.status) {
    case "deposited": return `en ${c.bankAccountName ?? "el banco"}${when}`;
    case "endorsed": return `a ${c.supplierName ?? "un proveedor"}${when}`;
    case "rejected": return `${when.trim()}${c.notes ? ` · ${c.notes}` : ""}` || null;
    case "pending": return c.bankAccountName ? `de ${c.bankAccountName}` : null;
    case "debited": return `de ${c.bankAccountName ?? "el banco"}${when}`;
    default: return null;
  }
}

function formatCuit(cuit: string): string {
  const d = cleanCuit(cuit);
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : cuit;
}

function ReceiveForm({ customers, busy, onSubmit }: {
  customers: { id: string; name: string }[];
  busy: boolean;
  onSubmit: (input: { customerId: string; receivedOn: string; amount: number; number: string; bank?: string; payDate: string; echeq: boolean; drawerName?: string; drawerCuit?: string }) => void;
}) {
  const [customerId, setCustomerId] = useState("");
  const [receivedOn, setReceivedOn] = useState(localDateIso());
  const [form, setForm] = useState<ChequeForm>(EMPTY_CHEQUE);
  const [error, setError] = useState("");

  function submit() {
    if (!customerId) return setError("Elegí qué cliente te lo dio.");
    const read = readChequeForm(form);
    if ("error" in read) return setError(read.error);
    setError("");
    onSubmit({
      customerId,
      receivedOn,
      amount: read.amount,
      number: form.number.trim(),
      bank: form.bank.trim() || undefined,
      payDate: form.payDate,
      echeq: form.echeq,
      drawerName: form.drawerName.trim() || undefined,
      drawerCuit: cleanCuit(form.drawerCuit) || undefined
    });
  }

  return (
    <div className="panel" style={{ padding: 14, margin: "10px 0" }}>
      <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Recibí un cheque</p>
      <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">¿Qué cliente te lo dio?</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          Lo recibí el
          <input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        </label>
      </div>
      <ChequeFields value={form} onChange={setForm} />
      <p className="muted" style={{ margin: "8px 0", fontSize: 12 }}>La deuda del cliente baja ahora. El cheque queda en cartera hasta que lo deposites o se lo des a un proveedor.</p>
      {error && <p style={{ color: "#a52424", margin: "0 0 8px" }}>{error}</p>}
      <button disabled={busy} onClick={submit}>{busy ? "Guardando…" : "Guardar cheque"}</button>
    </div>
  );
}

function IssueForm({ suppliers, accounts, busy, onSubmit }: {
  suppliers: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  busy: boolean;
  onSubmit: (input: { supplierId: string; issuedOn: string; amount: number; number: string; payDate: string; echeq: boolean; bankAccountId: string }) => void;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [issuedOn, setIssuedOn] = useState(localDateIso());
  const [form, setForm] = useState<ChequeForm>(EMPTY_CHEQUE);
  const [error, setError] = useState("");

  function submit() {
    if (!supplierId) return setError("Elegí a qué proveedor se lo diste.");
    if (!bankAccountId) return setError("Elegí de qué cuenta del banco sale.");
    const read = readChequeForm(form);
    if ("error" in read) return setError(read.error);
    setError("");
    onSubmit({ supplierId, issuedOn, amount: read.amount, number: form.number.trim(), payDate: form.payDate, echeq: form.echeq, bankAccountId });
  }

  return (
    <div className="panel" style={{ padding: 14, margin: "10px 0" }}>
      <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Di un cheque propio</p>
      <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">¿A qué proveedor?</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
          <option value="">¿De qué cuenta sale?</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          Lo di el
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
        </label>
      </div>
      <ChequeFields value={form} onChange={setForm} withDrawer={false} />
      <p className="muted" style={{ margin: "8px 0", fontSize: 12 }}>Lo que le debés al proveedor baja ahora. La plata sale del banco en la fecha del cheque: el sistema te avisa una semana antes.</p>
      {error && <p style={{ color: "#a52424", margin: "0 0 8px" }}>{error}</p>}
      <button disabled={busy} onClick={submit}>{busy ? "Guardando…" : "Guardar cheque"}</button>
    </div>
  );
}
