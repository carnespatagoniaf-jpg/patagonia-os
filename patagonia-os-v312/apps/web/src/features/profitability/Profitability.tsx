import { useEffect, useMemo, useState } from "react";
import { STOCK_COUNT_CATEGORIES } from "@patagonia/domain";
import { useProfitability } from "./useProfitability";
import { useShifts } from "../shifts/useShifts";
import { addDaysIso, endOfMonthIso, endOfWeekIso, formatMoney, startOfMonthIso, startOfWeekIso, todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { listTreasuryMovements } from "../shifts/treasury-service";
import { MOVEMENT_TYPE_LABELS } from "../shifts/Treasury";
import { getPeriodResult, sumPosSalesTotalInRange } from "../sale/pos-shift-service";
import { computePeriodResult, type PeriodResult } from "../shifts/period-result";
import { changePct, profitView } from "./profitability-view";
import { listCustomerChargesInRange } from "../customers/customers-service";

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

type ProfTab = "fijos" | "conteos" | "cierres" | "compras" | "caja";

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
  /** Costo de lo vendido con el costo de cada producto (el mismo cálculo que Reportes → Resultado). Se usa cuando no hay conteos de stock. */
  const [soldCost, setSoldCost] = useState<number | null>(null);
  // Rediseño 2026-11-02: la cuenta completa (igual que Reportes → Resultado) y el mismo largo de período anterior para comparar.
  const [periodResult, setPeriodResult] = useState<PeriodResult | null>(null);
  const [prevResult, setPrevResult] = useState<PeriodResult | null>(null);
  const [tab, setTab] = useState<ProfTab>("fijos");
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
      // Igual que close_profitability_period: Turnos + Mostrador (sin anuladas) + entregas a cuenta corriente
      // de los clientes de este local. Antes solo sumaba Turnos y con Mostrador daba Ventas $0 (2026-10-05).
      const days = Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000) + 1;
      const [rangeRows, purchases, mostrador, charges, result, prev] = await Promise.all([
        loadRange(from, to),
        getPurchasesTotal(from, to),
        sumPosSalesTotalInRange(branchId, from, to),
        listCustomerChargesInRange(branchId, from, to).catch(() => []),
        getPeriodResult(branchId, from, to).catch(() => null),
        getPeriodResult(branchId, addDaysIso(from, -days), addDaysIso(from, -1)).catch(() => null)
      ]);
      const computed = result ? computePeriodResult(result) : null;
      setPeriodResult(computed);
      setPrevResult(prev ? computePeriodResult(prev) : null);
      setSoldCost(computed ? computed.cost : null);
      const turnos = rangeRows.reduce((sum, row) => sum + row.sales.reduce((s, r) => s + r.amount, 0), 0);
      const pos = mostrador;
      const fiado = charges.reduce((sum, c) => sum + c.amount, 0);
      setSalesTotal(Math.round((turnos + pos + fiado) * 100) / 100);
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
  // Dos formas de calcular lo que costó la mercadería vendida:
  //  * con conteos de stock en pesos (stock inicial + compras − stock final), la de siempre;
  //  * sin conteos, con el costo de cada producto vendido. Antes, sin conteos ni compras el costo daba 0 y la
  //    ganancia salía igual a las ventas (real M2 26/10).
  const usesCounts = stockStart.trim() !== "" && stockEnd.trim() !== "";
  const cogs = usesCounts ? stockStartValue + purchasesTotal - stockEndValue : soldCost ?? 0;
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
    if (!window.confirm(`¿Seguro que querés desactivar "${fc.name}"? Deja de contar en la rentabilidad.`)) return;
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
    if (!window.confirm("¿Seguro que querés eliminar este conteo de stock? No se puede deshacer.")) return;
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

  const pr = periodResult;
  const view = pr
    ? profitView({
        sales: pr.sales,
        grossProfit: pr.grossProfit,
        losses: pr.stockLoss + pr.wasteLoss,
        expenses: pr.expenses,
        salaries: pr.salaries,
        fixedPeriod: fixedCostsPeriod,
        fixedMonthly: fixedCostsMonthly,
        days: daysInPeriod
      })
    : null;
  const prevNet = prevResult ? prevResult.result - Math.round((fixedCostsMonthly / 30) * daysInPeriod) : null;
  const salesChange = pr && prevResult ? changePct(pr.sales, prevResult.sales) : null;
  // Sin ventas en el período anterior no hay con qué comparar.
  const netChange = view && prevNet !== null && prevResult && prevResult.sales > 0 ? changePct(view.net, prevNet) : null;
  // Si el alquiler o la luz se pagan con "Gasto" en Tesorería y además están en costos fijos, se restan dos veces.
  const servicesPaid = pr?.expenseLines.find((l) => l.category === "servicios")?.amount ?? 0;
  const countsCost = usesCounts ? stockStartValue + purchasesTotal - stockEndValue : null;
  const presets: { label: string; from: string; to: string }[] = [
    { label: "Esta semana", from: startOfWeekIso(todayIso()), to: endOfWeekIso(todayIso()) },
    { label: "Semana pasada", from: startOfWeekIso(addDaysIso(todayIso(), -7)), to: endOfWeekIso(addDaysIso(todayIso(), -7)) },
    { label: "Este mes", from: startOfMonthIso(todayIso()), to: endOfMonthIso(todayIso()) },
    { label: "Mes pasado", from: startOfMonthIso(addDaysIso(startOfMonthIso(todayIso()), -1)), to: endOfMonthIso(addDaysIso(startOfMonthIso(todayIso()), -1)) }
  ];

  function Change({ value }: { value: number | null }) {
    if (value === null) return null;
    return <span className={value >= 0 ? "prof-change up" : "prof-change down"}>{value >= 0 ? "↑" : "↓"} {String(Math.abs(value)).replace(".", ",")}% vs. período anterior</span>;
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">RENTABILIDAD</p>
          <h1>¿Cuánto ganaste?</h1>
          <p className="muted">Lo que vendiste menos lo que te costó la mercadería, los gastos, los sueldos, las mermas y los costos fijos.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <section className="panel prof-period">
        <div className="ws-chips" style={{ margin: 0 }}>
          {presets.map((p) => (
            <button key={p.label} className={periodStart === p.from && periodEnd === p.to ? "ws-chip active" : "ws-chip"} onClick={() => { setPeriodStart(p.from); setPeriodEnd(p.to); }}>{p.label}</button>
          ))}
        </div>
        <div className="ws-form-row" style={{ gap: 8 }}>
          <label className="ws-field">Desde<input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></label>
          <label className="ws-field">Hasta<input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label>
          <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>{daysInPeriod} día{daysInPeriod !== 1 ? "s" : ""}</span>
        </div>
      </section>

      <div className="prof-grid">
        <section className="panel">
          <div className="panel-title" style={{ marginBottom: 10 }}>
            <h2>La cuenta del período</h2>
            {previewLoading && <span className="muted">Calculando…</span>}
          </div>
          {!pr ? (
            <p className="muted">{previewLoading ? "Calculando…" : "No se pudo calcular el período."}</p>
          ) : (
            <table className="data-table no-stack prof-waterfall">
              <tbody>
                <tr className="prof-main">
                  <td>Vendiste<small>Mostrador {formatMoney(pr.salesMostrador)} · a cuenta {formatMoney(pr.salesAccount)}{pr.salesTurnos ? ` · Turnos ${formatMoney(pr.salesTurnos)}` : ""}</small></td>
                  <td className="num"><b>{formatMoney(pr.sales)}</b><Change value={salesChange} /></td>
                </tr>
                <tr>
                  <td>− Lo que te costó la mercadería vendida<small>con el costo de cada producto en Stock{pr.estimatedSales > 0 ? `; ${formatMoney(pr.estimatedSales)} de ventas sin costo conocido se estimaron con el mismo %` : ""}</small></td>
                  <td className="num num-negative">− {formatMoney(pr.cost)}</td>
                </tr>
                <tr className="prof-sub">
                  <td>= Ganancia bruta<small>lo que te deja la mercadería: {view?.grossPct !== null && view?.grossPct !== undefined ? `${String(view.grossPct).replace(".", ",")}% de lo vendido` : "—"}</small></td>
                  <td className="num"><b>{formatMoney(pr.grossProfit)}</b></td>
                </tr>
                <tr>
                  <td>− Gastos<small>{pr.expenseLines.length > 0 ? pr.expenseLines.map((l) => `${l.label} ${formatMoney(l.amount)}`).join(" · ") : "los que cargás en Tesorería o en Mostrador como gasto"}</small></td>
                  <td className="num num-negative">− {formatMoney(pr.expenses)}</td>
                </tr>
                <tr>
                  <td>− Sueldos y vales<small>liquidaciones y vales de Empleados</small></td>
                  <td className="num num-negative">− {formatMoney(pr.salaries)}</td>
                </tr>
                <tr>
                  <td>− Mermas<small>faltantes al contar el stock {formatMoney(pr.stockLoss)} · decomisos {formatMoney(pr.wasteLoss)}</small></td>
                  <td className="num num-negative">− {formatMoney(pr.stockLoss + pr.wasteLoss)}</td>
                </tr>
                <tr>
                  <td>− Costos fijos<small>{fixedCosts.length > 0 ? `${formatMoney(fixedCostsMonthly)} por mes, ${daysInPeriod} días` : "no cargaste ninguno (pestaña Costos fijos)"}</small></td>
                  <td className="num num-negative">− {formatMoney(fixedCostsPeriod)}</td>
                </tr>
                <tr className={`prof-total${view && view.net < 0 ? " neg" : ""}`}>
                  <td>= Te quedó<small>{view?.netPct !== null && view?.netPct !== undefined ? `${String(view.netPct).replace(".", ",")}% de lo vendido` : ""}</small></td>
                  <td className="num"><b>{formatMoney(view?.net ?? 0)}</b><Change value={netChange} /></td>
                </tr>
              </tbody>
            </table>
          )}
          {pr && fixedCostsMonthly > 0 && servicesPaid > 0 && (
            <p className="message warning" style={{ margin: "12px 0 0" }}>
              Ojo: en este período cargaste {formatMoney(servicesPaid)} de gastos en "Servicios (luz, gas, alquiler)". Si alguno de esos también está en Costos fijos, se está restando dos veces: dejalo en un solo lugar.
            </p>
          )}
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
            No se restan los pagos a proveedores (ya están en lo que costó la mercadería), los pagos de deudas ni los pases entre cuentas. Es la misma cuenta de Reportes → Resultado, más los costos fijos.
          </p>
        </section>

        <div className="prof-side">
          <section className="panel">
            <h3 className="prof-side-title">Para no perder plata</h3>
            {view?.breakEvenMonthly ? (
              <>
                <strong className="prof-big">{formatMoney(view.breakEvenMonthly)}</strong>
                <p className="muted" style={{ margin: "2px 0 8px", fontSize: 13 }}>es lo que tenés que vender por mes (unos {formatMoney(view.breakEvenDaily ?? 0)} por día).</p>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Sale de tus costos fijos más los gastos, sueldos y mermas de este período llevados a un mes, divididos por lo que te deja la mercadería ({String(view.grossPct ?? 0).replace(".", ",")}%).
                </p>
              </>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Se calcula cuando hay ventas con margen en el período.</p>
            )}
          </section>
          <section className="panel">
            <h3 className="prof-side-title">La plata que se movió</h3>
            <div className="prof-cash">
              <span>Entró</span><b className="num-positive">{formatMoney(cashSummary.totalIn)}</b>
              <span>Salió</span><b className="num-negative">{formatMoney(cashSummary.totalOut)}</b>
              <span>Diferencia</span><b className={cashSummary.totalIn - cashSummary.totalOut < 0 ? "num-negative" : "num-positive"}>{formatMoney(cashSummary.totalIn - cashSummary.totalOut)}</b>
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              Es lo que entró y salió de tus cuentas de Tesorería (incluye pagos a proveedores y de deudas). No es la ganancia: podés ganar y tener menos plata si pagaste deudas o compraste de más.
            </p>
            <button className="link-button" style={{ marginTop: 6 }} onClick={() => setTab("caja")}>Ver el detalle</button>
          </section>
          {countsCost !== null && pr && (
            <section className="panel">
              <h3 className="prof-side-title">Con tus conteos de stock</h3>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Contando el stock, la mercadería vendida te costó <b>{formatMoney(countsCost)}</b>
                {countsCost > pr.cost
                  ? <>: {formatMoney(countsCost - pr.cost)} más que con los costos de Stock. Esa diferencia es merma que no se registró (o compras sin cargar en Stock).</>
                  : <>, parecido a lo que da con los costos de Stock.</>}
              </p>
            </section>
          )}
        </div>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="page-tabs">
          {(
            [
              ["fijos", `Costos fijos (${formatMoney(fixedCostsMonthly)}/mes)`],
              ["conteos", "Conteos de stock"],
              ["cierres", "Cierres guardados"],
              ["compras", "Qué se compró más"],
              ["caja", "Movimientos de caja"]
            ] as [ProfTab, string][]
          ).map(([key, label]) => (
            <button key={key} className={tab === key ? "page-tab active" : "page-tab"} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>

        {tab === "fijos" && (
          <>
            <p className="muted acc-tab-help">Lo que pagás todos los meses aunque no vendas nada y que <b>no</b> cargás como gasto en Tesorería (por ejemplo, el alquiler si lo pagás por afuera). Se cargan por mes y se reparten por día según el período.</p>
            <div className="ws-form-row" style={{ marginBottom: 12 }}>
              <label className="ws-field ws-grow">Nombre<input placeholder="Ej. Alquiler" value={fcName} onChange={(e) => setFcName(e.target.value)} /></label>
              <label className="ws-field">Monto por mes<input type="text" inputMode="decimal" value={fcAmount} onChange={(e) => setFcAmount(e.target.value)} style={{ width: 150 }} /></label>
              <button onClick={handleSaveFixedCost}>{editingFcId ? "Guardar cambio" : "Agregar costo fijo"}</button>
              {editingFcId && <button className="secondary" onClick={() => { setEditingFcId(null); setFcName(""); setFcAmount(""); }}>Cancelar</button>}
            </div>
            {fixedCosts.length === 0 ? (
              <p className="muted">Todavía no cargaste costos fijos.</p>
            ) : (
              <table className="data-table">
                <thead><tr><th>Nombre</th><th className="num">Por mes</th><th className="num">En este período</th><th></th></tr></thead>
                <tbody>
                  {fixedCosts.map((fc) => (
                    <tr key={fc.id}>
                      <td>{fc.name}</td>
                      <td className="num">{formatMoney(fc.monthlyAmount)}</td>
                      <td className="num muted">{formatMoney(Math.round((fc.monthlyAmount / 30) * daysInPeriod))}</td>
                      <td><div className="ws-row-actions"><button className="secondary" onClick={() => handleEditFixedCost(fc.id)}>Editar</button><button className="danger" onClick={() => handleDeactivateFixedCost(fc.id)}>Quitar</button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === "conteos" && (
          <>
            <p className="muted acc-tab-help">Si pesás la mercadería (por ejemplo los lunes, o el día 1 de cada mes) y anotás cuánto vale en pesos por categoría, el sistema compara: lo que costó lo vendido según el conteo contra lo que da con los costos de Stock. La diferencia es merma que no se registró.</p>
            <div className="ws-form-row" style={{ marginBottom: 10 }}>
              <label className="ws-field">Fecha del conteo<input type="date" value={countDate} onChange={(e) => setCountDate(e.target.value)} /></label>
              <button className="secondary" onClick={() => setCountDate(startOfWeekIso(todayIso()))}>Lunes de esta semana</button>
              <button className="secondary" onClick={() => setCountDate(startOfMonthIso(todayIso()))}>Día 1 de este mes</button>
            </div>
            <div className="prof-count-grid">
              {STOCK_COUNT_CATEGORIES.map((cat) => (
                <label key={cat} className="ws-field">
                  {CATEGORY_LABELS[cat]} ($)
                  <input type="text" inputMode="decimal" value={countValues[cat] ?? ""} onChange={(e) => setCountValues((current) => ({ ...current, [cat]: e.target.value }))} />
                </label>
              ))}
            </div>
            <div className="ws-form-row" style={{ margin: "10px 0 16px" }}><button onClick={handleSaveStockCount}>Guardar conteo</button></div>

            <div className="ws-form-row" style={{ marginBottom: 8 }}>
              <label className="ws-field">Stock al empezar el período ($)<input type="text" inputMode="decimal" value={stockStart} onChange={(e) => setStockStart(e.target.value)} style={{ width: 170 }} /></label>
              <label className="ws-field">Stock al terminar ($)<input type="text" inputMode="decimal" value={stockEnd} onChange={(e) => setStockEnd(e.target.value)} style={{ width: 170 }} /></label>
              {usesCounts && <button className="charge-button" style={{ padding: "10px 18px", fontSize: 14 }} onClick={handleClosePeriod}>Guardar el cierre del período</button>}
            </div>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
              {stockStartDate ? `El de inicio sale del conteo del ${stockStartDate}. ` : "No hay conteo antes del inicio: completalo a mano o cargá uno. "}
              {stockEndDate ? `El de cierre, del conteo del ${stockEndDate}.` : "No hay conteo antes del cierre."}
              {usesCounts && ` Con conteos: costo = stock inicial + compras (${formatMoney(purchasesTotal)}) − stock final.`}
            </p>
            <div className="ws-scroll" style={{ maxHeight: 320 }}>
              <table className="data-table">
                <thead>
                  <tr><th>Fecha</th>{STOCK_COUNT_CATEGORIES.map((cat) => <th key={cat} className="num hide-md">{CATEGORY_LABELS[cat]}</th>)}<th className="num">Total</th><th></th></tr>
                </thead>
                <tbody>
                  {stockCountsByDate.map((row) => (
                    <tr key={row.date}>
                      <td>{row.date}</td>
                      {row.byCategory.map((c) => <td key={c.category} className="num hide-md">{c.value ? formatMoney(c.value) : "-"}</td>)}
                      <td className="num"><b>{formatMoney(row.total)}</b></td>
                      <td><div className="ws-row-actions"><button className="danger" onClick={() => handleDeleteStockCountRow(row.ids)}>Quitar</button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {stockCountsByDate.length === 0 && <p className="muted ws-empty">Todavía no cargaste ningún conteo.</p>}
            </div>
          </>
        )}

        {tab === "cierres" && (
          <>
            <p className="muted acc-tab-help">Los períodos que guardaste con conteo de stock (pestaña Conteos). La cuenta de arriba ya está siempre al día sin guardar nada.</p>
            {periods.length === 0 ? (
              <p className="muted">Todavía no guardaste ningún cierre.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Período</th><th className="num">Ventas</th><th className="num hide-sm">Compras</th><th className="num hide-sm">Costos fijos</th><th className="num hide-md">Stock ini.</th><th className="num hide-md">Stock fin.</th><th className="num">Ganancia</th></tr></thead>
                  <tbody>
                    {periods.map((p) => (
                      <tr key={p.id}>
                        <td>{p.periodStart} al {p.periodEnd}</td>
                        <td className="num">{formatMoney(p.salesTotal)}</td>
                        <td className="num hide-sm">{formatMoney(p.purchasesTotal)}</td>
                        <td className="num hide-sm">{formatMoney(p.fixedCostsTotal)}</td>
                        <td className="num hide-md">{formatMoney(p.stockStart)}</td>
                        <td className="num hide-md">{formatMoney(p.stockEnd)}</td>
                        <td className={`num ${p.grossProfit < 0 ? "num-negative" : "num-positive"}`}>{formatMoney(p.grossProfit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === "compras" && (
          <>
            <p className="muted acc-tab-help">Suma de lo que entró por Compras en el período, por producto. No hay que cargar nada acá.</p>
            {purchasedProducts.length === 0 && !purchasedProductsLoading ? (
              <p className="muted">No hay compras cargadas en este período.</p>
            ) : (
              <div className="ws-scroll" style={{ maxHeight: 360 }}>
                <table className="data-table">
                  <thead><tr><th>Producto</th><th className="num">Cantidad</th><th className="num">Monto</th></tr></thead>
                  <tbody>
                    {purchasedProducts.map((p) => (
                      <tr key={p.label}><td>{p.label}</td><td className="num">{p.quantity} {p.unit === "kg" ? "kg" : "u"}</td><td className="num">{formatMoney(p.amount)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === "caja" && (
          <>
            <p className="muted acc-tab-help">Todo lo que entró y salió de tus cuentas en el período, por tipo. Los pases entre tus propias cuentas no cuentan.{cashSummaryLoading ? " Cargando…" : ""}</p>
            <div className="ws-scroll" style={{ maxHeight: 360 }}>
              <table className="data-table">
                <thead><tr><th>Tipo de movimiento</th><th className="num">Entró</th><th className="num">Salió</th></tr></thead>
                <tbody>
                  {cashSummary.byType.map((row) => (
                    <tr key={row.type}>
                      <td>{MOVEMENT_TYPE_LABELS[row.type] ?? row.type}</td>
                      <td className="num num-positive">{row.in ? formatMoney(row.in) : ""}</td>
                      <td className="num num-negative">{row.out ? formatMoney(row.out) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!cashSummaryLoading && cashSummary.byType.length === 0 && <p className="muted ws-empty">No hay movimientos de Tesorería en este período.</p>}
            </div>
          </>
        )}
      </section>
    </>
  );
}
