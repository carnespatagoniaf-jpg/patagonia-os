import { useEffect, useMemo, useState } from "react";
import { STOCK_COUNT_CATEGORIES } from "@patagonia/domain";
import { useProfitability } from "./useProfitability";
import { useShifts } from "../shifts/useShifts";
import { addDaysIso, endOfMonthIso, endOfWeekIso, formatMoney, startOfMonthIso, startOfWeekIso, todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { listTreasuryMovements } from "../shifts/treasury-service";
import { MOVEMENT_TYPE_LABELS } from "../shifts/Treasury";

interface CashSummary {
  totalIn: number;
  totalOut: number;
  ventas: number;
  compras: number;
  sueldos: number;
  gastos: number;
  otros: number;
  byType: { type: string; in: number; out: number }[];
}

const EMPTY_CASH_SUMMARY: CashSummary = {
  totalIn: 0,
  totalOut: 0,
  ventas: 0,
  compras: 0,
  sueldos: 0,
  gastos: 0,
  otros: 0,
  byType: []
};

const SUELDOS_TYPES = new Set(["sueldo", "vale_adelanto", "vale_mercaderia"]);
const GASTOS_TYPES = new Set(["gasto", "ajuste", "pago_acreedor"]);

const CATEGORY_LABELS: Record<string, string> = {
  achura: "Achura",
  cerdo: "Cerdo",
  pollo: "Pollo",
  vacuno: "Vacuno",
  embutidos: "Embutidos",
  preparados: "Preparados",
  proveeduria: "Proveeduría",
  varios: "Varios"
};

export function Profitability() {
  const {
    branchId,
    fixedCosts,
    loading,
    error,
    addFixedCost,
    editFixedCost,
    purchasedProducts,
    purchasedProductsLoading,
    loadPurchasedProducts,
    getPurchasesTotal,
    periods,
    closePeriod,
    stockCounts,
    loadStockCounts,
    addStockCount,
    removeStockCount,
    getStockNear
  } = useProfitability();
  const { loadRange } = useShifts();

  const [message, setMessage] = useState("");

  const [fcName, setFcName] = useState("");
  const [fcAmount, setFcAmount] = useState("");
  const [editingFcId, setEditingFcId] = useState<string | null>(null);

  const [periodStart, setPeriodStart] = useState(startOfWeekIso(todayIso()));
  const [periodEnd, setPeriodEnd] = useState(endOfWeekIso(todayIso()));
  const [stockStart, setStockStart] = useState("");
  const [stockEnd, setStockEnd] = useState("");
  const [stockStartDate, setStockStartDate] = useState<string | null>(null);
  const [stockEndDate, setStockEndDate] = useState<string | null>(null);
  const [salesTotal, setSalesTotal] = useState(0);
  const [purchasesTotal, setPurchasesTotal] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [cashSummary, setCashSummary] = useState<CashSummary>(EMPTY_CASH_SUMMARY);
  const [cashSummaryLoading, setCashSummaryLoading] = useState(false);

  const [countDate, setCountDate] = useState(todayIso());
  const [countValues, setCountValues] = useState<Record<string, string>>({});

  useEffect(() => {
    void loadPurchasedProducts(periodStart, periodEnd);
    void runPreview(periodStart, periodEnd);
    void runStockLookup(periodStart, periodEnd);
    void runCashSummary(periodStart, periodEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodStart, periodEnd, branchId]);

  useEffect(() => {
    void loadStockCounts(addDaysIso(todayIso(), -180), todayIso());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  async function runPreview(from: string, to: string) {
    if (!branchId) return;
    setPreviewLoading(true);
    try {
      const [rangeRows, purchases] = await Promise.all([loadRange(from, to), getPurchasesTotal(from, to)]);
      setSalesTotal(rangeRows.reduce((sum, row) => sum + row.sales.reduce((s, r) => s + r.amount, 0), 0));
      setPurchasesTotal(purchases);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function runStockLookup(from: string, to: string) {
    if (!branchId) return;
    const [start, end] = await Promise.all([getStockNear(from), getStockNear(to)]);
    setStockStart(start ? String(start.total) : "");
    setStockStartDate(start ? start.date : null);
    setStockEnd(end ? String(end.total) : "");
    setStockEndDate(end ? end.date : null);
  }

  async function runCashSummary(from: string, to: string) {
    setCashSummaryLoading(true);
    try {
      const movements = await listTreasuryMovements({ from, to, limit: 3000 });
      const byTypeMap = new Map<string, { in: number; out: number }>();
      let totalIn = 0;
      let totalOut = 0;
      let ventas = 0;
      let compras = 0;
      let sueldos = 0;
      let gastos = 0;
      let otros = 0;
      for (const m of movements) {
        // Transferencias entre cuentas propias no son plata real entrando/saliendo del negocio.
        if (m.movementType === "transferencia") continue;

        const entry = byTypeMap.get(m.movementType) ?? { in: 0, out: 0 };
        if (m.direction === "in") {
          entry.in += m.amount;
          totalIn += m.amount;
        } else {
          entry.out += m.amount;
          totalOut += m.amount;
        }
        byTypeMap.set(m.movementType, entry);

        if (m.movementType === "venta") ventas += m.amount;
        else if (m.movementType === "pago_proveedor") compras += m.amount;
        else if (SUELDOS_TYPES.has(m.movementType)) sueldos += m.amount;
        else if (GASTOS_TYPES.has(m.movementType) && m.direction === "out") gastos += m.amount;
        else otros += m.direction === "in" ? -m.amount : m.amount;
      }
      const byType = Array.from(byTypeMap.entries())
        .map(([type, sums]) => ({ type, ...sums }))
        .sort((a, b) => b.in + b.out - (a.in + a.out));
      setCashSummary({ totalIn, totalOut, ventas, compras, sueldos, gastos, otros, byType });
    } finally {
      setCashSummaryLoading(false);
    }
  }

  const fixedCostsMonthly = fixedCosts.reduce((sum, f) => sum + f.monthlyAmount, 0);
  const daysInPeriod = Math.round((new Date(`${periodEnd}T00:00:00`).getTime() - new Date(`${periodStart}T00:00:00`).getTime()) / 86400000) + 1;
  const fixedCostsPeriod = Math.round((fixedCostsMonthly / 30) * daysInPeriod);

  const stockStartValue = parseAmount(stockStart || "0") || 0;
  const stockEndValue = parseAmount(stockEnd || "0") || 0;
  const cogs = stockStartValue + purchasesTotal - stockEndValue;
  const grossProfit = salesTotal - cogs - fixedCostsPeriod;

  const stockCountsByDate = useMemo(() => {
    const dates = Array.from(new Set(stockCounts.map((c) => c.countDate))).sort((a, b) => b.localeCompare(a));
    return dates.map((date) => {
      const rows = stockCounts.filter((c) => c.countDate === date);
      const byCategory = STOCK_COUNT_CATEGORIES.map((cat) => ({ category: cat, value: rows.find((r) => r.category === cat)?.value ?? 0 }));
      const total = byCategory.reduce((sum, c) => sum + c.value, 0);
      return { date, byCategory, total, ids: rows.map((r) => r.id) };
    });
  }, [stockCounts]);

  async function handleSaveFixedCost() {
    try {
      if (!fcName.trim()) throw new Error("El nombre es obligatorio.");
      const amount = parseAmount(fcAmount);
      if (!Number.isFinite(amount) || amount < 0) throw new Error("El monto no puede ser negativo.");
      if (editingFcId) {
        await editFixedCost({ id: editingFcId, name: fcName.trim(), monthlyAmount: amount, active: true });
      } else {
        await addFixedCost({ name: fcName.trim(), monthlyAmount: amount });
      }
      setFcName("");
      setFcAmount("");
      setEditingFcId(null);
      setMessage("Costo fijo guardado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el costo fijo.");
    }
  }

  function handleEditFixedCost(id: string) {
    const fc = fixedCosts.find((f) => f.id === id);
    if (!fc) return;
    setEditingFcId(id);
    setFcName(fc.name);
    setFcAmount(String(fc.monthlyAmount));
  }

  async function handleDeactivateFixedCost(id: string) {
    const fc = fixedCosts.find((f) => f.id === id);
    if (!fc) return;
    try {
      await editFixedCost({ id, name: fc.name, monthlyAmount: fc.monthlyAmount, active: false });
      setMessage("Costo fijo desactivado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo desactivar.");
    }
  }

  async function handleSaveStockCount() {
    try {
      const entries = STOCK_COUNT_CATEGORIES.filter((cat) => (countValues[cat] ?? "").trim() !== "");
      if (entries.length === 0) throw new Error("Cargá al menos una categoría.");
      for (const category of entries) {
        const value = parseAmount(countValues[category]);
        if (!Number.isFinite(value) || value < 0) throw new Error(`Monto inválido en ${CATEGORY_LABELS[category]}.`);
        await addStockCount({ countDate, category, value });
      }
      setCountValues({});
      await loadStockCounts(addDaysIso(todayIso(), -180), todayIso());
      await runStockLookup(periodStart, periodEnd);
      setMessage("Conteo guardado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el conteo.");
    }
  }

  async function handleDeleteStockCountRow(ids: string[]) {
    try {
      for (const id of ids) await removeStockCount(id);
      await loadStockCounts(addDaysIso(todayIso(), -180), todayIso());
      await runStockLookup(periodStart, periodEnd);
      setMessage("Conteo eliminado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo eliminar.");
    }
  }

  async function handleClosePeriod() {
    try {
      const result = await closePeriod({ periodStart, periodEnd, stockStart: stockStartValue, stockEnd: stockEndValue });
      setMessage(`Período cerrado: ganancia ${formatMoney(result.grossProfit)}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cerrar el período.");
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">RENTABILIDAD</p>
          <h1>Rentabilidad</h1>
          <p className="muted">Ganancia por semana o mes: ventas menos costo de mercadería vendida y costos fijos.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <section className="panel">
        <div className="panel-title">
          <h2>Costos fijos</h2>
          <span>{loading ? "Cargando…" : `${formatMoney(fixedCostsMonthly)} / mes`}</span>
        </div>
        <p className="muted" style={{ marginBottom: 14 }}>Alquiler, sueldos, servicios, etc. Se cargan una vez por mes y se prorratean según el período elegido.</p>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
          <input placeholder="Nombre (ej. Alquiler)" value={fcName} onChange={(e) => setFcName(e.target.value)} />
          <input type="text" inputMode="decimal" placeholder="Monto mensual" value={fcAmount} onChange={(e) => setFcAmount(e.target.value)} />
          <button onClick={handleSaveFixedCost}>{editingFcId ? "Guardar cambio" : "Agregar costo fijo"}</button>
          {editingFcId && (
            <button className="secondary" onClick={() => { setEditingFcId(null); setFcName(""); setFcAmount(""); }}>Cancelar</button>
          )}
        </div>
        <table className="data-table">
          <thead>
            <tr><th>Nombre</th><th className="num">Monto mensual</th><th></th></tr>
          </thead>
          <tbody>
            {fixedCosts.map((fc) => (
              <tr key={fc.id}>
                <td>{fc.name}</td>
                <td className="num">{formatMoney(fc.monthlyAmount)}</td>
                <td>
                  <button className="secondary" onClick={() => handleEditFixedCost(fc.id)}>Editar</button>{" "}
                  <button className="danger" onClick={() => handleDeactivateFixedCost(fc.id)}>Quitar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {fixedCosts.length === 0 && <p className="muted">Todavía no cargaste costos fijos.</p>}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Conteo de stock</h2>
        </div>
        <p className="muted" style={{ marginBottom: 14 }}>
          Cargá acá el pesaje de mercadería fresca (los lunes) o el conteo completo del local (día 1 de cada mes). Queda guardado por fecha y categoría, y Rentabilidad lo usa solo para el stock inicial/final del período.
        </p>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
          <input type="date" value={countDate} onChange={(e) => setCountDate(e.target.value)} />
          <button className="secondary" onClick={() => setCountDate(startOfWeekIso(todayIso()))}>Lunes de esta semana</button>
          <button className="secondary" onClick={() => setCountDate(startOfMonthIso(todayIso()))}>Día 1 de este mes</button>
        </div>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
          {STOCK_COUNT_CATEGORIES.map((cat) => (
            <input
              key={cat}
              type="text"
              inputMode="decimal"
              placeholder={CATEGORY_LABELS[cat]}
              value={countValues[cat] ?? ""}
              onChange={(e) => setCountValues((current) => ({ ...current, [cat]: e.target.value }))}
              style={{ minWidth: 110 }}
            />
          ))}
          <button onClick={handleSaveStockCount}>Guardar conteo</button>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              {STOCK_COUNT_CATEGORIES.map((cat) => (
                <th key={cat} className="num">{CATEGORY_LABELS[cat]}</th>
              ))}
              <th className="num">Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {stockCountsByDate.map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                {row.byCategory.map((c) => (
                  <td key={c.category} className="num">{c.value ? formatMoney(c.value) : "-"}</td>
                ))}
                <td className="num">{formatMoney(row.total)}</td>
                <td><button className="danger" onClick={() => handleDeleteStockCountRow(row.ids)}>Quitar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {stockCountsByDate.length === 0 && <p className="muted">Todavía no cargaste ningún conteo.</p>}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Período</h2>
        </div>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 4 }}>
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          <button className="secondary" onClick={() => { setPeriodStart(startOfWeekIso(todayIso())); setPeriodEnd(endOfWeekIso(todayIso())); }}>Esta semana</button>
          <button className="secondary" onClick={() => { setPeriodStart(startOfWeekIso(addDaysIso(todayIso(), -7))); setPeriodEnd(endOfWeekIso(addDaysIso(todayIso(), -7))); }}>Semana pasada</button>
          <button className="secondary" onClick={() => { setPeriodStart(startOfMonthIso(todayIso())); setPeriodEnd(endOfMonthIso(todayIso())); }}>Este mes</button>
          <button className="secondary" onClick={() => { setPeriodStart(startOfMonthIso(addDaysIso(startOfMonthIso(todayIso()), -1))); setPeriodEnd(endOfMonthIso(addDaysIso(startOfMonthIso(todayIso()), -1))); }}>Mes pasado</button>
        </div>
        <p className="muted">Semana de lunes a domingo. {daysInPeriod} día{daysInPeriod !== 1 ? "s" : ""} en el período elegido.</p>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Resumen de caja (Tesorería)</h2>
          <span>{cashSummaryLoading ? "Cargando…" : null}</span>
        </div>
        <p className="muted" style={{ marginBottom: 14 }}>
          Cuánto entró y salió de tus cuentas en el período — ventas, sueldos, pagos a proveedores, gastos, todo. No es lo mismo que la Ganancia de abajo (que es margen de mercadería); esto es la plata real que se movió.
        </p>
        <div className="kpi-grid">
          <div className="kpi-card">
            <span>Ventas</span>
            <strong className="num-positive">{formatMoney(cashSummary.ventas)}</strong>
          </div>
          <div className="kpi-card">
            <span>Compras (pagos a proveedores)</span>
            <strong className="num-negative">{formatMoney(cashSummary.compras)}</strong>
          </div>
          <div className="kpi-card">
            <span>Sueldos (liquidaciones + vales)</span>
            <strong className="num-negative">{formatMoney(cashSummary.sueldos)}</strong>
          </div>
          <div className="kpi-card">
            <span>Gastos (+ajustes)</span>
            <strong className="num-negative">{formatMoney(cashSummary.gastos)}</strong>
          </div>
          {cashSummary.otros !== 0 && (
            <div className="kpi-card">
              <span>Otros</span>
              <strong className={cashSummary.otros < 0 ? "num-positive" : "num-negative"}>{formatMoney(cashSummary.otros)}</strong>
            </div>
          )}
          <div className="kpi-card">
            <span>Diferencia (cuánto te dejó)</span>
            <strong className={cashSummary.totalIn - cashSummary.totalOut < 0 ? "num-negative" : "num-positive"}>
              {formatMoney(cashSummary.totalIn - cashSummary.totalOut)}
            </strong>
          </div>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Total entradas {formatMoney(cashSummary.totalIn)} − Total salidas {formatMoney(cashSummary.totalOut)} = Diferencia. Las transferencias entre tus propias cuentas no cuentan acá.
        </p>
        <table className="data-table" style={{ marginTop: 14 }}>
          <thead>
            <tr><th>Tipo de movimiento</th><th className="num">Entradas</th><th className="num">Salidas</th></tr>
          </thead>
          <tbody>
            {cashSummary.byType.map((row) => (
              <tr key={row.type}>
                <td>{MOVEMENT_TYPE_LABELS[row.type] ?? row.type}</td>
                <td className="num">{row.in ? formatMoney(row.in) : "-"}</td>
                <td className="num">{row.out ? formatMoney(row.out) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!cashSummaryLoading && cashSummary.byType.length === 0 && <p className="muted">No hay movimientos de Tesorería en este período.</p>}
      </section>

      <div className="content-grid" style={{ marginTop: 18 }}>
        <section className="panel">
          <div className="panel-title">
            <h2>Cierre del período</h2>
          </div>
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 4 }}>
            <input type="text" inputMode="decimal" placeholder="Stock inicial ($)" value={stockStart} onChange={(e) => setStockStart(e.target.value)} />
            <input type="text" inputMode="decimal" placeholder="Stock final ($)" value={stockEnd} onChange={(e) => setStockEnd(e.target.value)} />
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>
            {stockStartDate ? `Stock inicial tomado del conteo del ${stockStartDate}.` : "No hay conteo cargado antes del inicio del período — completalo a mano o cargá un conteo."}
            {" "}
            {stockEndDate ? `Stock final tomado del conteo del ${stockEndDate}.` : "No hay conteo cargado antes del fin del período."}
          </p>
          <div className="kpi-grid">
            <div className="kpi-card">
              <span>Ventas</span>
              <strong>{previewLoading ? "…" : formatMoney(salesTotal)}</strong>
            </div>
            <div className="kpi-card">
              <span>Compras</span>
              <strong>{previewLoading ? "…" : formatMoney(purchasesTotal)}</strong>
            </div>
            <div className="kpi-card">
              <span>Costos fijos (prorrateado)</span>
              <strong>{formatMoney(fixedCostsPeriod)}</strong>
            </div>
            <div className="kpi-card">
              <span>Ganancia</span>
              <strong className={grossProfit < 0 ? "num-negative" : "num-positive"}>{formatMoney(grossProfit)}</strong>
            </div>
          </div>
          <button className="charge-button" style={{ marginTop: 14 }} onClick={handleClosePeriod}>
            Cerrar período
          </button>

          <table className="data-table" style={{ marginTop: 18 }}>
            <thead>
              <tr>
                <th>Período</th>
                <th className="num">Ventas</th>
                <th className="num">Compras</th>
                <th className="num">Costos fijos</th>
                <th className="num">Stock ini.</th>
                <th className="num">Stock fin.</th>
                <th className="num">Ganancia</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id}>
                  <td>{p.periodStart} — {p.periodEnd}</td>
                  <td className="num">{formatMoney(p.salesTotal)}</td>
                  <td className="num">{formatMoney(p.purchasesTotal)}</td>
                  <td className="num">{formatMoney(p.fixedCostsTotal)}</td>
                  <td className="num">{formatMoney(p.stockStart)}</td>
                  <td className="num">{formatMoney(p.stockEnd)}</td>
                  <td className={`num ${p.grossProfit < 0 ? "num-negative" : "num-positive"}`}>{formatMoney(p.grossProfit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {periods.length === 0 && <p className="muted">Todavía no cerraste ningún período.</p>}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Qué se compró más</h2>
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>
            Suma automática de los kg/unidades de las facturas de compra cargadas en este período — no hay que cargar nada acá.
          </p>
          <table className="data-table">
            <thead>
              <tr><th>Producto</th><th className="num">Cantidad</th><th className="num">Monto</th></tr>
            </thead>
            <tbody>
              {purchasedProducts.map((p) => (
                <tr key={p.label}>
                  <td>{p.label}</td>
                  <td className="num">{p.quantity} {p.unit === "kg" ? "kg" : "u"}</td>
                  <td className="num">{formatMoney(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {purchasedProducts.length === 0 && !purchasedProductsLoading && (
            <p className="muted">No hay compras cargadas en este período.</p>
          )}
        </section>
      </div>
    </>
  );
}
