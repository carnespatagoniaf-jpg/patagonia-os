import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { quantityNumber } from "../sale/quantity";
import { localDateIso } from "../shifts/format";
import { useActiveBranch } from "../branches/BranchProvider";
import { CamaraCards, errorText, type FrigoData } from "./FrigoShared";
import {
  CATEGORIES,
  byOldest,
  daysBetween,
  formatDay,
  formatKg,
  inStock,
  labelCode,
  remitoNumber,
  searchMedias,
  sideLabel,
  sumKg,
  type FrigoDt,
  type FrigoMedia
} from "./frigo-logic";
import { createDt, deleteDt, moveMedias, saveCamara } from "./frigo-service";

// Pestañas chicas del Frigorífico: DT de carga, Cámaras, Trazabilidad y las etiquetas.

/* ---------------- DT de carga ---------------- */

const EMPTY_DT = { dtNumber: "", dtDate: "", producer: "", renspa: "", origin: "", category: CATEGORIES[0], heads: "", notes: "" };

export function FrigoDts({ dts, onChanged, onFaenar }: { dts: FrigoDt[]; onChanged: () => Promise<void>; onFaenar: (dtId: string) => void }) {
  const { branchId } = useActiveBranch();
  const [form, setForm] = useState({ ...EMPTY_DT, dtDate: localDateIso() });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const heads = Math.round(quantityNumber(form.heads));
    if (!branchId) return setMessage("Elegí una sucursal.");
    if (!(heads > 0)) return setMessage("Poné cuántas cabezas trae el DT.");
    setBusy(true);
    try {
      await createDt({ ...form, branchId, heads });
      await onChanged();
      setForm({ ...EMPTY_DT, dtDate: form.dtDate });
      setMessage(`DT guardado: ${heads} animales para faenar.`);
    } catch (err) {
      setMessage(errorText(err, "No se pudo guardar el DT."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(dt: FrigoDt) {
    setBusy(true);
    try {
      await deleteDt(dt.id);
      await onChanged();
      setMessage(`DT ${dt.dtNumber} borrado.`);
    } catch (err) {
      setMessage(errorText(err, "No se pudo borrar el DT."));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: e.target.value });

  return (
    <>
      <form className="panel" onSubmit={submit}>
        <div className="panel-title"><h2>Nuevo DT de carga</h2></div>
        <p className="muted" style={{ marginTop: 0 }}>El DT dice qué vamos a faenar. La tropa se le pone en la faena.</p>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", alignItems: "end" }}>
          <label className="field" style={{ width: 170 }}>N.º de DT<input value={form.dtNumber} onChange={set("dtNumber")} required placeholder="DT-e 4471203" /></label>
          <label className="field" style={{ width: 150 }}>Fecha<input type="date" value={form.dtDate} onChange={set("dtDate")} required /></label>
          <label className="field" style={{ width: 220 }}>Productor<input value={form.producer} onChange={set("producer")} required /></label>
          <label className="field" style={{ width: 170 }}>RENSPA<input value={form.renspa} onChange={set("renspa")} /></label>
          <label className="field" style={{ width: 200 }}>Origen<input value={form.origin} onChange={set("origin")} placeholder="Localidad, provincia" /></label>
          <label className="field" style={{ width: 150 }}>
            Categoría
            <select value={form.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
          </label>
          <label className="field" style={{ width: 110 }}>Cabezas<input inputMode="numeric" value={form.heads} onChange={set("heads")} required /></label>
          <label className="field" style={{ width: 220 }}>Notas<input value={form.notes} onChange={set("notes")} /></label>
          <button type="submit" disabled={busy}>Guardar DT</button>
        </div>
        {message && <div className="message" style={{ marginTop: 10 }}>{message}</div>}
      </form>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title"><h2>DT cargados</h2></div>
        {dts.length === 0 ? (
          <p className="muted">Todavía no hay DT.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead><tr><th>DT</th><th>Fecha</th><th>Productor</th><th>Categoría</th><th className="num">Cabezas</th><th>Tropa</th><th>Estado</th></tr></thead>
              <tbody>
                {[...dts].reverse().map((d) => (
                  <tr key={d.id}>
                    <td>{d.dtNumber}</td>
                    <td>{formatDay(d.dtDate)}</td>
                    <td>
                      {d.producer}
                      {(d.renspa || d.origin) && <span className="muted" style={{ display: "block", fontSize: 12 }}>{[d.renspa && `RENSPA ${d.renspa}`, d.origin].filter(Boolean).join(" · ")}</span>}
                    </td>
                    <td>{d.category}</td>
                    <td className="num">{d.heads}</td>
                    <td>{d.tropa ?? "—"}</td>
                    <td>
                      {d.status === "pendiente" ? (
                        <span style={{ display: "flex", gap: 6 }}>
                          <button disabled={busy} onClick={() => onFaenar(d.id)}>Faenar</button>
                          <button className="link-button" disabled={busy} onClick={() => void remove(d)}>Borrar</button>
                        </span>
                      ) : (
                        <span className="muted">Faenado {formatDay(d.slaughterDate)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ---------------- Cámaras ---------------- */

export function FrigoCamaras({ data, onChanged }: { data: FrigoData; onChanged: () => Promise<void> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const nextNumber = data.camaras.reduce((max, c) => Math.max(max, c.number), 0) + 1;
  const [form, setForm] = useState({ number: "", name: "", capacity: "" });

  const today = localDateIso();
  const camaraName = useMemo(() => new Map(data.camaras.map((c) => [c.id, c.name])), [data.camaras]);
  const producerOf = useMemo(() => new Map(data.dts.map((d) => [d.id, d.producer])), [data.dts]);
  const stock = inStock(data.medias).filter((m) => !selected || m.camaraId === selected).sort(byOldest);
  const activeCamaras = data.camaras.filter((c) => c.active);

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    setMessage("");
    try {
      await work();
      await onChanged();
      setMessage(done);
    } catch (err) {
      setMessage(errorText(err, "No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  }

  function addCamara(event: FormEvent) {
    event.preventDefault();
    const number = Math.round(quantityNumber(form.number || String(nextNumber)));
    const capacity = form.capacity.trim() ? Math.round(quantityNumber(form.capacity)) : null;
    void run(async () => {
      await saveCamara({ id: null, number, name: form.name.trim() || `Cámara ${number}`, capacity, active: true });
      setForm({ number: "", name: "", capacity: "" });
    }, `Cámara ${number} agregada.`);
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title"><h2>Cámaras</h2></div>
        <p className="muted" style={{ marginTop: 0 }}>Tocá una cámara para ver solo lo que tiene adentro.</p>
        <CamaraCards data={data} selected={selected} onSelect={setSelected} />
        <form className="cash-banner-form" style={{ flexWrap: "wrap", alignItems: "end", marginTop: 14 }} onSubmit={addCamara}>
          <label className="field" style={{ width: 110 }}>Número<input inputMode="numeric" value={form.number} placeholder={String(nextNumber)} onChange={(e) => setForm({ ...form, number: e.target.value })} /></label>
          <label className="field" style={{ width: 200 }}>Nombre<input value={form.name} placeholder={`Cámara ${nextNumber}`} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field" style={{ width: 150 }}>Lugares (medias)<input inputMode="numeric" value={form.capacity} placeholder="80" onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></label>
          <button type="submit" className="secondary" disabled={busy}>Agregar cámara</button>
        </form>
        {data.camaras.some((c) => !c.active) && (
          <p className="muted" style={{ fontSize: 13 }}>
            Dadas de baja: {data.camaras.filter((c) => !c.active).map((c) => (
              <button key={c.id} className="link-button" disabled={busy} onClick={() => void run(() => saveCamara({ ...c, active: true }), `${c.name} activa de nuevo.`)}>{c.name} (activar)</button>
            ))}
          </p>
        )}
        {message && <div className="message" style={{ marginTop: 10 }}>{message}</div>}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2>{selected ? camaraName.get(selected) : "Todas las cámaras"} · {stock.length} medias · {formatKg(sumKg(stock))} kg</h2>
          {selected && (() => {
            const camara = data.camaras.find((c) => c.id === selected);
            return camara && stock.length === 0 ? (
              <button className="secondary" disabled={busy} onClick={() => void run(() => saveCamara({ ...camara, active: false }), `${camara.name} dada de baja.`).then(() => setSelected(null))}>Dar de baja la cámara</button>
            ) : null;
          })()}
        </div>
        {stock.length === 0 ? (
          <p className="muted">No hay medias acá.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead><tr><th>Tropa</th><th>Garrón</th><th>Faena</th><th className="num">Kilos</th><th>Productor</th><th className="num">Días</th><th>Cámara</th></tr></thead>
              <tbody>
                {stock.map((m) => {
                  const days = daysBetween(m.slaughterDate, today);
                  return (
                    <tr key={m.id}>
                      <td>{m.tropa}</td>
                      <td>{m.garron}</td>
                      <td>{formatDay(m.slaughterDate)}</td>
                      <td className="num">{formatKg(m.kg)}</td>
                      <td>{producerOf.get(m.dtId)}</td>
                      <td className={`num ${days >= 5 ? "num-negative" : ""}`}>{days}</td>
                      <td>
                        <select value={m.camaraId} disabled={busy} aria-label={`Cámara de tropa ${m.tropa} garrón ${m.garron}`}
                          onChange={(e) => void run(() => moveMedias([m.id], e.target.value), `Tropa ${m.tropa} garrón ${m.garron} pasó a ${camaraName.get(e.target.value)}.`)}>
                          {activeCamaras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ---------------- Trazabilidad ---------------- */

export function FrigoTraza({ data }: { data: FrigoData }) {
  const [query, setQuery] = useState("");
  const [labelsTropa, setLabelsTropa] = useState<number | null>(null);
  const dtById = useMemo(() => new Map(data.dts.map((d) => [d.id, d])), [data.dts]);
  const salidaById = useMemo(() => new Map(data.salidas.map((s) => [s.id, s])), [data.salidas]);
  const camaraName = useMemo(() => new Map(data.camaras.map((c) => [c.id, c.name])), [data.camaras]);
  const results = searchMedias(data.medias, data.dts, query);
  const today = localDateIso();

  return (
    <>
      <section className="panel">
        <div className="panel-title"><h2>Trazabilidad</h2></div>
        <label className="field" style={{ maxWidth: 420 }}>
          Buscar por tropa (T101), garrón (G14), número de DT o productor
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="T101" autoFocus />
        </label>
        {query.trim() && results.length === 0 && <p className="muted">No encontré nada con “{query}”.</p>}
        {results.length > 0 && (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="data-table">
              <thead><tr><th>Tropa</th><th>Garrón</th><th>Faena</th><th className="num">Kilos</th><th>DT · productor</th><th>Dónde está</th><th></th></tr></thead>
              <tbody>
                {results.slice(0, 500).map((m) => {
                  const dt = dtById.get(m.dtId);
                  const salida = m.salidaId ? salidaById.get(m.salidaId) : undefined;
                  return (
                    <tr key={m.id}>
                      <td>{m.tropa}</td>
                      <td>{m.garron}</td>
                      <td>{formatDay(m.slaughterDate)}</td>
                      <td className="num">{formatKg(m.kg)}</td>
                      <td>
                        {dt?.dtNumber}
                        <span className="muted" style={{ display: "block", fontSize: 12 }}>{dt?.producer}{dt?.renspa ? ` · RENSPA ${dt.renspa}` : ""}</span>
                      </td>
                      <td>
                        {salida ? (
                          <>
                            Salió el {formatDay(salida.salidaDate)} a {salida.kind === "cliente" ? salida.customerName : salida.destBranchName}
                            <span className="muted" style={{ display: "block", fontSize: 12 }}>Remito {remitoNumber(salida.number)} · estaba en {camaraName.get(m.camaraId)}</span>
                          </>
                        ) : (
                          <>En {camaraName.get(m.camaraId)} <span className="muted">· {daysBetween(m.slaughterDate, today)} días</span></>
                        )}
                      </td>
                      <td><button className="link-button" onClick={() => setLabelsTropa(m.tropa)}>Etiquetas</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {labelsTropa != null && (
        <FrigoLabels
          title={`Etiquetas · tropa ${labelsTropa}`}
          medias={data.medias.filter((m) => m.tropa === labelsTropa).sort(byOldest)}
          data={data}
          onClose={() => setLabelsTropa(null)}
        />
      )}
    </>
  );
}

/* ---------------- Etiquetas ---------------- */

// Code 39 (lo leen todas las pistolas, sin configurar nada): 9 elementos por
// carácter, barra/espacio alternados, n = angosto y w = ancho.
const CODE39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw",
  "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn", "*": "nwnnwnwnn"
};

function Barcode({ code }: { code: string }) {
  const rects: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of `*${code}*`) {
    const pattern = CODE39[ch];
    for (let i = 0; i < pattern.length; i++) {
      const w = pattern[i] === "w" ? 3 : 1;
      if (i % 2 === 0) rects.push({ x, w });
      x += w;
    }
    x += 1; // espacio entre caracteres
  }
  return (
    <svg viewBox={`0 0 ${x} 40`} preserveAspectRatio="none" style={{ width: "100%", height: 42, display: "block" }} aria-hidden="true">
      {rects.map((r, i) => <rect key={i} x={r.x} y={0} width={r.w} height={40} fill="#000" />)}
    </svg>
  );
}

export function FrigoLabels({ title, medias, data, onClose }: { title: string; medias: FrigoMedia[]; data: FrigoData; onClose: () => void }) {
  const [printing, setPrinting] = useState(false);
  const dtById = new Map(data.dts.map((d) => [d.id, d]));
  const camaraName = new Map(data.camaras.map((c) => [c.id, c.name]));

  useEffect(() => {
    if (!printing) return;
    window.print();
    setPrinting(false);
  }, [printing]);

  return (
    <section className={`panel ${printing ? "print-area" : ""}`} style={{ marginTop: 18 }}>
      <div className="panel-title no-print" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>{title} · {medias.length} medias · {formatKg(sumKg(medias))} kg</h2>
        <span style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setPrinting(true)}>Imprimir etiquetas</button>
          <button className="secondary" onClick={onClose}>Cerrar</button>
        </span>
      </div>
      <div className="frigo-labels">
        {medias.map((m) => {
          const dt = dtById.get(m.dtId);
          const code = labelCode(m);
          return (
            <div key={m.id} className="frigo-label">
              <div className="frigo-label-head"><span>Faena {formatDay(m.slaughterDate)}</span><span>{dt?.category}</span></div>
              <div className="frigo-label-big">
                <div><small>Tropa</small><b>{m.tropa}</b></div>
                <div><small>Garrón</small><b>{m.garron}</b></div>
              </div>
              <div className="frigo-label-kg">{formatKg(m.kg)} kg</div>
              <div className="frigo-label-meta">
                {sideLabel(m.side)} · animal {m.animal}<br />
                {dt?.dtNumber} · {dt?.producer}<br />
                {m.salidaId ? "Con salida" : camaraName.get(m.camaraId)}
              </div>
              <Barcode code={code} />
              <div className="frigo-label-code">{code}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
