import { useEffect, useMemo, useState } from "react";
import { quantityNumber } from "../sale/quantity";
import { localDateIso } from "../shifts/format";
import { FrigoLabels } from "./FrigoParts";
import { errorText, type FrigoData } from "./FrigoShared";
import { byOldest, formatKg, nextGarron, nextTropa, slaughterRows, type FrigoDt } from "./frigo-logic";
import { slaughter } from "./frigo-service";

// Faena: el DT se convierte en 2 medias por animal; cada una lleva tropa,
// garrón (lo pone la base, correlativo del día) y kilos, y entra a una cámara.

interface Row {
  animal: number;
  side: 1 | 2;
  kg: string;
  camaraId: string;
}

export function FrigoFaena({ data, dtId, onSelectDt, onChanged }: {
  data: FrigoData;
  dtId: string | null;
  onSelectDt: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const pending = data.dts.filter((d) => d.status === "pendiente");
  const dt = pending.find((d) => d.id === dtId) ?? null;
  const camaras = data.camaras.filter((c) => c.active);
  const [labelsTropa, setLabelsTropa] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  return (
    <>
      {message && <div className="message">{message}</div>}
      {labelsTropa != null && (
        <FrigoLabels
          title={`Etiquetas · tropa ${labelsTropa}`}
          medias={data.medias.filter((m) => m.tropa === labelsTropa).sort(byOldest)}
          data={data}
          onClose={() => setLabelsTropa(null)}
        />
      )}

      {camaras.length === 0 ? (
        <div className="message">Antes de faenar, cargá las cámaras en la pestaña Cámaras.</div>
      ) : dt ? (
        <FaenaForm
          key={dt.id}
          dt={dt}
          data={data}
          onCancel={() => onSelectDt(null)}
          onDone={async (tropa, text) => {
            await onChanged();
            onSelectDt(null);
            setLabelsTropa(tropa);
            setMessage(text);
          }}
        />
      ) : (
        <section className="panel" style={{ marginTop: labelsTropa != null ? 18 : 0 }}>
          <div className="panel-title"><h2>Elegí el DT a faenar</h2></div>
          {pending.length === 0 ? (
            <p className="muted">No hay DT pendientes. Cargá uno en “DT de carga”.</p>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {pending.map((d) => (
                <button key={d.id} onClick={() => { setMessage(""); onSelectDt(d.id); }}>
                  {d.dtNumber} · {d.producer} · {d.heads} {d.category.toLowerCase()} → {d.heads * 2} medias
                </button>
              ))}
            </div>
          )}
          <TropaList data={data} onLabels={setLabelsTropa} />
        </section>
      )}
    </>
  );
}

function TropaList({ data, onLabels }: { data: FrigoData; onLabels: (tropa: number) => void }) {
  const done = data.dts.filter((d) => d.status === "faenado" && d.tropa != null).slice(-10).reverse();
  if (done.length === 0) return null;
  return (
    <>
      <h3 style={{ margin: "18px 0 8px" }}>Últimas tropas faenadas</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {done.map((d) => (
          <button key={d.id} className="secondary" onClick={() => onLabels(d.tropa as number)}>
            Etiquetas tropa {d.tropa} · {d.producer}
          </button>
        ))}
      </div>
    </>
  );
}

function FaenaForm({ dt, data, onCancel, onDone }: {
  dt: FrigoDt;
  data: FrigoData;
  onCancel: () => void;
  onDone: (tropa: number, message: string) => Promise<void>;
}) {
  const camaras = data.camaras.filter((c) => c.active);
  const [tropa, setTropa] = useState(String(nextTropa(data.dts)));
  const [date, setDate] = useState(localDateIso());
  const [allCamara, setAllCamara] = useState(camaras[0]?.id ?? "");
  const [rows, setRows] = useState<Row[]>(() => slaughterRows(dt.heads).map((r) => ({ ...r, kg: "", camaraId: camaras[0]?.id ?? "" })));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // Garrón que va a tener la primera media: lo confirma la base al guardar.
  const firstGarron = useMemo(() => nextGarron(data.medias, date), [data.medias, date]);
  const weighed = rows.filter((r) => quantityNumber(r.kg) > 0);
  const totalKg = weighed.reduce((t, r) => t + quantityNumber(r.kg), 0);

  useEffect(() => setMessage(""), [date]);

  function setRow(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function applyCamara(id: string) {
    setAllCamara(id);
    setRows((prev) => prev.map((r) => ({ ...r, camaraId: id })));
  }

  async function confirm() {
    const tropaN = Math.round(quantityNumber(tropa));
    if (!(tropaN > 0)) return setMessage("Poné el número de tropa.");
    const missing = rows.map((r, i) => ({ r, garron: firstGarron + i })).filter(({ r }) => !(quantityNumber(r.kg) > 0));
    if (missing.length) {
      return setMessage(`Faltan pesar ${missing.length} medias (garrón ${missing.slice(0, 6).map((m) => m.garron).join(", ")}${missing.length > 6 ? "…" : ""}).`);
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await slaughter({
        dtId: dt.id,
        tropa: tropaN,
        date,
        medias: rows.map((r) => ({ kg: Math.round(quantityNumber(r.kg) * 10) / 10, camaraId: r.camaraId }))
      });
      await onDone(tropaN, `Tropa ${result.tropa} faenada: garrones ${result.first_garron} al ${result.last_garron}, ${formatKg(Number(result.total_kg))} kg. Ya están las etiquetas.`);
    } catch (err) {
      setMessage(errorText(err, "No se pudo guardar la faena."));
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-title" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>{dt.dtNumber} · {dt.producer} · {dt.heads} animales → {dt.heads * 2} medias</h2>
        <button className="secondary" onClick={onCancel} disabled={busy}>Cancelar</button>
      </div>
      <div className="cash-banner-form" style={{ flexWrap: "wrap", alignItems: "end" }}>
        <label className="field" style={{ width: 120 }}>Tropa<input inputMode="numeric" value={tropa} onChange={(e) => setTropa(e.target.value)} /></label>
        <label className="field" style={{ width: 160 }}>Fecha de faena<input type="date" value={date} onChange={(e) => setDate(e.target.value || localDateIso())} /></label>
        <label className="field" style={{ width: 180 }}>
          Cámara para todas
          <select value={allCamara} onChange={(e) => applyCamara(e.target.value)}>
            {camaras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <span className="muted" style={{ paddingBottom: 10 }}>{weighed.length} de {rows.length} pesadas · {formatKg(totalKg)} kg</span>
      </div>

      <div style={{ overflowX: "auto", marginTop: 12 }}>
        <table className="data-table">
          <thead><tr><th>Garrón</th><th>Animal</th><th>Media</th><th className="num">Kilos</th><th>Cámara</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><strong>{firstGarron + i}</strong></td>
                <td>{r.animal}</td>
                <td>{r.side} de 2</td>
                <td className="num">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={r.kg}
                    placeholder="0,0"
                    style={{ width: 90, textAlign: "right" }}
                    aria-label={`Kilos garrón ${firstGarron + i}`}
                    onChange={(e) => setRow(i, { kg: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      const next = document.querySelector<HTMLInputElement>(`[aria-label="Kilos garrón ${firstGarron + i + 1}"]`);
                      next?.focus();
                    }}
                  />
                </td>
                <td>
                  <select value={r.camaraId} onChange={(e) => setRow(i, { camaraId: e.target.value })} aria-label={`Cámara garrón ${firstGarron + i}`}>
                    {camaras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Enter pasa a la media siguiente. El garrón queda confirmado al guardar (si otra persona faenó antes, sigue desde el último del día).</p>
      {message && <div className="message">{message}</div>}
      <button onClick={() => void confirm()} disabled={busy}>{busy ? "Guardando…" : "Confirmar faena y hacer etiquetas"}</button>
    </section>
  );
}
