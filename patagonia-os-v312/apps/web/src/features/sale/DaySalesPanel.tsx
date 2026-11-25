import { Fragment, useCallback, useEffect, useState } from "react";
import { formatQuantity } from "../../lib/quantity-format";
import { formatMoney, localDateIso } from "../shifts/format";
import { listPosSalesOfDay, type DaySale } from "./pos-shift-service";
import { UNIT_LABELS } from "./sale-model";

/**
 * Mostrador → "Ventas del día" (pedido de una clienta, 25/11/2026): cada venta del día, de todos los turnos (también
 * el de la cajera anterior si se cerró la caja para cambiar de cajero), con hora, quién atendía, cómo pagó y, tocando
 * la fila, qué productos llevó. Solo lectura: anular sigue en "Ver ventas (anular)" del turno abierto.
 */
export function DaySalesPanel({ branchId, refreshKey }: { branchId: string; refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => localDateIso());
  const [sales, setSales] = useState<DaySale[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSales(await listPosSalesOfDay(branchId, date));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar las ventas.");
    } finally {
      setLoading(false);
    }
  }, [branchId, date]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload, refreshKey]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const active = sales.filter((s) => !s.voidedAt);
  const total = Math.round(active.reduce((sum, s) => sum + s.total, 0) * 100) / 100;
  const allOpen = sales.length > 0 && sales.every((s) => expanded.has(s.id));

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Ventas del día</h2>
        <button className="secondary" onClick={() => setOpen((v) => !v)}>{open ? "Ocultar" : "Ver cada venta"}</button>
      </div>
      {!open ? (
        <p className="muted" style={{ margin: 0 }}>Cada venta del día con la hora, quién atendía, cómo pagó y qué productos llevó.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginBottom: 12 }}>
            <label className="field" style={{ margin: 0 }}>
              <span>Día</span>
              <input type="date" value={date} max={localDateIso()} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </label>
            <button className="secondary" disabled={loading} onClick={() => void reload()}>{loading ? "Cargando…" : "Actualizar"}</button>
            {sales.length > 0 && (
              <button className="secondary" onClick={() => setExpanded(allOpen ? new Set() : new Set(sales.map((s) => s.id)))}>
                {allOpen ? "Cerrar todas" : "Abrir todas"}
              </button>
            )}
            {sales.length > 0 && (
              <span style={{ marginLeft: "auto" }}>
                {active.length} venta{active.length === 1 ? "" : "s"} · <strong>{formatMoney(total)}</strong>
              </span>
            )}
          </div>

          {error ? (
            <p className="message warning">{error}</p>
          ) : loading && sales.length === 0 ? (
            <p className="muted">Cargando…</p>
          ) : sales.length === 0 ? (
            <p className="muted">No hay ventas de Mostrador ese día.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Atendía</th>
                    <th>Pago</th>
                    <th className="num">Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((s) => {
                    const isOpen = expanded.has(s.id);
                    return (
                      <Fragment key={s.id}>
                        <tr
                          style={{ cursor: "pointer", ...(s.voidedAt ? { opacity: 0.55 } : {}) }}
                          onClick={() => toggle(s.id)}
                        >
                          <td>{new Date(s.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</td>
                          <td>{s.cashierName ?? <span className="muted">-</span>}</td>
                          <td>{s.payments.map((p) => p.accountName).join(" + ") || "-"}</td>
                          <td className="num" style={s.voidedAt ? { textDecoration: "line-through" } : undefined}>{formatMoney(s.total)}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {s.voidedAt && <span className="num-negative" style={{ marginRight: 8 }}>Anulada</span>}
                            <span className="muted">{isOpen ? "▴" : `${s.items.length} producto${s.items.length === 1 ? "" : "s"} ▾`}</span>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={5} style={{ background: "#f8f9fb" }}>
                              <table style={{ width: "100%", fontSize: 14 }}>
                                <tbody>
                                  {s.items.map((item, idx) => (
                                    <tr key={idx}>
                                      <td>{item.productName}</td>
                                      <td className="num">{formatQuantity(item.quantity, item.unit, UNIT_LABELS[item.unit])} x {formatMoney(item.unitPrice)}</td>
                                      <td className="num">
                                        {item.discountAmount > 0 && <span className="muted">-{formatMoney(item.discountAmount)} </span>}
                                        <b>{formatMoney(item.lineTotal)}</b>
                                      </td>
                                    </tr>
                                  ))}
                                  {s.discountAmount > 0 && (
                                    <tr><td colSpan={2}>Descuento</td><td className="num">-{formatMoney(s.discountAmount)}</td></tr>
                                  )}
                                  {s.surchargeAmount > 0 && (
                                    <tr><td colSpan={2}>Recargo</td><td className="num">+{formatMoney(s.surchargeAmount)}</td></tr>
                                  )}
                                  {s.payments.length > 1 && s.payments.map((p, idx) => (
                                    <tr key={`p${idx}`} className="muted"><td colSpan={2}>Pagó con {p.accountName}</td><td className="num">{formatMoney(p.amount)}</td></tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
