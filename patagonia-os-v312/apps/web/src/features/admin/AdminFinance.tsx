import { useCallback, useEffect, useMemo, useState } from "react";
import { parseAmount } from "../../lib/money";
import {
  addPlatformAdmin,
  deleteFinanceMovement,
  disconnectMeta,
  getMetaStatus,
  saveMetaSettings,
  syncMetaAds,
  type MetaStatus,
  deleteFinanceRecurring,
  financeTransfer,
  getFinanceOverview,
  importFinancePayments,
  saveFinanceAccount,
  saveFinanceMovement,
  saveFinancePartners,
  saveFinanceRecurring
} from "./admin-service";
import {
  EXPENSE_CATEGORIES,
  formatCurrency,
  investmentStatus,
  KIND_LABELS,
  monthSummary,
  partnerSplit,
  type Currency,
  type FinAccount,
  type FinKind,
  type FinOverview,
  type FinPartner
} from "./finance";

/**
 * Finanzas de Patagonia OS como empresa: saldos de cada cuenta, la inversión de los socios, el resultado del mes y
 * lo que le toca a cada uno. Los abonos de los clientes entran solos (migración 158). Lo técnico va en "Configuración".
 */

const MONTHS_LONG = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function todayIso() {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

function errorText(err: unknown) {
  if (err instanceof Error) return err.message;
  return typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "No se pudo guardar.";
}

type FormKind = "gasto" | "ingreso" | "aporte" | "retiro" | "sueldo" | "transferencia";
const FORM_KINDS: FormKind[] = ["gasto", "ingreso", "aporte", "retiro", "sueldo", "transferencia"];

export function AdminFinance() {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [data, setData] = useState<FinOverview | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getFinanceOverview(month));
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Gasto de Meta: al abrir la pestaña, si está conectado y hoy todavía no se trajo, se trae solo.
  useEffect(() => {
    let cancelled = false;
    getMetaStatus()
      .then(async (st) => {
        if (cancelled || !st.connected || st.lastSyncUntil === todayIso()) return;
        await syncMetaAds();
        if (!cancelled) void reload();
      })
      .catch((err) => !cancelled && setMessage(`Meta: ${errorText(err)}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accountById = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a])), [data]);
  const partnerById = useMemo(() => new Map((data?.partners ?? []).map((p) => [p.id, p])), [data]);
  const summary = useMemo(() => (data ? monthSummary(data.movements, data.accounts) : []), [data]);
  const investment = useMemo(() => (data ? investmentStatus(data) : []), [data]);

  if (!data) return <p className="muted">{loading ? "Cargando finanzas…" : message}</p>;

  const activeAccounts = data.accounts.filter((a) => a.active);
  const monthLabel = `${MONTHS_LONG[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {message && <p className="setting-help">{message}</p>}

      {activeAccounts.length === 0 ? (
        <section className="panel">
          <h2>Primero, las cuentas</h2>
          <p className="muted">Cargá dónde está la plata del negocio (banco, Mercado Pago, efectivo, dólares). Marcá en cuál entran los abonos de los clientes: se anotan solos.</p>
          <AccountForm onSaved={(t) => { setMessage(t); void reload(); }} />
        </section>
      ) : (
        <>
          <section className="admin-kpis">
            {activeAccounts.map((a) => (
              <div key={a.id} className="kpi-card">
                <span>{a.name}{a.receivesPayments ? " · abonos" : ""}</span>
                <strong>{formatCurrency(a.balance, a.currency)}</strong>
              </div>
            ))}
            {investment.map((i) => (
              <div key={i.currency} className="kpi-card">
                <span>Inversión ({i.currency}): aportado {formatCurrency(i.contributed, i.currency)} · gastado {formatCurrency(i.spent, i.currency)}</span>
                <strong>Queda {formatCurrency(i.left, i.currency)}</strong>
              </div>
            ))}
          </section>

          <section className="panel">
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <h2 style={{ margin: 0 }}>Resultado de {monthLabel}</h2>
              <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            </div>
            {summary.length === 0 ? (
              <p className="muted">Sin ingresos ni gastos este mes.</p>
            ) : (
              summary.map((s) => (
                <div key={s.currency} style={{ marginTop: 12 }}>
                  <table>
                    <tbody>
                      <tr><td>Ingresos</td><td className="num">{formatCurrency(s.income, s.currency)}</td></tr>
                      {s.byCategory.map((c) => (
                        <tr key={c.category}><td className="muted">− {c.category}</td><td className="num">{formatCurrency(c.amount, s.currency)}</td></tr>
                      ))}
                      {s.salaries > 0 && <tr><td className="muted">− Sueldos</td><td className="num">{formatCurrency(s.salaries, s.currency)}</td></tr>}
                      <tr><td><strong>Resultado</strong></td><td className="num"><strong>{formatCurrency(s.result, s.currency)}</strong></td></tr>
                      {partnerSplit(s.result, data.partners).map((x) => (
                        <tr key={x.partner.id}><td className="muted">Le toca a {x.partner.name} ({x.partner.sharePct}%)</td><td className="num">{formatCurrency(x.amount, s.currency)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <h2>Cargar un movimiento</h2>
            <MovementForm accounts={activeAccounts} partners={data.partners} onSaved={(t) => { setMessage(t); void reload(); }} />
          </section>

          <section className="panel">
            <h2>Movimientos de {monthLabel}</h2>
            {data.movements.length === 0 ? (
              <p className="muted">Todavía no hay movimientos este mes.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th>Cuenta</th><th className="num">Monto</th><th></th></tr>
                </thead>
                <tbody>
                  {data.movements.map((m) => {
                    const account = accountById.get(m.accountId);
                    const partner = m.partnerId ? partnerById.get(m.partnerId) : null;
                    return (
                      <tr key={m.id}>
                        <td>{m.date.split("-").reverse().join("/")}</td>
                        <td>{KIND_LABELS[m.kind]}{m.recurring ? " (fijo)" : ""}</td>
                        <td>
                          {[m.category, m.description, partner?.name].filter(Boolean).join(" · ")}
                          {m.fromInvestment && <span className="muted"> · con la inversión</span>}
                        </td>
                        <td>{account?.name ?? "—"}</td>
                        <td className="num" style={{ color: m.direction === "out" ? "#8b1e1e" : undefined }}>
                          {m.direction === "out" ? "−" : "+"}{formatCurrency(m.amount, account?.currency ?? "ARS")}
                        </td>
                        <td>
                          {m.fromPayment ? (
                            <span className="muted" title="Se borra desde el cliente">abono</span>
                          ) : (
                            <button
                              className="link-button"
                              onClick={async () => {
                                if (!window.confirm(m.transferId ? "¿Borrar esta transferencia (las dos puntas)?" : "¿Borrar este movimiento?")) return;
                                try {
                                  await deleteFinanceMovement(m.id);
                                  setMessage("Movimiento borrado.");
                                  void reload();
                                } catch (err) {
                                  setMessage(errorText(err));
                                }
                              }}
                            >
                              Borrar
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <details className="panel">
            <summary><strong>Gastos fijos de todos los meses</strong> ({data.recurring.filter((r) => r.active).length})</summary>
            <p className="muted">Se anotan solos el día de cada mes (Supabase, Netlify, Claude, dominio…).</p>
            <table>
              <tbody>
                {data.recurring.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className="muted">{r.category} · día {r.dayOfMonth}{r.fromInvestment ? " · con la inversión" : ""}</td>
                    <td className="num">{formatCurrency(r.amount, accountById.get(r.accountId)?.currency ?? "ARS")}</td>
                    <td>
                      <button className="link-button" onClick={async () => {
                        if (!window.confirm(`¿Sacar "${r.name}" de los gastos fijos? Los ya anotados quedan.`)) return;
                        await deleteFinanceRecurring(r.id).catch((err) => setMessage(errorText(err)));
                        void reload();
                      }}>Sacar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <RecurringForm accounts={activeAccounts} onSaved={(t) => { setMessage(t); void reload(); }} />
          </details>

          <details className="panel">
            <summary><strong>Configuración</strong>: cuentas, socios, cobros anteriores y administradores</summary>
            <h3>Cuentas</h3>
            {data.accounts.map((a) => <AccountForm key={a.id} account={a} onSaved={(t) => { setMessage(t); void reload(); }} />)}
            <AccountForm onSaved={(t) => { setMessage(t); void reload(); }} />
            <h3>Socios</h3>
            <PartnersForm partners={data.partners} onSaved={(t) => { setMessage(t); void reload(); }} />
            <h3>Abonos registrados antes</h3>
            <ImportPayments onDone={(t) => { setMessage(t); void reload(); }} />
            <h3>Publicidad de Meta</h3>
            <MetaConnect accounts={activeAccounts} onChange={(t) => { setMessage(t); void reload(); }} />
            <h3>Agregar administrador</h3>
            <AddAdmin />
          </details>
        </>
      )}
    </div>
  );
}

function MovementForm({ accounts, partners, onSaved }: { accounts: FinAccount[]; partners: FinPartner[]; onSaved: (text: string) => void }) {
  const [kind, setKind] = useState<FormKind>("gasto");
  const [date, setDate] = useState(todayIso());
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(accounts[1]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [amountTo, setAmountTo] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [partnerId, setPartnerId] = useState(partners[0]?.id ?? "");
  const [fromInvestment, setFromInvestment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const from = accounts.find((a) => a.id === accountId);
  const to = accounts.find((a) => a.id === toAccountId);
  const needsPartner = kind === "aporte" || kind === "retiro" || kind === "sueldo";

  async function save() {
    setError("");
    const value = parseAmount(amount);
    if (!(value > 0)) return setError("Escribí el monto.");
    setBusy(true);
    try {
      if (kind === "transferencia") {
        const valueTo = from?.currency === to?.currency ? value : parseAmount(amountTo);
        if (!(valueTo > 0)) throw new Error("Escribí cuánto entró en la otra cuenta.");
        await financeTransfer({ date, fromId: accountId, toId: toAccountId, amountFrom: value, amountTo: valueTo, description });
      } else {
        await saveFinanceMovement({
          id: null, date, accountId, kind: kind as FinKind, amount: value,
          category: kind === "gasto" ? category || "Otros" : kind === "aporte" ? "Aporte de capital" : category,
          description, partnerId: needsPartner ? partnerId : null, fromInvestment: kind === "gasto" && fromInvestment
        });
      }
      setAmount("");
      setAmountTo("");
      setDescription("");
      onSaved(`${KIND_LABELS[kind]} guardado.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FORM_KINDS.map((k) => (
          <button key={k} className={kind === k ? "" : "secondary"} onClick={() => setKind(k)}>{KIND_LABELS[k]}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{kind === "transferencia" ? "De: " : ""}{a.name} ({a.currency})</option>)}
        </select>
        {kind === "transferencia" && (
          <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>A: {a.name} ({a.currency})</option>)}
          </select>
        )}
        <input type="text" inputMode="decimal" placeholder={`Monto (${from?.currency ?? "ARS"})`} value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 140 }} />
        {kind === "transferencia" && from && to && from.currency !== to.currency && (
          <input type="text" inputMode="decimal" placeholder={`Entró (${to.currency})`} value={amountTo} onChange={(e) => setAmountTo(e.target.value)} style={{ width: 140 }} />
        )}
        {needsPartner && (
          <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {kind === "gasto" && (
          <>
            <input list="fin-categories" placeholder="Categoría" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 180 }} />
            <datalist id="fin-categories">{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
          </>
        )}
        <input placeholder="Detalle (ej. Meta Ads, notebook)" value={description} onChange={(e) => setDescription(e.target.value)} style={{ minWidth: 200, flex: 1 }} />
      </div>
      {kind === "gasto" && (
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={fromInvestment} onChange={(e) => setFromInvestment(e.target.checked)} />
          Se pagó con la plata de la inversión
        </label>
      )}
      <div>
        <button disabled={busy || accounts.length === 0} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar"}</button>
        {error && <span className="setting-help" style={{ marginLeft: 8 }}>{error}</span>}
      </div>
    </div>
  );
}

function RecurringForm({ accounts, onSaved }: { accounts: FinAccount[]; onSaved: (text: string) => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Servidores");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [day, setDay] = useState("1");
  const [fromInvestment, setFromInvestment] = useState(false);
  const [error, setError] = useState("");
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
      <input placeholder="Nombre (ej. Supabase)" value={name} onChange={(e) => setName(e.target.value)} />
      <input list="fin-categories" placeholder="Categoría" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 160 }} />
      <input type="text" inputMode="decimal" placeholder="Monto" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 120 }} />
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
      </select>
      <label>Día <input type="text" inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 50 }} /></label>
      <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={fromInvestment} onChange={(e) => setFromInvestment(e.target.checked)} /> con la inversión</label>
      <button className="secondary" onClick={async () => {
        setError("");
        const value = parseAmount(amount);
        if (!name.trim() || !(value > 0)) return setError("Poné nombre y monto.");
        try {
          await saveFinanceRecurring({ id: null, name, category, amount: value, accountId, dayOfMonth: Math.min(28, Math.max(1, Number(day) || 1)), fromInvestment });
          setName("");
          setAmount("");
          onSaved("Gasto fijo agregado.");
        } catch (err) {
          setError(errorText(err));
        }
      }}>+ Agregar gasto fijo</button>
      {error && <span className="setting-help">{error}</span>}
    </div>
  );
}

function AccountForm({ account, onSaved }: { account?: FinAccount; onSaved: (text: string) => void }) {
  const [name, setName] = useState(account?.name ?? "");
  const [currency, setCurrency] = useState<Currency>(account?.currency ?? "ARS");
  const [opening, setOpening] = useState(account ? String(account.openingBalance) : "");
  const [receives, setReceives] = useState(account?.receivesPayments ?? false);
  const [active, setActive] = useState(account?.active ?? true);
  const [error, setError] = useState("");
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
      <input placeholder="Nombre (ej. Banco Galicia)" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
        <option value="ARS">Pesos</option>
        <option value="USD">Dólares</option>
      </select>
      <input type="text" inputMode="decimal" placeholder="Saldo inicial" value={opening} onChange={(e) => setOpening(e.target.value)} style={{ width: 130 }} />
      <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={receives} onChange={(e) => setReceives(e.target.checked)} /> acá entran los abonos</label>
      {account && <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> activa</label>}
      <button className="secondary" onClick={async () => {
        setError("");
        if (!name.trim()) return setError("Poné un nombre.");
        try {
          await saveFinanceAccount({ id: account?.id ?? null, name, currency, openingBalance: opening.trim() ? parseAmount(opening) : 0, receivesPayments: receives, active });
          if (!account) {
            setName("");
            setOpening("");
          }
          onSaved(account ? "Cuenta guardada." : "Cuenta agregada.");
        } catch (err) {
          setError(errorText(err));
        }
      }}>{account ? "Guardar" : "+ Agregar cuenta"}</button>
      {error && <span className="setting-help">{error}</span>}
    </div>
  );
}

function PartnersForm({ partners, onSaved }: { partners: FinPartner[]; onSaved: (text: string) => void }) {
  const [rows, setRows] = useState(partners.map((p) => ({ ...p, pct: String(p.sharePct) })));
  const [error, setError] = useState("");
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((r, i) => (
        <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input type="text" inputMode="decimal" value={r.pct} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} style={{ width: 70 }} /> %
        </div>
      ))}
      <div>
        <button className="secondary" onClick={async () => {
          setError("");
          try {
            await saveFinancePartners(rows.map((r) => ({ id: r.id, name: r.name, sharePct: Number(r.pct.replace(",", ".")) })));
            onSaved("Socios guardados.");
          } catch (err) {
            setError(errorText(err));
          }
        }}>Guardar socios</button>
        {error && <span className="setting-help" style={{ marginLeft: 8 }}>{error}</span>}
      </div>
    </div>
  );
}

function ImportPayments({ onDone }: { onDone: (text: string) => void }) {
  const [from, setFrom] = useState("2026-09-01");
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span className="muted">Traer como ingreso los abonos registrados desde</span>
      <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      <button className="secondary" onClick={async () => {
        try {
          const n = await importFinancePayments(from);
          onDone(n === 0 ? "No había abonos nuevos para traer." : `Se trajeron ${n} abonos como ingreso.`);
        } catch (err) {
          onDone(errorText(err));
        }
      }}>Traer abonos</button>
    </div>
  );
}

function AddAdmin() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <p className="muted">Un socio administrador ve y maneja todo este panel: clientes, cobros, ventas y finanzas.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="email" placeholder="Mail" value={email} onChange={(e) => setEmail(e.target.value)} style={{ minWidth: 240 }} />
        <button className="secondary" disabled={busy} onClick={async () => {
          if (!window.confirm(`¿Crear la cuenta de administrador de Patagonia para ${email}? Va a ver todo el panel.`)) return;
          setBusy(true);
          setResult("");
          try {
            const r = await addPlatformAdmin(email, name);
            setResult(`Listo. Entra en app.patagoniasystem.com.ar con ${r.email} y la contraseña temporal ${r.tempPassword} (pedile que la cambie al entrar).`);
            setEmail("");
            setName("");
          } catch (err) {
            setResult(errorText(err));
          } finally {
            setBusy(false);
          }
        }}>{busy ? "Creando…" : "Crear administrador"}</button>
      </div>
      {result && <p className="setting-help">{result}</p>}
    </div>
  );
}

/** Conectar la cuenta publicitaria de Meta (solo lectura): el gasto de cada campaña entra solo como Publicidad. */
function MetaConnect({ accounts, onChange }: { accounts: FinAccount[]; onChange: (text: string) => void }) {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [adAccount, setAdAccount] = useState("235768739");
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState(accounts.find((a) => a.currency === "ARS")?.id ?? accounts[0]?.id ?? "");
  const [fromInvestment, setFromInvestment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const st = await getMetaStatus().catch(() => null);
    setStatus(st);
    if (st?.connected) {
      setAdAccount(st.adAccountId ?? "");
      setAccountId(st.accountId ?? "");
      setFromInvestment(Boolean(st.fromInvestment));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError("");
    try {
      onChange(await action());
      setToken("");
      await load();
    } catch (err) {
      setError(errorText(err));
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <p className="muted">
        Con una clave de solo lectura (permiso ads_read), lo que gasta cada campaña entra solo como gasto de Publicidad, uno por campaña y por día.
        Meta informa el gasto sin impuestos: el IVA y las percepciones de la tarjeta se cargan aparte. El sistema no puede crear ni cambiar publicidades.
      </p>
      {status?.connected && (
        <p className="setting-help">
          Conectada la cuenta {status.adAccountId} (clave terminada en {status.tokenEnd}).
          {status.lastSyncUntil ? ` Traído hasta el ${status.lastSyncUntil.split("-").reverse().join("/")}.` : " Todavía no se trajo nada."}
          {status.lastError ? ` Último error: ${status.lastError}` : ""}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Cuenta publicitaria" value={adAccount} onChange={(e) => setAdAccount(e.target.value)} style={{ width: 140 }} />
        <input type="password" autoComplete="off" placeholder={status?.connected ? "Clave nueva (dejar vacío para no cambiarla)" : "Pegá la clave de acceso"} value={token} onChange={(e) => setToken(e.target.value)} style={{ minWidth: 260, flex: 1 }} />
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => <option key={a.id} value={a.id}>Sale de: {a.name} ({a.currency})</option>)}
        </select>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={fromInvestment} onChange={(e) => setFromInvestment(e.target.checked)} /> con la inversión</label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="secondary" disabled={busy} onClick={() => void run(async () => {
          await saveMetaSettings({ adAccountId: adAccount, token: token.trim() || null, accountId, fromInvestment });
          const r = await syncMetaAds();
          return `Meta conectado. Se anotaron ${r.saved ?? 0} gastos de campañas desde el ${(r.since ?? "").split("-").reverse().join("/")}.`;
        })}>{status?.connected ? "Guardar y traer gasto" : "Conectar Meta"}</button>
        {status?.connected && (
          <>
            <button className="secondary" disabled={busy} onClick={() => void run(async () => {
              const r = await syncMetaAds();
              return `Gasto de Meta actualizado (${r.saved ?? 0} días de campañas).`;
            })}>Traer gasto ahora</button>
            <button className="link-button" disabled={busy} onClick={() => {
              if (!window.confirm("¿Desconectar Meta? Los gastos ya anotados quedan.")) return;
              void run(async () => {
                await disconnectMeta();
                return "Meta desconectado.";
              });
            }}>Desconectar</button>
          </>
        )}
      </div>
      {error && <p className="setting-help">{error}</p>}
    </div>
  );
}
