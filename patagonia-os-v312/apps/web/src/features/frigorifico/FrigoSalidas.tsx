import { useEffect, useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { useActiveBranch } from "../branches/BranchProvider";
import { listProductsForBranch } from "../inventory/inventory-service";
import { formatMoney, localDateIso } from "../shifts/format";
import { errorText, type FrigoData } from "./FrigoShared";
import { byOldest, findByCode, formatDay, formatKg, inStock, remitoNumber, sumKg, type FrigoSalida, type SalidaKind } from "./frigo-logic";
import { createSalida, listActiveCustomers, voidSalida } from "./frigo-service";

// Salidas con tropa, garrón y kilo de cada media: venta a un cliente (va a su
// cuenta corriente en Clientes) o envío a una carnicería propia (ciclo 2:
// suma los kilos al stock de un producto de esa sucursal).

export function FrigoSalidas({ data, onChanged }: { data: FrigoData; onChanged: () => Promise<void> }) {
  const { branchId, branches } = useActiveBranch();
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [kind, setKind] = useState<SalidaKind>("cliente");
  const [customerId, setCustomerId] = useState("");
  const [price, setPrice] = useState("");
  const [destBranchId, setDestBranchId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [date, setDate] = useState(localDateIso());
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [camaraFilter, setCamaraFilter] = useState("");
  const [tropaFilter, setTropaFilter] = useState("");
  const [scan, setScan] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);

  useEffect(() => {
    listActiveCustomers().then(setCustomers).catch((err) => setMessage(errorText(err, "No se pudieron cargar los clientes.")));
  }, []);

  useEffect(() => {
    setProducts([]);
    setProductId("");
    if (!destBranchId) return;
    listProductsForBranch(destBranchId)
      .then((list) => setProducts(list.filter((p) => p.unit === "kg")))
      .catch((err) => setMessage(errorText(err, "No se pudieron cargar los productos.")));
  }, [destBranchId]);

  const camaraName = useMemo(() => new Map(data.camaras.map((c) => [c.id, c.name])), [data.camaras]);
  const stock = inStock(data.medias).sort(byOldest);
  const tropas = [...new Set(stock.map((m) => m.tropa))].sort((a, b) => a - b);
  const visible = stock.filter((m) => (!camaraFilter || m.camaraId === camaraFilter) && (!tropaFilter || String(m.tropa) === tropaFilter));
  const chosen = data.medias.filter((m) => selected.includes(m.id)).sort(byOldest);
  const totalKg = sumKg(chosen);
  const priceN = parseAmount(price);
  const total = kind === "cliente" && priceN > 0 ? Math.round(chosen.reduce((t, m) => t + Math.round(m.kg * priceN * 100) / 100, 0)) : 0;
  const viewing = viewId ? data.salidas.find((s) => s.id === viewId) ?? null : null;

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function addScanned() {
    const found = findByCode(data.medias, scan, selected);
    if (found) {
      setSelected((prev) => [...prev, found.id]);
      setMessage(`Agregada: tropa ${found.tropa}, garrón ${found.garron}, ${formatKg(found.kg)} kg.`);
    } else {
      setMessage(scan.trim() ? `No hay en cámara una media con “${scan.trim()}” sin elegir.` : "");
    }
    setScan("");
  }

  async function confirm() {
    if (!branchId) return setMessage("Elegí una sucursal.");
    if (chosen.length === 0) return setMessage("Elegí al menos una media.");
    if (kind === "cliente" && !customerId) return setMessage("Elegí el cliente.");
    if (kind === "cliente" && !(priceN > 0)) return setMessage("Poné el precio por kilo.");
    if (kind === "sucursal" && (!destBranchId || !productId)) return setMessage("Elegí la carnicería y el producto donde entran los kilos.");
    setBusy(true);
    setMessage("");
    try {
      const result = await createSalida({
        branchId, date, kind,
        customerId: kind === "cliente" ? customerId : null,
        destBranchId: kind === "sucursal" ? destBranchId : null,
        productId: kind === "sucursal" ? productId : null,
        pricePerKg: kind === "cliente" ? priceN : null,
        mediaIds: chosen.map((m) => m.id),
        notes
      });
      await onChanged();
      setSelected([]);
      setNotes("");
      setViewId(result.id);
      setMessage(`Remito ${remitoNumber(result.number)} hecho: ${result.medias} medias, ${formatKg(Number(result.total_kg))} kg${kind === "cliente" ? `, ${formatMoney(Number(result.total))} a la cuenta corriente` : ""}.`);
    } catch (err) {
      setMessage(errorText(err, "No se pudo hacer el remito."));
    } finally {
      setBusy(false);
    }
  }

  const otherBranches = branches.filter((b) => b.id !== branchId);
  const destBranches = otherBranches.length ? otherBranches : branches;

  return (
    <>
      {message && <div className="message no-print">{message}</div>}
      {viewing && <Remito salida={viewing} data={data} onClose={() => setViewId(null)} onChanged={onChanged} />}

      <div className="no-print" style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", alignItems: "start", marginTop: viewing ? 18 : 0 }}>
        <section className="panel" style={{ minWidth: 0 }}>
          <div className="panel-title"><h2>1. Elegí las medias</h2></div>
          <div className="cash-banner-form" style={{ flexWrap: "wrap", alignItems: "end" }}>
            <label className="field" style={{ width: 220 }}>
              Escanear etiqueta o garrón
              <input
                value={scan}
                inputMode="numeric"
                placeholder="Código o garrón + Enter"
                onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addScanned();
                  }
                }}
              />
            </label>
            <label className="field" style={{ width: 160 }}>
              Cámara
              <select value={camaraFilter} onChange={(e) => setCamaraFilter(e.target.value)}>
                <option value="">Todas</option>
                {data.camaras.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="field" style={{ width: 120 }}>
              Tropa
              <select value={tropaFilter} onChange={(e) => setTropaFilter(e.target.value)}>
                <option value="">Todas</option>
                {tropas.map((t) => <option key={t} value={String(t)}>{t}</option>)}
              </select>
            </label>
            {visible.length > 0 && (
              <button type="button" className="secondary" onClick={() => setSelected((prev) => [...new Set([...prev, ...visible.map((m) => m.id)])])}>
                Elegir las {visible.length}
              </button>
            )}
          </div>
          <div style={{ overflowX: "auto", marginTop: 12, maxHeight: 460, overflowY: "auto" }}>
            <table className="data-table">
              <thead><tr><th></th><th>Tropa</th><th>Garrón</th><th>Faena</th><th className="num">Kilos</th><th>Cámara</th></tr></thead>
              <tbody>
                {visible.length === 0 && <tr><td colSpan={6} className="muted">No hay medias en cámara con ese filtro.</td></tr>}
                {visible.map((m) => (
                  <tr key={m.id} onClick={() => toggle(m.id)} style={{ cursor: "pointer", background: selected.includes(m.id) ? "#fff1f1" : undefined }}>
                    <td><input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)} onClick={(e) => e.stopPropagation()} aria-label={`Elegir tropa ${m.tropa} garrón ${m.garron}`} /></td>
                    <td>{m.tropa}</td>
                    <td>{m.garron}</td>
                    <td>{formatDay(m.slaughterDate)}</td>
                    <td className="num">{formatKg(m.kg)}</td>
                    <td>{camaraName.get(m.camaraId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel" style={{ minWidth: 0 }}>
          <div className="panel-title"><h2>2. A quién va</h2></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button type="button" className={kind === "cliente" ? "" : "secondary"} onClick={() => setKind("cliente")}>Venta a cliente</button>
            <button type="button" className={kind === "sucursal" ? "" : "secondary"} onClick={() => setKind("sucursal")}>Carnicería propia (ciclo 2)</button>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            {kind === "cliente" ? (
              <>
                <label className="field">
                  Cliente (cuenta corriente)
                  <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                    <option value="">Elegí…</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="field">Precio por kilo<input type="text" inputMode="decimal" value={price} placeholder="6.500" onChange={(e) => setPrice(e.target.value)} /></label>
                {customers.length === 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>No hay clientes: dalos de alta en Clientes.</p>}
              </>
            ) : (
              <>
                <label className="field">
                  Carnicería (sucursal)
                  <select value={destBranchId} onChange={(e) => setDestBranchId(e.target.value)}>
                    <option value="">Elegí…</option>
                    {destBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
                <label className="field">
                  Producto donde entran los kilos
                  <select value={productId} onChange={(e) => setProductId(e.target.value)} disabled={!destBranchId}>
                    <option value="">Elegí…</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>Los kilos se suman al stock de ese producto en la carnicería. Ejemplo: “Media res”.</p>
              </>
            )}
            <label className="field">Fecha<input type="date" value={date} onChange={(e) => setDate(e.target.value || localDateIso())} /></label>
            <label className="field">Notas<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Chofer, patente, etc." /></label>
          </div>
          <div style={{ display: "grid", gap: 4, margin: "14px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Medias</span><strong>{chosen.length}</strong></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Kilos</span><strong>{formatKg(totalKg)}</strong></div>
            {kind === "cliente" && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20 }}><span>Total</span><strong>{formatMoney(total)}</strong></div>}
          </div>
          {chosen.length > 0 && (
            <p className="muted" style={{ fontSize: 13 }}>{chosen.map((m) => `T${m.tropa} G${m.garron}`).join(" · ")}</p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => void confirm()} disabled={busy || chosen.length === 0}>{busy ? "Guardando…" : "Hacer remito"}</button>
            {chosen.length > 0 && <button className="secondary" onClick={() => setSelected([])} disabled={busy}>Vaciar</button>}
          </div>
        </section>
      </div>

      <section className="panel no-print" style={{ marginTop: 18 }}>
        <div className="panel-title"><h2>Remitos</h2></div>
        {data.salidas.length === 0 ? (
          <p className="muted">Todavía no hay salidas.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead><tr><th>Remito</th><th>Fecha</th><th>Destino</th><th>Tipo</th><th className="num">Kilos</th><th className="num">Total</th><th></th></tr></thead>
              <tbody>
                {[...data.salidas].reverse().map((s) => (
                  <tr key={s.id} style={{ opacity: s.voidedAt ? 0.55 : 1 }}>
                    <td>{remitoNumber(s.number)}</td>
                    <td>{formatDay(s.salidaDate)}</td>
                    <td>{destName(s)}</td>
                    <td>{s.voidedAt ? "Anulado" : s.kind === "cliente" ? "Venta" : "Carnicería propia"}</td>
                    <td className="num">{formatKg(s.totalKg)}</td>
                    <td className="num">{s.kind === "cliente" ? formatMoney(s.total) : "—"}</td>
                    <td><button className="link-button" onClick={() => setViewId(s.id)}>Ver</button></td>
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

function destName(s: FrigoSalida): string {
  return (s.kind === "cliente" ? s.customerName : s.destBranchName) ?? "—";
}

function Remito({ salida, data, onClose, onChanged }: { salida: FrigoSalida; data: FrigoData; onClose: () => void; onChanged: () => Promise<void> }) {
  const [printing, setPrinting] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const dtById = new Map(data.dts.map((d) => [d.id, d]));
  const items = data.medias.filter((m) => m.salidaId === salida.id).sort(byOldest);

  useEffect(() => {
    if (!printing) return;
    window.print();
    setPrinting(false);
  }, [printing]);

  async function doVoid() {
    if (!reason.trim()) return setMessage("Poné por qué se anula.");
    setBusy(true);
    try {
      await voidSalida(salida.id, reason);
      await onChanged();
      setVoiding(false);
      setMessage("Remito anulado: las medias volvieron a su cámara.");
    } catch (err) {
      setMessage(errorText(err, "No se pudo anular."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`panel ${printing ? "print-area" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderBottom: "2px solid #18202b", paddingBottom: 8, marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Remito {remitoNumber(salida.number)}</h2>
          <span className="muted">{formatDay(salida.salidaDate)} · {salida.kind === "cliente" ? "Venta" : "Envío a carnicería propia"}{salida.voidedAt ? " · ANULADO" : ""}</span>
        </div>
        <div style={{ textAlign: "right" }}>
          <strong style={{ fontSize: 18 }}>{destName(salida)}</strong>
          {salida.kind === "sucursal" && salida.productName && <span className="muted" style={{ display: "block" }}>Entra como {salida.productName}</span>}
        </div>
      </div>
      {salida.voidedAt ? (
        <p className="muted">Anulado{salida.voidedReason ? `: ${salida.voidedReason}` : ""}. Las medias volvieron a su cámara.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead><tr><th>Tropa</th><th>Garrón</th><th>Faena</th><th>DT</th><th className="num">Kilos</th>{salida.kind === "cliente" && <th className="num">Importe</th>}</tr></thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td>{m.tropa}</td>
                  <td>{m.garron}</td>
                  <td>{formatDay(m.slaughterDate)}</td>
                  <td>{dtById.get(m.dtId)?.dtNumber}</td>
                  <td className="num">{formatKg(m.kg)}</td>
                  {salida.kind === "cliente" && <td className="num">{formatMoney(m.kg * (salida.pricePerKg ?? 0))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
        <span>{items.length || ""}{items.length ? " medias · " : ""}{formatKg(salida.totalKg)} kg{salida.kind === "cliente" && salida.pricePerKg ? ` · ${formatMoney(salida.pricePerKg)}/kg` : ""}</span>
        {salida.kind === "cliente" && <strong style={{ fontSize: 20 }}>{formatMoney(salida.total)}</strong>}
      </div>
      {salida.notes && <p className="muted" style={{ marginBottom: 0 }}>{salida.notes}</p>}
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {!salida.voidedAt && <button onClick={() => setPrinting(true)}>Imprimir remito</button>}
        {!salida.voidedAt && !voiding && <button className="secondary" onClick={() => setVoiding(true)}>Anular</button>}
        <button className="secondary" onClick={onClose}>Cerrar</button>
      </div>
      {voiding && (
        <div className="cash-banner-form no-print" style={{ flexWrap: "wrap", alignItems: "end", marginTop: 10 }}>
          <label className="field" style={{ width: 280 }}>Por qué se anula<input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
          <button className="danger" onClick={() => void doVoid()} disabled={busy}>Anular remito</button>
          <button className="secondary" onClick={() => setVoiding(false)} disabled={busy}>No</button>
        </div>
      )}
      {message && <div className="message no-print" style={{ marginTop: 10 }}>{message}</div>}
    </section>
  );
}
