import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatMoney } from "./format";
import { getPeriodResult } from "../sale/pos-shift-service";
import { WASTE_REASON_LABELS, carcassLosses, computePeriodResult, type PeriodResultData } from "./period-result";

const kgText = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} kg`;
const qtyText = (unit: string | null, n: number) => (unit === "kg" ? kgText(n) : `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} u.`);
const pctText = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;
const dateText = (iso: string) => (iso.length >= 10 ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : iso);

function Row({ label, amount, sign, strong, note, children }: {
  label: string;
  amount: number;
  sign?: "−" | "=";
  strong?: boolean;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <tr>
      <td style={{ paddingLeft: sign === "−" ? 22 : undefined }}>
        {strong ? <strong>{sign ? `${sign} ` : ""}{label}</strong> : <>{sign ? `${sign} ` : ""}{label}</>}
        {note && <div className="muted" style={{ fontSize: 12 }}>{note}</div>}
        {children}
      </td>
      <td className="num">{strong ? <strong>{formatMoney(amount)}</strong> : formatMoney(amount)}</td>
    </tr>
  );
}

/**
 * Reportes, todos los planes, solo dueño/admin (2026-10-22; migración 146): "Resultado del período"
 * (ventas − costo − faltantes − gastos − sueldos) y "Merma" (conteos de stock y
 * desposte). Se pide cada vez que cambia la búsqueda (runId).
 */
export function ReportsResult({ branchId, from, to, runId }: { branchId: string | null; from: string; to: string; runId: number }) {
  const [data, setData] = useState<PeriodResultData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExpenses, setShowExpenses] = useState(false);

  useEffect(() => {
    if (!branchId || runId === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPeriodResult(branchId, from, to)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "No se pudo calcular el resultado.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Solo al apretar Buscar/Hoy/Semana/Mes (runId), no al tocar las fechas.
  }, [runId, branchId]);

  const result = useMemo(() => (data ? computePeriodResult(data) : null), [data]);
  const carcass = useMemo(() => (data ? carcassLosses(data.carcass) : null), [data]);
  const lostProducts = data ? data.stockAdjustments.filter((a) => a.lostValue > 0 || a.lostQty > 0) : [];
  const foundProducts = data ? data.stockAdjustments.filter((a) => a.foundQty > 0) : [];

  return (
    <>
      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Resultado del período</h2>
          <span className="muted" style={{ fontSize: 12 }}>Cuánto quedó: lo vendido menos lo que costó y lo que se gastó</span>
        </div>
        {loading ? (
          <p className="muted">Cargando…</p>
        ) : error ? (
          <p style={{ color: "#8b1e1e" }}>{error}</p>
        ) : !result ? null : result.sales === 0 && result.expenses === 0 && result.salaries === 0 ? (
          <p className="muted">No hay ventas ni gastos en ese rango.</p>
        ) : (
          <>
            <div className="kpi-grid" style={{ marginBottom: 14 }}>
              <div className="kpi-card">
                <span>Resultado</span>
                <strong style={{ color: result.result < 0 ? "#8b1e1e" : "#176329" }}>{formatMoney(result.result)}</strong>
                {result.resultPct !== null && <small>{pctText(result.resultPct)} de lo vendido</small>}
              </div>
              <div className="kpi-card">
                <span>Ganancia bruta</span>
                <strong>{formatMoney(result.grossProfit)}</strong>
                {result.grossPct !== null && <small>{pctText(result.grossPct)} de lo vendido, antes de gastos</small>}
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <tbody>
                  <Row
                    label="Ventas"
                    amount={result.sales}
                    strong
                    note={[
                      `Mostrador ${formatMoney(result.salesMostrador)}`,
                      result.salesAccount > 0 ? `a cuenta ${formatMoney(result.salesAccount)}` : null,
                      result.salesTurnos > 0 ? `Turnos ${formatMoney(result.salesTurnos)}` : null
                    ].filter(Boolean).join(" · ")}
                  />
                  <Row
                    label="Costo de lo vendido"
                    amount={result.cost}
                    sign="−"
                    note={result.estimatedCost > 0 ? `${formatMoney(result.estimatedCost)} estimado (ver abajo)` : "lo que costó la mercadería que se vendió"}
                  />
                  <Row label="Ganancia bruta" amount={result.grossProfit} sign="=" strong />
                  <Row label="Faltantes de stock" amount={result.stockLoss} sign="−" note="mercadería que faltó al contar, a costo (ver Merma)" />
                  {result.wasteLoss > 0 && (
                    <Row label="Decomisos" amount={result.wasteLoss} sign="−" note="lo que se tiró por vencido, en mal estado o roto, a costo (ver Merma)" />
                  )}
                  <Row label="Gastos" amount={result.expenses} sign="−" note={result.expenseLines.length === 0 ? "no se cargaron gastos en Tesorería" : undefined}>
                    {result.expenseLines.length > 0 && (
                      <button className="secondary" style={{ marginTop: 4, padding: "2px 8px", fontSize: 12 }} onClick={() => setShowExpenses(!showExpenses)}>
                        {showExpenses ? "Ocultar detalle" : "Ver detalle"}
                      </button>
                    )}
                  </Row>
                  {showExpenses &&
                    result.expenseLines.map((e) => (
                      <tr key={e.category} style={{ background: "#fafafa" }}>
                        <td style={{ paddingLeft: 44 }} className="muted">{e.label}</td>
                        <td className="num muted">{formatMoney(e.amount)}</td>
                      </tr>
                    ))}
                  <Row
                    label="Sueldos y vales"
                    amount={result.salaries}
                    sign="−"
                    note={result.salaryLines.length > 0 ? result.salaryLines.map((e) => `${e.label} ${formatMoney(e.amount)}`).join(" · ") : "no hubo pagos de sueldos ni vales"}
                  />
                  <tr>
                    <td><strong>= Resultado</strong></td>
                    <td className={`num ${result.result < 0 ? "num-negative" : "num-positive"}`}><strong>{formatMoney(result.result)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
            {result.estimatedCost > 0 && result.costRatio !== null && (
              <p style={{ fontSize: 12, margin: "8px 0 0", color: "#8a4b00" }}>
                {formatMoney(result.estimatedSales)} de lo vendido no tiene costo conocido (productos sin costo cargado, tickets de total de la balanza, "Vender algo sin código"
                {result.salesTurnos > 0 ? ", Turnos" : ""} o ventas a cuenta sin artículos). Para eso se usó el mismo costo que el resto: {pctText(result.costRatio * 100)} de lo vendido.
                Cuanto más costos cargues en Stock, más exacto sale.
              </p>
            )}
            {result.costRatio === null && result.sales > 0 && (
              <p style={{ fontSize: 12, margin: "8px 0 0", color: "#8a4b00" }}>
                Ningún producto vendido tiene costo cargado: el costo de lo vendido sale en cero. Cargá los costos en Stock.
              </p>
            )}
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
              Gastos y sueldos son lo que salió de Tesorería en el período. No se restan los pagos a proveedores (esa mercadería ya está en el costo de lo vendido),
              los pagos de deudas, las transferencias entre cuentas ni lo que se guardó en la caja fuerte. Los costos fijos de Rentabilidad tampoco se suman acá:
              si pagás el alquiler o la luz, cargalos como gasto en Tesorería.
              {result.stockFound > 0 && ` Los sobrantes de los conteos (${formatMoney(result.stockFound)}) no se suman: suelen ser correcciones de carga.`}
            </p>
          </>
        )}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Merma</h2>
          <span className="muted" style={{ fontSize: 12 }}>Mercadería que se pierde: al contar el stock, lo que se tira y al despostar</span>
        </div>
        {loading ? (
          <p className="muted">Cargando…</p>
        ) : error || !data ? null : (
          <>
            <h3 style={{ fontSize: 15, margin: "0 0 6px" }}>Faltantes al contar el stock</h3>
            {lostProducts.length === 0 ? (
              <p className="muted">
                No faltó mercadería en los conteos de este período. Cuando contás un producto en Stock → "Ajustar stock" y hay menos de lo que dice el sistema, aparece acá.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th className="num">Faltó</th>
                      <th className="num">A costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lostProducts.map((a) => (
                      <tr key={a.productId}>
                        <td>
                          {a.productCode ? `${a.productCode} · ` : ""}{a.productName}
                          {a.reasons.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{a.reasons.join(" · ")}</div>}
                        </td>
                        <td className="num">{qtyText(a.unit, a.lostQty)}</td>
                        <td className="num">{a.lostValue > 0 ? formatMoney(a.lostValue) : "sin costo"}</td>
                      </tr>
                    ))}
                    <tr>
                      <td><strong>Total</strong></td>
                      <td />
                      <td className="num"><strong>{formatMoney(lostProducts.reduce((sum, a) => sum + a.lostValue, 0))}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {foundProducts.length > 0 && (
              <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
                Sobró al contar: {foundProducts.slice(0, 6).map((a) => `${a.productName} ${qtyText(a.unit, a.foundQty)}`).join(" · ")}
                {foundProducts.length > 6 ? ` y ${foundProducts.length - 6} más` : ""}.
              </p>
            )}

            <h3 style={{ fontSize: 15, margin: "18px 0 6px" }}>Decomisos</h3>
            {data.wastes.length === 0 ? (
              <p className="muted">No se tiró mercadería en este período. Cuando algo se tira (vencido, en mal estado o roto), se carga en Mostrador con el botón "Decomiso" y aparece acá.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th>Motivo</th>
                      <th className="num">Se tiró</th>
                      <th className="num">A costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.wastes.map((w) => (
                      <tr key={`${w.productId}-${w.reason}`}>
                        <td>{w.productCode ? `${w.productCode} · ` : ""}{w.productName}</td>
                        <td>
                          {WASTE_REASON_LABELS[w.reason] ?? w.reason}
                          {w.count > 1 && <span className="muted" style={{ fontSize: 12 }}> · {w.count} veces</span>}
                        </td>
                        <td className="num">{qtyText(w.unit, w.quantity)}</td>
                        <td className="num">{w.value > 0 ? formatMoney(w.value) : "sin costo"}</td>
                      </tr>
                    ))}
                    <tr>
                      <td><strong>Total</strong></td>
                      <td />
                      <td />
                      <td className="num"><strong>{formatMoney(data.wastes.reduce((sum, w) => sum + w.value, 0))}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            <h3 style={{ fontSize: 15, margin: "18px 0 6px" }}>Desposte</h3>
            {!carcass || carcass.batches.length === 0 ? (
              <p className="muted">No se cargaron reses en Despiece en este período.</p>
            ) : (
              <>
                {carcass.lossPct !== null && (
                  <div className="kpi-grid" style={{ marginBottom: 12 }}>
                    <div className="kpi-card">
                      <span>Merma del desposte</span>
                      <strong>{pctText(carcass.lossPct)}</strong>
                      <small>{kgText(carcass.lossKg)} de {kgText(carcass.totalWeight)} · {formatMoney(carcass.lossValue)}</small>
                    </div>
                  </div>
                )}
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Qué se desposteó</th>
                        <th className="num">Comprado</th>
                        <th className="num">Cortes</th>
                        <th className="num">Merma</th>
                      </tr>
                    </thead>
                    <tbody>
                      {carcass.batches.map((b) => (
                        <tr key={b.id}>
                          <td>{dateText(b.date)}</td>
                          <td>
                            {b.animalType}
                            {b.supplier && <div className="muted" style={{ fontSize: 12 }}>{b.supplier}</div>}
                          </td>
                          <td className="num">{kgText(b.totalWeight)}</td>
                          <td className="num">{b.noCuts ? "—" : kgText(b.cutsWeight)}</td>
                          <td className="num">
                            {b.noCuts ? (
                              <span className="muted">sin cortes cargados</span>
                            ) : (
                              <>
                                {kgText(b.lossKg)} · {pctText(b.lossPct ?? 0)}
                                <div className="muted" style={{ fontSize: 12 }}>{formatMoney(b.lossValue)}</div>
                                {b.suspicious && <div style={{ fontSize: 12, color: "#8a4b00" }}>muy alta: ¿faltan cargar cortes?</div>}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
                  Merma = kilos comprados − kilos de cortes cargados en Despiece (hueso, grasa, oreo). No se resta otra vez en el resultado: ya está dentro del costo de los cortes.
                  Las reses sin cortes o con merma muy alta no entran en el total.
                </p>
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
