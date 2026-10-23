import { useState } from "react";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import { addIibbCredit, deleteIibbCredit, saveTaxSettings, type AccountingMonth } from "./accounting-service";
import { IIBB_CREDIT_LABELS, IIBB_REGIME_LABELS, type IibbCredit, type IibbJurisdiction, type IibbRegime, type IibbResult, type IibbSettings } from "./iibb";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return fallback;
}

const num = (s: string) => {
  const n = parseAmount(s || "0");
  return Number.isFinite(n) ? n : NaN;
};

/** Ingresos Brutos del mes: configuración, cálculo y créditos (migración 156). */
export function IibbPanel({
  data,
  result,
  canWrite,
  onChanged
}: {
  data: AccountingMonth;
  result: IibbResult | null;
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const settings = data.iibb.settings;
  const [editing, setEditing] = useState(!settings || settings.jurisdictions.length === 0);
  const [regime, setRegime] = useState<IibbRegime>(settings?.regime ?? (data.company.taxCondition === "monotributo" ? "simplificado" : "local"));
  const [base, setBase] = useState<IibbSettings["base"]>(settings?.base ?? "invoiced");
  const [dueDay, setDueDay] = useState(settings?.dueDay ? String(settings.dueDay) : "");
  const [rows, setRows] = useState<{ name: string; rate: string; coefficient: string }[]>(
    settings && settings.jurisdictions.length > 0
      ? settings.jurisdictions.map((j) => ({ name: j.name, rate: String(j.rate).replace(".", ","), coefficient: String(j.coefficient).replace(".", ",") }))
      : [{ name: "Buenos Aires", rate: "", coefficient: "1" }]
  );
  const [credit, setCredit] = useState<{ kind: IibbCredit["kind"]; jurisdiction: string; amount: string; notes: string }>({ kind: "retencion", jurisdiction: "", amount: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    const jurisdictions: IibbJurisdiction[] = [];
    if (regime === "local" || regime === "convenio") {
      for (const r of rows) {
        if (!r.name.trim()) continue;
        const rate = num(r.rate);
        const coefficient = regime === "convenio" ? num(r.coefficient) : 1;
        if (!Number.isFinite(rate) || rate < 0 || rate > 20) return setError(`La alícuota de ${r.name} no es válida (ej. 3,5).`);
        if (!Number.isFinite(coefficient) || coefficient < 0 || coefficient > 1) return setError(`El coeficiente de ${r.name} tiene que estar entre 0 y 1 (ej. 0,65).`);
        jurisdictions.push({ name: r.name.trim(), rate, coefficient });
      }
      if (jurisdictions.length === 0) return setError("Poné al menos una provincia con su alícuota.");
    }
    const d = dueDay.trim() ? Number(dueDay) : null;
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > 31)) return setError("El día de vencimiento tiene que estar entre 1 y 31.");
    setBusy(true);
    try {
      await saveTaxSettings({ regime, jurisdictions, base, dueDay: d });
      setEditing(false);
      onChanged("Ingresos Brutos guardado.");
    } catch (err) {
      setError(errorText(err, "No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  }

  async function addCredit() {
    const amount = num(credit.amount);
    if (!Number.isFinite(amount) || amount <= 0) return setError("Poné el importe.");
    setBusy(true);
    setError("");
    try {
      await addIibbCredit({ period: data.period, kind: credit.kind, jurisdiction: credit.jurisdiction.trim() || null, amount, notes: credit.notes.trim() || null });
      setCredit({ kind: "retencion", jurisdiction: "", amount: "", notes: "" });
      onChanged("Crédito agregado.");
    } catch (err) {
      setError(errorText(err, "No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  }

  async function removeCredit(c: IibbCredit) {
    if (!window.confirm(`¿Borrar ${IIBB_CREDIT_LABELS[c.kind]} de ${formatMoney(c.amount)}?`)) return;
    try {
      await deleteIibbCredit(c.id);
      onChanged("Crédito borrado.");
    } catch (err) {
      setError(errorText(err, "No se pudo borrar."));
    }
  }

  return (
    <>
      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Ingresos Brutos del mes</h2>
          {canWrite && settings && !editing && <button className="secondary" onClick={() => setEditing(true)}>Cambiar datos</button>}
        </div>

        {editing && canWrite ? (
          <div style={{ display: "grid", gap: 10 }}>
            <label className="muted">
              Régimen
              <select value={regime} onChange={(e) => setRegime(e.target.value as IibbRegime)} style={{ width: "100%", maxWidth: 420 }}>
                {(Object.keys(IIBB_REGIME_LABELS) as IibbRegime[]).map((r) => (
                  <option key={r} value={r}>{IIBB_REGIME_LABELS[r]}</option>
                ))}
              </select>
            </label>
            {(regime === "local" || regime === "convenio") && (
              <>
                {rows.map((r, i) => (
                  <div key={i} className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                    <input placeholder="Provincia" value={r.name} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                    <input placeholder="Alícuota % (ej. 3,5)" inputMode="decimal" value={r.rate} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, rate: e.target.value } : x)))} style={{ width: 150 }} />
                    {regime === "convenio" && (
                      <input placeholder="Coeficiente (ej. 0,65)" inputMode="decimal" value={r.coefficient} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, coefficient: e.target.value } : x)))} style={{ width: 160 }} />
                    )}
                    {rows.length > 1 && <button className="link-button" onClick={() => setRows(rows.filter((_, k) => k !== i))}>Quitar</button>}
                  </div>
                ))}
                {regime === "convenio" && (
                  <button className="link-button" style={{ justifySelf: "start" }} onClick={() => setRows([...rows, { name: "", rate: "", coefficient: "" }])}>+ Otra provincia</button>
                )}
                <label className="muted">
                  Base imponible
                  <select value={base} onChange={(e) => setBase(e.target.value as IibbSettings["base"])} style={{ width: "100%", maxWidth: 420 }}>
                    <option value="invoiced">Lo facturado a ARCA (sin IVA)</option>
                    <option value="sales">Todas las ventas cargadas en el sistema</option>
                  </select>
                </label>
              </>
            )}
            <label className="muted">
              Día del mes en que vence (para recordártelo)
              <input inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value)} style={{ width: 80 }} placeholder="15" />
            </label>
            <p className="setting-help">La alícuota, el régimen y el coeficiente de Convenio los tiene tu contador. Si sos monotributista con régimen simplificado, Ingresos Brutos se paga en la cuota fija y no hace falta calcular nada.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar"}</button>
              {settings && <button className="secondary" onClick={() => setEditing(false)}>Cancelar</button>}
            </div>
          </div>
        ) : !settings ? (
          <p className="muted">Todavía no está configurado. Lo carga el dueño o un administrador.</p>
        ) : result && !result.applies ? (
          <p>{IIBB_REGIME_LABELS[settings.regime]}: no hay impuesto que calcular por mes.</p>
        ) : result ? (
          <>
            <table className="data-table" style={{ maxWidth: 640 }}>
              <thead>
                <tr>
                  <th>Provincia</th>
                  <th className="num">Base</th>
                  <th className="num">Alícuota</th>
                  <th className="num">Impuesto</th>
                </tr>
              </thead>
              <tbody>
                {result.lines.map((l) => (
                  <tr key={l.name}>
                    <td>{l.name}</td>
                    <td className="num">{formatMoney(l.base)}</td>
                    <td className="num">{String(l.rate).replace(".", ",")}%</td>
                    <td className="num">{formatMoney(l.tax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 13 }}>Base: {result.baseNote}.</p>
            <div className="totals" style={{ maxWidth: 640 }}>
              <span>Impuesto del mes <b>{formatMoney(result.tax)}</b></span>
              <span>− Percepciones de tus proveedores <b>{formatMoney(result.perceptions)}</b></span>
              <span>− Retenciones del banco (SIRCREB) <b>{formatMoney(result.bankWithholdings)}</b></span>
              <span>− Otros créditos <b>{formatMoney(result.credits)}</b></span>
              <strong>{result.balance >= 0 ? "A pagar (estimado)" : "Saldo a favor"} <b>{formatMoney(Math.abs(result.balance))}</b></strong>
            </div>
            <p className="setting-help">
              Las percepciones salen de las facturas de compra del mes. Las retenciones del banco salen de los resúmenes subidos a Conciliación ({data.iibb.bankWithholdingLines} renglones).
              Si tenés retenciones o pagos a cuenta que no están, cargalos abajo. El número final lo confirma tu contador en la declaración jurada.
            </p>
          </>
        ) : null}
        {error && <div className="message" style={{ marginTop: 10 }}>{error}</div>}
      </section>

      {settings && result?.applies && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Retenciones, percepciones y saldos a favor cargados a mano</h2>
          </div>
          {data.iibb.credits.length === 0 ? (
            <p className="muted">Ninguno este mes.</p>
          ) : (
            <table className="data-table" style={{ maxWidth: 720 }}>
              <tbody>
                {data.iibb.credits.map((c) => (
                  <tr key={c.id}>
                    <td>{IIBB_CREDIT_LABELS[c.kind]}</td>
                    <td>{c.jurisdiction ?? ""}</td>
                    <td className="muted">{c.notes ?? ""}</td>
                    <td className="num">{formatMoney(c.amount)}</td>
                    <td>{canWrite && <button className="link-button" onClick={() => void removeCredit(c)}>Borrar</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {canWrite && (
            <div className="cash-banner-form" style={{ marginTop: 10, flexWrap: "wrap" }}>
              <select value={credit.kind} onChange={(e) => setCredit({ ...credit, kind: e.target.value as IibbCredit["kind"] })}>
                {(Object.keys(IIBB_CREDIT_LABELS) as IibbCredit["kind"][]).map((k) => (
                  <option key={k} value={k}>{IIBB_CREDIT_LABELS[k]}</option>
                ))}
              </select>
              <input placeholder="Provincia (opcional)" value={credit.jurisdiction} onChange={(e) => setCredit({ ...credit, jurisdiction: e.target.value })} />
              <input placeholder="Importe" inputMode="decimal" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} style={{ width: 120 }} />
              <input placeholder="Nota (opcional)" value={credit.notes} onChange={(e) => setCredit({ ...credit, notes: e.target.value })} />
              <button disabled={busy} onClick={() => void addCredit()}>Agregar</button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
