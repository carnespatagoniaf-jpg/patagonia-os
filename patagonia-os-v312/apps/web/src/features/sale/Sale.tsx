import { useEffect, useState } from "react";
import type { Product } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuth } from "../auth/AuthProvider";
import { can } from "../auth/permissions";
import { listProductsForBranch } from "../inventory/inventory-service";
import { useTreasury } from "../shifts/useTreasury";
import { createPosSale } from "./sale-service";
import {
  closePosShift,
  getOpenPosShift,
  listPosShiftSales,
  openPosShift,
  voidPosSale,
  type CloseShiftResult,
  type PosShift,
  type PosShiftSale
} from "./pos-shift-service";
import { formatMoney } from "../shifts/format";
import { parseAmount } from "../../lib/money";

const UNIT_LABELS: Record<Product["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

interface TicketLine {
  key: string;
  kind: "product" | "manual";
  productId?: string;
  name: string;
  unit: Product["unit"];
  quantity: number;
  unitPrice: number;
}

interface PaymentRow {
  accountId: string;
  amount: string;
}

interface ReceiptLine {
  name: string;
  unit: Product["unit"];
  quantity: number;
  unitPrice: number;
  discountAmount: number;
}

interface ReceiptState {
  items: ReceiptLine[];
  saleDiscount: number;
  saleSurcharge: number;
  total: number;
  soldAt: string;
  paymentSummary: string;
  amountTendered: number | null;
  change: number | null;
}

export function Sale() {
  const { branchId } = useActiveBranch();
  const { profile } = useAuth();
  const { accounts, adjust } = useTreasury();
  const canManageTreasury = can(profile, "treasury.manage");

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [shift, setShift] = useState<PosShift | null>(null);
  const [shiftLoading, setShiftLoading] = useState(isSupabaseConfigured);
  const [shiftSales, setShiftSales] = useState<PosShiftSale[]>([]);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [closeSummary, setCloseSummary] = useState<CloseShiftResult | null>(null);
  const [closeDetail, setCloseDetail] = useState<PosShiftSale[]>([]);

  const [search, setSearch] = useState("");
  const [showProductTable, setShowProductTable] = useState(false);
  const [cart, setCart] = useState<TicketLine[]>([]);
  const [itemDiscounts, setItemDiscounts] = useState<Record<string, string>>({});
  const [saleDiscount, setSaleDiscount] = useState("");
  const [saleDiscountMode, setSaleDiscountMode] = useState<"amount" | "percent">("amount");
  const [saleSurcharge, setSaleSurcharge] = useState("");
  const [saleSurchargeMode, setSaleSurchargeMode] = useState<"amount" | "percent">("amount");
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);

  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDesc, setManualDesc] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualQty, setManualQty] = useState("1");

  const [payments, setPayments] = useState<PaymentRow[]>([{ accountId: "", amount: "" }]);
  const [cashTendered, setCashTendered] = useState("");

  const [showCajaForm, setShowCajaForm] = useState(false);
  const [cajaDirection, setCajaDirection] = useState<"in" | "out">("out");
  const [cajaAccountId, setCajaAccountId] = useState("");
  const [cajaAmount, setCajaAmount] = useState("");
  const [cajaReason, setCajaReason] = useState("");
  const [cajaBusy, setCajaBusy] = useState(false);

  const grossTotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const itemDiscountTotal = cart.reduce((sum, line) => sum + (parseAmount(itemDiscounts[line.key] || "0") || 0), 0);
  const saleDiscountRaw = parseAmount(saleDiscount || "0") || 0;
  const saleDiscountValue = saleDiscountMode === "percent" ? Math.round((grossTotal * saleDiscountRaw) / 100) : saleDiscountRaw;
  const saleSurchargeRaw = parseAmount(saleSurcharge || "0") || 0;
  const saleSurchargeValue = saleSurchargeMode === "percent" ? Math.round((grossTotal * saleSurchargeRaw) / 100) : saleSurchargeRaw;
  // Redondeado a pesos enteros -- el resto de la app no maneja centavos, y
  // si no se redondea acá el total que se ve en pantalla no coincide con el
  // que exige el servidor al dividir el pago a mano.
  const total = Math.round(Math.max(grossTotal - itemDiscountTotal - saleDiscountValue + saleSurchargeValue, 0));

  const isSplit = payments.length > 1;
  const singleAccount = !isSplit ? accounts.find((a) => a.id === payments[0]?.accountId) ?? null : null;
  const isSingleCash = !isSplit && singleAccount?.paymentMethod === "cash";
  const tenderedValue = cashTendered ? parseAmount(cashTendered) : null;
  const change = isSingleCash && tenderedValue !== null && Number.isFinite(tenderedValue) ? tenderedValue - total : null;
  const splitPaymentsTotal = payments.reduce((sum, p) => sum + (parseAmount(p.amount || "0") || 0), 0);
  const splitRemaining = total - splitPaymentsTotal;

  const activeShiftSales = shiftSales.filter((s) => !s.voidedAt);
  const shiftTotal = activeShiftSales.reduce((sum, s) => sum + s.total, 0);

  async function reloadProducts() {
    if (!isSupabaseConfigured || !branchId) return;
    setLoading(true);
    try {
      setProducts(await listProductsForBranch(branchId));
    } finally {
      setLoading(false);
    }
  }

  async function reloadShift() {
    if (!isSupabaseConfigured || !branchId) {
      setShiftLoading(false);
      return;
    }
    setShiftLoading(true);
    try {
      const open = await getOpenPosShift(branchId);
      setShift(open);
      setShiftSales(open ? await listPosShiftSales(open.id) : []);
    } finally {
      setShiftLoading(false);
    }
  }

  useEffect(() => {
    void reloadProducts();
    void reloadShift();
    setCloseSummary(null);
    setCloseDetail([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  async function handleCajaMovement() {
    setMessage("");
    if (!cajaAccountId) { setMessage("Elegí una cuenta."); return; }
    const amount = parseAmount(cajaAmount || "0") || 0;
    if (!(amount > 0)) { setMessage("El monto debe ser mayor que cero."); return; }
    if (!cajaReason.trim()) { setMessage("Ingresá un motivo."); return; }
    setCajaBusy(true);
    try {
      await adjust({ accountId: cajaAccountId, amount, direction: cajaDirection, reason: cajaReason.trim() });
      setCajaAccountId("");
      setCajaAmount("");
      setCajaReason("");
      setShowCajaForm(false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el movimiento de caja.");
    } finally {
      setCajaBusy(false);
    }
  }

  async function handleOpenShift() {
    setMessage("");
    if (!isSupabaseConfigured) {
      setShift({ id: "demo-shift", openedAt: new Date().toISOString() });
      setShiftSales([]);
      return;
    }
    if (!branchId) return;
    setBusy(true);
    try {
      setShift(await openPosShift(branchId));
      setShiftSales([]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo abrir el turno.");
    } finally {
      setBusy(false);
    }
  }

  const filteredProducts = products
    .filter((p) => p.active ?? true)
    .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.code.toLowerCase() === search.toLowerCase());

  function quickAdd(product: Product, quantity = 1) {
    setMessage("");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setMessage("La cantidad debe ser mayor que cero.");
      return;
    }
    setCart((current) => {
      const existing = current.find((l) => l.key === product.id);
      if (existing) {
        return current.map((l) => (l.key === product.id ? { ...l, quantity: l.quantity + quantity } : l));
      }
      return [...current, { key: product.id, kind: "product", productId: product.id, name: product.name, unit: product.unit, quantity, unitPrice: product.priceRetail }];
    });
    setSearch("");
  }

  function addManualItem() {
    setMessage("");
    const desc = manualDesc.trim();
    const price = parseAmount(manualPrice || "0") || 0;
    const qty = Number(manualQty || "1");
    if (!desc) { setMessage("Ingresá una descripción para el artículo."); return; }
    if (!(price >= 0)) { setMessage("Precio inválido."); return; }
    if (!(qty > 0)) { setMessage("Cantidad inválida."); return; }
    const key = `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setCart((current) => [...current, { key, kind: "manual", name: desc, unit: "unit", quantity: qty, unitPrice: price }]);
    setManualDesc("");
    setManualPrice("");
    setManualQty("1");
    setShowManualForm(false);
  }

  /**
   * Etiquetas de balanza Kretz: EAN-13 "2" + PLU (5 dígitos) + peso en gramos
   * (5 dígitos) + dígito verificador. Ej. 2000102004720 = PLU 00102, peso
   * 00472 = 0,472 kg. El precio no se lee del código -- siempre se usa el
   * precio actual del producto en el sistema.
   */
  function parseWeightBarcode(code: string): { plu: string; weightKg: number } | null {
    if (!/^\d{13}$/.test(code) || code[0] !== "2") return null;
    const plu = String(parseInt(code.slice(2, 7), 10));
    const weightGrams = parseInt(code.slice(7, 12), 10);
    if (!Number.isFinite(weightGrams) || weightGrams <= 0) return null;
    return { plu, weightKg: weightGrams / 1000 };
  }

  /** El lector de código de barra "tipea" el código y Enter en este mismo buscador. */
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const raw = search.trim();

    const weight = parseWeightBarcode(raw);
    if (weight) {
      const match = products.find((p) => (p.active ?? true) && p.code === weight.plu);
      if (match) {
        quickAdd(match, weight.weightKg);
        return;
      }
    }

    const match = products.find((p) => (p.active ?? true) && p.code.toLowerCase() === raw.toLowerCase());
    if (match) {
      quickAdd(match);
      return;
    }

    setMessage("No se encontró ningún producto con ese código.");
  }

  const searchMatches = search.trim() ? filteredProducts.slice(0, 8) : [];

  function removeFromCart(key: string) {
    setCart((current) => current.filter((l) => l.key !== key));
    setItemDiscounts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function updateCartQuantity(key: string, raw: string) {
    const quantity = Number(raw);
    setCart((current) => current.map((l) => (l.key === key ? { ...l, quantity } : l)));
  }

  function clearTicket() {
    setCart([]);
    setItemDiscounts({});
    setSaleDiscount("");
    setSaleDiscountMode("amount");
    setSaleSurcharge("");
    setSaleSurchargeMode("amount");
    setPayments([{ accountId: "", amount: "" }]);
    setCashTendered("");
    setMessage("");
  }

  function addPaymentRow() {
    setPayments((current) => [...current, { accountId: "", amount: "" }]);
  }

  function removePaymentRow(index: number) {
    setPayments((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));
  }

  function updatePaymentRow(index: number, field: "accountId" | "amount", value: string) {
    setPayments((current) => current.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  }

  async function checkout() {
    if (cart.length === 0 || !shift) return;

    if (!isSplit) {
      if (!payments[0]?.accountId) {
        setMessage("Elegí de qué cuenta cobrás.");
        return;
      }
      if (isSingleCash && (tenderedValue === null || !Number.isFinite(tenderedValue) || tenderedValue < total)) {
        setMessage("Ingresá cuánto te dio el cliente (tiene que alcanzar para el total).");
        return;
      }
    } else {
      if (payments.some((p) => !p.accountId)) {
        setMessage("Elegí la cuenta en cada medio de pago.");
        return;
      }
      if (Math.abs(splitRemaining) > 0.5) {
        setMessage(`Los medios de pago no suman el total — falta ${formatMoney(splitRemaining)}.`);
        return;
      }
    }

    setBusy(true);
    setMessage("");
    try {
      const itemDiscountsSnapshot: Record<string, number> = {};
      cart.forEach((l) => { itemDiscountsSnapshot[l.key] = parseAmount(itemDiscounts[l.key] || "0") || 0; });

      const receiptLines: ReceiptLine[] = cart.map((l) => ({
        name: l.name, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: itemDiscountsSnapshot[l.key]
      }));
      const paymentSummary = isSplit
        ? payments.map((p) => accounts.find((a) => a.id === p.accountId)?.name ?? "-").join(" + ")
        : singleAccount?.name ?? "-";

      if (!isSupabaseConfigured) {
        setReceipt({
          items: receiptLines,
          saleDiscount: saleDiscountValue,
          saleSurcharge: saleSurchargeValue,
          total,
          soldAt: new Date().toISOString(),
          paymentSummary,
          amountTendered: tenderedValue,
          change
        });
        clearTicket();
        setMessage("Venta registrada (modo demo, no se descuenta stock real).");
        return;
      }
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      const itemsPayload = cart.map((l) => ({
        productId: l.kind === "product" ? l.productId : undefined,
        description: l.kind === "manual" ? l.name : undefined,
        unitPrice: l.kind === "manual" ? l.unitPrice : undefined,
        quantity: l.quantity,
        discountAmount: itemDiscountsSnapshot[l.key]
      }));
      const paymentsPayload = isSplit
        ? payments.map((p) => ({ accountId: p.accountId, amount: parseAmount(p.amount || "0") || 0 }))
        : [{ accountId: payments[0].accountId, amount: total }];

      const result = await createPosSale({
        branchId,
        posShiftId: shift.id,
        items: itemsPayload,
        payments: paymentsPayload,
        discountAmount: saleDiscountValue,
        surchargeAmount: saleSurchargeValue
      });
      setReceipt({
        items: receiptLines,
        saleDiscount: saleDiscountValue,
        saleSurcharge: saleSurchargeValue,
        total: result.total,
        soldAt: new Date().toISOString(),
        paymentSummary,
        amountTendered: tenderedValue,
        change
      });
      clearTicket();
      await reloadProducts();
      await reloadShift();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar la venta.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVoidSale(saleId: string) {
    setMessage("");
    setBusy(true);
    try {
      if (!isSupabaseConfigured) {
        setShiftSales((current) => current.map((s) => (s.id === saleId ? { ...s, voidedAt: new Date().toISOString() } : s)));
        return;
      }
      await voidPosSale(saleId);
      await reloadShift();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo anular la venta.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCloseShift() {
    if (!shift) return;
    setBusy(true);
    setMessage("");
    try {
      if (!isSupabaseConfigured) {
        setCloseSummary({ total: shiftTotal, byAccount: [] });
        setCloseDetail(activeShiftSales);
        setShift(null);
        setShiftSales([]);
        setShowCloseConfirm(false);
        return;
      }
      const detailSnapshot = activeShiftSales;
      const result = await closePosShift(shift.id);
      setCloseSummary(result);
      setCloseDetail(detailSnapshot);
      setShowCloseConfirm(false);
      await reloadShift();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cerrar el turno.");
    } finally {
      setBusy(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">VENTA</p>
          <h1>Mostrador</h1>
          <p className="muted">Escaneá la etiqueta de la balanza (carga el peso solo) o buscá por nombre para lo que no tiene código.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}

      {shiftLoading ? (
        <p className="muted">Cargando turno…</p>
      ) : !shift ? (
        <section className="panel">
          <div className="panel-title">
            <h2>No hay un turno abierto</h2>
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>
            Abrí un turno para empezar a cobrar. Las ventas se van sumando y recién se cargan a Tesorería cuando cerrás el turno.
          </p>
          <button disabled={busy} onClick={handleOpenShift}>{busy ? "Abriendo…" : "Abrir turno"}</button>
        </section>
      ) : (
        <>
          <section className="panel">
            <div className="panel-title">
              <h2>Turno abierto</h2>
              <span>desde {new Date(shift.openedAt).toLocaleTimeString("es-AR")}</span>
            </div>
            <p className="muted">{activeShiftSales.length} ventas · {formatMoney(shiftTotal)} acumulado</p>

            {shiftSales.length > 0 && (
              <table className="data-table" style={{ marginTop: 10 }}>
                <thead>
                  <tr><th>Hora</th><th className="num">Total</th><th></th><th></th></tr>
                </thead>
                <tbody>
                  {shiftSales.map((s) => (
                    <tr key={s.id} style={s.voidedAt ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                      <td>{new Date(s.createdAt).toLocaleTimeString("es-AR")}</td>
                      <td className="num">{formatMoney(s.total)}</td>
                      <td>{s.voidedAt ? "Anulada" : ""}</td>
                      <td>
                        {!s.voidedAt && (
                          <button className="secondary" disabled={busy} onClick={() => handleVoidSale(s.id)}>Anular</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {canManageTreasury && (
              <div style={{ marginTop: 10 }}>
                {!showCajaForm ? (
                  <button className="secondary" onClick={() => setShowCajaForm(true)}>+ Movimiento de caja</button>
                ) : (
                  <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                    <select value={cajaDirection} onChange={(e) => setCajaDirection(e.target.value as "in" | "out")}>
                      <option value="out">Egreso</option>
                      <option value="in">Ingreso</option>
                    </select>
                    <select value={cajaAccountId} onChange={(e) => setCajaAccountId(e.target.value)}>
                      <option value="">Cuenta…</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Monto"
                      value={cajaAmount}
                      onChange={(e) => setCajaAmount(e.target.value)}
                      style={{ width: 110 }}
                    />
                    <input
                      placeholder="Motivo"
                      value={cajaReason}
                      onChange={(e) => setCajaReason(e.target.value)}
                      style={{ flex: 1, minWidth: 160 }}
                    />
                    <button disabled={cajaBusy} onClick={handleCajaMovement}>{cajaBusy ? "Guardando…" : "Registrar"}</button>
                    <button className="secondary" onClick={() => setShowCajaForm(false)}>Cancelar</button>
                  </div>
                )}
              </div>
            )}

            {!showCloseConfirm ? (
              <button className="secondary" style={{ marginTop: 10 }} onClick={() => setShowCloseConfirm(true)}>Cerrar turno</button>
            ) : (
              <div style={{ marginTop: 10 }}>
                <p className="muted">¿Cerrar el turno y cargar {formatMoney(shiftTotal)} a Tesorería? No se puede deshacer.</p>
                <button disabled={busy} onClick={handleCloseShift}>{busy ? "Cerrando…" : "Confirmar cierre"}</button>{" "}
                <button className="secondary" onClick={() => setShowCloseConfirm(false)}>Cancelar</button>
              </div>
            )}
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div style={{ position: "relative" }}>
              <input
                type="text"
                placeholder="Escaneá o escribí el nombre / código del producto…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                style={{ width: "100%", fontSize: 20, padding: "16px 14px" }}
                autoFocus
              />
              {searchMatches.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    left: 0,
                    right: 0,
                    background: "#fff",
                    border: "1px solid #d6dce5",
                    borderRadius: 10,
                    boxShadow: "0 8px 24px rgba(0,0,0,.12)",
                    zIndex: 20,
                    maxHeight: 340,
                    overflowY: "auto"
                  }}
                >
                  {searchMatches.map((product) => (
                    <button
                      key={product.id}
                      className="secondary"
                      onClick={() => quickAdd(product)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        width: "100%",
                        textAlign: "left",
                        border: "none",
                        borderRadius: 0,
                        padding: "12px 14px"
                      }}
                    >
                      <span>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></span>
                      <strong>{formatMoney(product.priceRetail)}</strong>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 10 }}>
              {!showManualForm ? (
                <button className="secondary" onClick={() => setShowManualForm(true)}>+ Vender algo sin código</button>
              ) : (
                <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                  <input placeholder="Descripción" value={manualDesc} onChange={(e) => setManualDesc(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
                  <input type="text" inputMode="decimal" placeholder="Precio" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} style={{ width: 100 }} />
                  <input type="number" min="0.001" step="0.001" placeholder="Cant." value={manualQty} onChange={(e) => setManualQty(e.target.value)} style={{ width: 70 }} />
                  <button onClick={addManualItem}>Agregar</button>
                  <button className="secondary" onClick={() => setShowManualForm(false)}>Cancelar</button>
                </div>
              )}
            </div>

            <div style={{ marginTop: 10 }}>
              <button className="secondary" onClick={() => setShowProductTable((v) => !v)}>
                {showProductTable ? "Ocultar tabla de productos" : "Ver tabla de productos"}
              </button>
            </div>

            {showProductTable && (
              <table className="data-table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Código</th>
                    <th>Producto</th>
                    <th className="num">Precio</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((product) => (
                    <tr key={product.id}>
                      <td>{product.code}</td>
                      <td>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></td>
                      <td className="num">{formatMoney(product.priceRetail)}</td>
                      <td><button className="secondary" onClick={() => quickAdd(product)}>+ Agregar</button></td>
                    </tr>
                  ))}
                  {filteredProducts.length === 0 && (
                    <tr><td colSpan={4} className="muted">No hay productos que coincidan.</td></tr>
                  )}
                </tbody>
              </table>
            )}

            <table className="data-table" style={{ marginTop: 18 }}>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="num">Cant.</th>
                  <th className="num">Desc. $</th>
                  <th className="num">Subtotal</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {cart.map((line) => (
                  <tr key={line.key}>
                    <td style={{ fontSize: 16 }}>{line.name}{line.kind === "manual" && <span className="muted"> (manual)</span>}</td>
                    <td className="num">
                      <input
                        type="number"
                        min="0.001"
                        step="0.001"
                        value={line.quantity}
                        onChange={(e) => updateCartQuantity(line.key, e.target.value)}
                        style={{ width: 80 }}
                      />{" "}
                      {UNIT_LABELS[line.unit]}
                    </td>
                    <td className="num">
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={itemDiscounts[line.key] ?? ""}
                        onChange={(e) => setItemDiscounts({ ...itemDiscounts, [line.key]: e.target.value })}
                        style={{ width: 70 }}
                      />
                    </td>
                    <td className="num" style={{ fontSize: 16 }}>
                      {formatMoney(line.quantity * line.unitPrice - (parseAmount(itemDiscounts[line.key] || "0") || 0))}
                    </td>
                    <td><button className="secondary" onClick={() => removeFromCart(line.key)}>Quitar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cart.length === 0 && <p className="muted" style={{ marginTop: 14 }}>Escaneá o buscá un producto para empezar el ticket.</p>}

            {cart.length > 0 && (
              <>
                <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 14 }}>
                  <label className="muted">Descuento</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={saleDiscount}
                    onChange={(e) => setSaleDiscount(e.target.value)}
                    style={{ width: 90 }}
                  />
                  <select value={saleDiscountMode} onChange={(e) => setSaleDiscountMode(e.target.value as "amount" | "percent")}>
                    <option value="amount">$</option>
                    <option value="percent">%</option>
                  </select>
                  <label className="muted">Recargo</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={saleSurcharge}
                    onChange={(e) => setSaleSurcharge(e.target.value)}
                    style={{ width: 90 }}
                  />
                  <select value={saleSurchargeMode} onChange={(e) => setSaleSurchargeMode(e.target.value as "amount" | "percent")}>
                    <option value="amount">$</option>
                    <option value="percent">%</option>
                  </select>
                  <button className="secondary" onClick={clearTicket}>Cancelar ticket</button>
                </div>

                <div style={{ marginTop: 14, textAlign: "right" }}>
                  {(itemDiscountTotal > 0 || saleDiscountValue > 0 || saleSurchargeValue > 0) && (
                    <p className="muted" style={{ margin: 0 }}>
                      Subtotal {formatMoney(grossTotal)}
                      {(itemDiscountTotal > 0 || saleDiscountValue > 0) && ` · Descuentos -${formatMoney(itemDiscountTotal + saleDiscountValue)}`}
                      {saleSurchargeValue > 0 && ` · Recargo +${formatMoney(saleSurchargeValue)}`}
                    </p>
                  )}
                  <strong style={{ fontSize: 32 }}>{formatMoney(total)}</strong>
                </div>

                <div style={{ marginTop: 14 }}>
                  {payments.map((p, i) => (
                    <div className="cash-banner-form" key={i} style={{ flexWrap: "wrap", marginTop: 8, justifyContent: "flex-end" }}>
                      <select value={p.accountId} onChange={(e) => updatePaymentRow(i, "accountId", e.target.value)}>
                        <option value="">¿Con qué te paga?</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                      {isSplit && (
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="Monto"
                          value={p.amount}
                          onChange={(e) => updatePaymentRow(i, "amount", e.target.value)}
                          style={{ width: 110 }}
                        />
                      )}
                      {isSplit && payments.length > 1 && (
                        <button className="secondary" onClick={() => removePaymentRow(i)}>Quitar medio</button>
                      )}
                    </div>
                  ))}

                  {isSingleCash && (
                    <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 8, justifyContent: "flex-end" }}>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="Recibiste ($)"
                        value={cashTendered}
                        onChange={(e) => setCashTendered(e.target.value)}
                        style={{ width: 130 }}
                      />
                      {change !== null && (
                        <strong className={change < 0 ? "num-negative" : "num-positive"}>
                          Vuelto {formatMoney(Math.max(change, 0))}
                        </strong>
                      )}
                    </div>
                  )}

                  <div style={{ marginTop: 8, textAlign: "right" }}>
                    {!isSplit ? (
                      <button className="secondary" onClick={addPaymentRow}>+ Dividir el pago en más de un medio</button>
                    ) : (
                      <>
                        <p className="muted" style={{ margin: "0 0 8px" }}>
                          {Math.abs(splitRemaining) <= 0.5 ? "Los medios de pago cubren el total." : `Falta pagar ${formatMoney(splitRemaining)}`}
                        </p>
                        <button className="secondary" onClick={addPaymentRow}>+ Agregar otro medio de pago</button>
                      </>
                    )}
                  </div>

                  <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
                    <button className="charge-button" disabled={busy} onClick={checkout}>
                      {busy ? "Cobrando…" : "Cobrar"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </>
      )}

      {receipt && (
        <section className="panel print-area" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Último comprobante</h2>
            <button className="secondary no-print" onClick={handlePrint}>Imprimir</button>
          </div>
          <p className="muted print-only-header">{new Date(receipt.soldAt).toLocaleString("es-AR")} · {receipt.paymentSummary}</p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Cant.</th>
                <th className="num">Precio</th>
                <th className="num">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {receipt.items.map((item, idx) => (
                <tr key={idx}>
                  <td>{item.name}</td>
                  <td className="num">{item.quantity} {UNIT_LABELS[item.unit]}</td>
                  <td className="num">{formatMoney(item.unitPrice)}</td>
                  <td className="num">{formatMoney(item.quantity * item.unitPrice - item.discountAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(receipt.saleDiscount > 0 || receipt.saleSurcharge > 0) && (
            <p style={{ textAlign: "right" }} className="muted">
              {receipt.saleDiscount > 0 && `Descuento -${formatMoney(receipt.saleDiscount)} `}
              {receipt.saleSurcharge > 0 && `Recargo +${formatMoney(receipt.saleSurcharge)}`}
            </p>
          )}
          <p style={{ textAlign: "right", marginTop: 10 }}><strong>Total {formatMoney(receipt.total)}</strong></p>
          {receipt.amountTendered !== null && (
            <p style={{ textAlign: "right" }} className="muted">
              Recibido {formatMoney(receipt.amountTendered)} · Vuelto {formatMoney(Math.max(receipt.change ?? 0, 0))}
            </p>
          )}
        </section>
      )}

      {closeSummary && (
        <section className="panel print-area" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Detalle del turno cerrado</h2>
            <button className="secondary no-print" onClick={handlePrint}>Imprimir</button>
          </div>
          <p className="muted print-only-header">Cerrado {new Date().toLocaleString("es-AR")}</p>
          <p><strong>Total del turno: {formatMoney(closeSummary.total)}</strong></p>
          {closeSummary.byAccount.length > 0 && (
            <table className="data-table" style={{ marginBottom: 16 }}>
              <thead>
                <tr><th>Cuenta</th><th className="num">Ventas</th><th className="num">Monto</th></tr>
              </thead>
              <tbody>
                {closeSummary.byAccount.map((row) => (
                  <tr key={row.accountId}>
                    <td>{accounts.find((a) => a.id === row.accountId)?.name ?? row.accountId}</td>
                    <td className="num">{row.salesCount}</td>
                    <td className="num">{formatMoney(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table className="data-table">
            <thead>
              <tr><th>Hora</th><th>Producto</th><th className="num">Cant.</th><th className="num">Subtotal</th><th>Pago</th></tr>
            </thead>
            <tbody>
              {closeDetail.flatMap((sale) =>
                sale.items.map((item, idx) => (
                  <tr key={`${sale.id}-${idx}`}>
                    <td>{idx === 0 ? new Date(sale.createdAt).toLocaleTimeString("es-AR") : ""}</td>
                    <td>{item.productName}</td>
                    <td className="num">{item.quantity} {UNIT_LABELS[item.unit]}</td>
                    <td className="num">{formatMoney(item.lineTotal)}</td>
                    <td>{idx === 0 ? sale.payments.map((p) => p.accountName).join(" + ") : ""}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {closeDetail.length === 0 && <p className="muted">No hubo ventas en este turno.</p>}
        </section>
      )}
    </>
  );
}
