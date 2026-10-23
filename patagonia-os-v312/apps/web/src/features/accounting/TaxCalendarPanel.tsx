import { useState } from "react";
import { deleteTaxReminder, saveTaxReminder, saveTaxSettings } from "./accounting-service";
import type { IibbSettings } from "./iibb";
import { OBLIGATION_LABELS, daysLeftLabel, defaultObligations, dueDateLabel, type DueItem, type Obligation, type TaxReminder } from "./tax-calendar";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return fallback;
}

const ALL_OBLIGATIONS: Obligation[] = ["iva", "monotributo", "empleadores", "autonomos"];

/** Próximos vencimientos + qué se le recuerda a este negocio (migración 156). */
export function TaxCalendarPanel({
  dues,
  missingCuit,
  taxCondition,
  settings,
  reminders,
  canWrite,
  onChanged
}: {
  dues: DueItem[];
  missingCuit: boolean;
  taxCondition: string | null;
  settings: (IibbSettings & { obligations: Obligation[] | null }) | null;
  reminders: TaxReminder[];
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = settings?.obligations ?? defaultObligations(taxCondition);

  async function toggleObligation(o: Obligation, on: boolean) {
    setBusy(true);
    setError("");
    try {
      const next = on ? [...new Set([...chosen, o])] : chosen.filter((x) => x !== o);
      await saveTaxSettings({
        regime: settings?.regime ?? "local",
        jurisdictions: settings?.jurisdictions ?? [],
        base: settings?.base ?? "invoiced",
        dueDay: settings?.dueDay ?? null,
        obligations: next
      });
      onChanged("Vencimientos actualizados.");
    } catch (err) {
      setError(errorText(err, "No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  }

  async function addReminder() {
    const d = Number(day);
    if (!title.trim() || !Number.isInteger(d) || d < 1 || d > 31) {
      setError("Poné qué hay que pagar y el día del mes (1 a 31).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveTaxReminder({ title: title.trim(), dayOfMonth: d, active: true });
      setTitle("");
      setDay("");
      onChanged("Recordatorio agregado.");
    } catch (err) {
      setError(errorText(err, "No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  }

  async function removeReminder(r: TaxReminder) {
    if (!window.confirm(`¿Borrar el recordatorio "${r.title}"?`)) return;
    try {
      await deleteTaxReminder(r.id);
      onChanged("Recordatorio borrado.");
    } catch (err) {
      setError(errorText(err, "No se pudo borrar."));
    }
  }

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Próximos vencimientos</h2>
        {canWrite && (
          <button className="secondary" onClick={() => setConfigOpen((v) => !v)}>{configOpen ? "Listo" : "Qué me recuerda"}</button>
        )}
      </div>
      {missingCuit && <div className="message">Para ubicar tus fechas de ARCA hace falta el CUIT del negocio (Facturas → Datos fiscales).</div>}
      {dues.length === 0 ? (
        <p className="muted">No hay vencimientos en los próximos 45 días.</p>
      ) : (
        <table className="data-table">
          <tbody>
            {dues.map((d) => (
              <tr key={`${d.date}-${d.title}`}>
                <td style={{ whiteSpace: "nowrap" }}>
                  <strong>{dueDateLabel(d.date)}</strong>
                  <div className={d.daysLeft <= 3 ? "num-negative" : "muted"} style={{ fontSize: 12 }}>{daysLeftLabel(d.daysLeft)}</div>
                </td>
                <td>{d.title}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {d.kind === "oficial" ? "Fecha de ARCA" : d.kind === "estimada" ? "Estimada: ARCA todavía no publicó ese mes, confirmala" : "Recordatorio tuyo"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {configOpen && canWrite && (
        <div className="panel" style={{ padding: 14, marginTop: 12, background: "#fafafa", display: "grid", gap: 12 }}>
          <div>
            <strong>Fechas de ARCA que te recuerda</strong>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
              {ALL_OBLIGATIONS.map((o) => (
                <label key={o} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" disabled={busy} checked={chosen.includes(o)} onChange={(e) => void toggleObligation(o, e.target.checked)} />
                  {OBLIGATION_LABELS[o]}
                </label>
              ))}
            </div>
            <p className="setting-help">Las fechas salen del calendario oficial de ARCA según la terminación de tu CUIT. Ingresos Brutos se configura en la pestaña Ingresos Brutos.</p>
          </div>
          <div>
            <strong>Tus recordatorios (todos los meses)</strong>
            {reminders.map((r) => (
              <div key={r.id} className="list-row">
                <span>Día {r.dayOfMonth}: {r.title}</span>
                <button className="link-button" onClick={() => void removeReminder(r)}>Borrar</button>
              </div>
            ))}
            <div className="cash-banner-form" style={{ marginTop: 6, flexWrap: "wrap" }}>
              <input placeholder="Qué hay que pagar (ej. alquiler, municipal)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: "1 1 220px" }} />
              <input placeholder="Día" inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 70 }} />
              <button disabled={busy} onClick={() => void addReminder()}>Agregar</button>
            </div>
          </div>
          {error && <div className="message" style={{ margin: 0 }}>{error}</div>}
        </div>
      )}
    </section>
  );
}
