import { useEffect, useMemo, useState } from "react";
import type { PaymentMethod, Product } from "@patagonia/domain";
import { marginPercent, purchaseTotal } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listProductsForBranch } from "../inventory/inventory-service";
import { useSuppliers } from "./useSuppliers";
import { usePurchases } from "./usePurchases";
import { useTreasury } from "../shifts/useTreasury";
import type { PurchaseLineInput } from "./purchases-service";
import { parseAmount } from "../../lib/money";

interface DraftLine {
  key: string;
  productId: string;
  description: string;
  quantity: string;
  unit: "kg" | "unit";
  unitPrice: string;
}

function emptyLine(): DraftLine {
  return { key: crypto.randomUUID(), productId: "", description: "", quantity: "", unit: "kg", unitPrice: "" };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Efectivo",
  qr: "Mercado Pago QR",
  debit: "Débito",
  credit: "Crédito",
  bank_province: "Banco Provincia",
  transfer: "Transferencia"
};

interface LedgerRow {
  key: string;
  date: string;
  detail: string;
  debit: number;
  credit: number;
  balance: number;
}

export function Purchases() {
  const { suppliers, loading: suppliersLoading, error: suppliersError, create: createSupplier } = useSuppliers();
  const {
    purchases,
    items,
    payments,
    balance,
    loading: purchasesLoading,
    error: purchasesError,
    branchId,
    loadSupplier,
    create: createPurchase,
    editItem,
    registerPayment,
    updatePayment,
    removePayment
  } = usePurchases();
  const { accounts } = useTreasury();

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierCategory, setSupplierCategory] = useState("");
  const [supplierPhone, setSupplierPhone] = useState("");
  const [message, setMessage] = useState("");

  const [purchaseDate, setPurchaseDate] = useState(todayIso());
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [paymentNotes, setPaymentNotes] = useState("");

  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [editPaymentDate, setEditPaymentDate] = useState("");
  const [editPaymentAmount, setEditPaymentAmount] = useState("");
  const [editPaymentAccountId, setEditPaymentAccountId] = useState("");
  const [editPaymentNotes, setEditPaymentNotes] = useState("");

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editUnitPrice, setEditUnitPrice] = useState("");

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;
    listProductsForBranch(branchId).then(setProducts).catch(() => setProducts([]));
  }, [branchId]);

  useEffect(() => {
    if (selectedSupplierId) void loadSupplier(selectedSupplierId);
  }, [selectedSupplierId, loadSupplier]);

  const draftTotal = useMemo(() => {
    const parsed: PurchaseLineInput[] = lines
      .filter((line) => line.quantity && line.unitPrice)
      .map((line) => ({ quantity: Number(line.quantity), unitPrice: parseAmount(line.unitPrice), unit: line.unit }));
    return purchaseTotal(parsed);
  }, [lines]);

  async function handleCreateSupplier() {
    try {
      if (!supplierName.trim()) throw new Error("El nombre del proveedor es obligatorio.");
      const supplier = await createSupplier({
        name: supplierName.trim(),
        category: supplierCategory.trim() || "general",
        phone: supplierPhone.trim() || undefined
      });
      setSupplierName("");
      setSupplierCategory("");
      setSupplierPhone("");
      setSelectedSupplierId(supplier.id);
      setMessage("Proveedor creado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo crear el proveedor.");
    }
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((current) => [...current, emptyLine()]);
  }

  function removeLine(key: string) {
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
  }

  async function handleCreatePurchase() {
    try {
      if (!selectedSupplierId) throw new Error("Elegí un proveedor primero.");

      const parsed: PurchaseLineInput[] = lines.map((line) => {
        const quantity = Number(line.quantity);
        const unitPrice = parseAmount(line.unitPrice);
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Cada ítem necesita una cantidad válida.");
        if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("Cada ítem necesita un precio válido.");
        if (line.productId) return { productId: line.productId, quantity, unit: line.unit, unitPrice };
        if (!line.description.trim()) throw new Error("Elegí un producto o escribí una descripción.");
        return { description: line.description.trim(), quantity, unit: line.unit, unitPrice };
      });

      await createPurchase(selectedSupplierId, purchaseDate, invoiceNumber.trim() || undefined, parsed);
      setLines([emptyLine()]);
      setInvoiceNumber("");
      setMessage("Compra registrada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo registrar la compra.");
    }
  }

  async function handleSaveEdit(itemId: string) {
    try {
      if (!selectedSupplierId) return;
      const quantity = Number(editQuantity);
      const unitPrice = parseAmount(editUnitPrice);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Cantidad inválida.");
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("Precio inválido.");
      await editItem(selectedSupplierId, itemId, quantity, unitPrice);
      setEditingItemId(null);
      setMessage("Ítem actualizado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo editar el ítem.");
    }
  }

  async function handleRegisterPayment() {
    try {
      if (!selectedSupplierId) throw new Error("Elegí un proveedor primero.");
      const amount = parseAmount(paymentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!paymentAccountId) throw new Error("Elegí de qué cuenta sale el pago.");

      await registerPayment({
        supplierId: selectedSupplierId,
        paymentDate,
        amount,
        accountId: paymentAccountId,
        notes: paymentNotes.trim() || undefined
      });
      setPaymentAmount("");
      setPaymentNotes("");
      setMessage("Pago registrado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo registrar el pago.");
    }
  }

  function startEditPayment(payment: { id: string; paymentDate: string; amount: number; accountId?: string; notes?: string }) {
    setEditingPaymentId(payment.id);
    setEditPaymentDate(payment.paymentDate);
    setEditPaymentAmount(String(payment.amount));
    setEditPaymentAccountId(payment.accountId ?? "");
    setEditPaymentNotes(payment.notes ?? "");
  }

  async function handleSavePayment() {
    try {
      if (!selectedSupplierId || !editingPaymentId) return;
      const amount = parseAmount(editPaymentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!editPaymentAccountId) throw new Error("Elegí de qué cuenta sale el pago.");

      await updatePayment(selectedSupplierId, {
        id: editingPaymentId,
        paymentDate: editPaymentDate,
        amount,
        accountId: editPaymentAccountId,
        notes: editPaymentNotes.trim() || undefined
      });
      setEditingPaymentId(null);
      setMessage("Pago actualizado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar el pago.");
    }
  }

  async function handleDeletePayment(paymentId: string) {
    try {
      if (!selectedSupplierId) return;
      await removePayment(selectedSupplierId, paymentId);
      setMessage("Pago borrado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo borrar el pago.");
    }
  }

  const selectedSupplier = suppliers.find((s) => s.id === selectedSupplierId) ?? null;

  const ledger = useMemo<LedgerRow[]>(() => {
    const rows = [
      ...purchases.map((purchase) => ({
        key: `purchase-${purchase.id}`,
        date: purchase.purchaseDate,
        detail: purchase.invoiceNumber ? `Compra · Fact. ${purchase.invoiceNumber}` : "Compra",
        debit: purchase.total,
        credit: 0
      })),
      ...payments.map((payment) => ({
        key: `payment-${payment.id}`,
        date: payment.paymentDate,
        detail: `Pago · ${payment.accountName ?? PAYMENT_METHOD_LABELS[payment.paymentMethod]}${payment.notes ? ` · ${payment.notes}` : ""}`,
        debit: 0,
        credit: payment.amount
      }))
    ].sort((a, b) => a.date.localeCompare(b.date));

    let running = 0;
    return rows.map((row) => {
      running += row.debit - row.credit;
      return { ...row, balance: running };
    });
  }, [purchases, payments]);

  function handlePrintLedger() {
    window.print();
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">COMPRAS</p>
          <h1>Compras y proveedores</h1>
          <p className="muted">Cuenta corriente por proveedor, ligada a stock y a caja.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {suppliersError && <div className="message warning">{suppliersError}</div>}
      {purchasesError && <div className="message warning">{purchasesError}</div>}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Proveedores</h2>
            <span>{suppliersLoading ? "Cargando…" : `${suppliers.length} proveedores`}</span>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Rubro</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((supplier) => (
                <tr key={supplier.id}>
                  <td>{supplier.name}</td>
                  <td>{supplier.category}</td>
                  <td>
                    <button
                      className={supplier.id === selectedSupplierId ? "" : "secondary"}
                      onClick={() => setSelectedSupplierId(supplier.id)}
                    >
                      {supplier.id === selectedSupplierId ? "Seleccionado" : "Ver cuenta"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="cash-banner-form" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <input placeholder="Nombre" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
            <input placeholder="Rubro (pollo, carne...)" value={supplierCategory} onChange={(e) => setSupplierCategory(e.target.value)} />
            <input placeholder="Teléfono" value={supplierPhone} onChange={(e) => setSupplierPhone(e.target.value)} />
            <button onClick={handleCreateSupplier}>Agregar proveedor</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Cuenta corriente</h2>
          </div>
          {!selectedSupplier && <p className="muted">Elegí un proveedor para ver su cuenta.</p>}
          {selectedSupplier && (
            <div className="totals">
              <span>Proveedor <b>{selectedSupplier.name}</b></span>
              <span>Compras <b>{formatMoney(balance?.totalPurchases ?? 0)}</b></span>
              <span>Pagos <b>{formatMoney(balance?.totalPayments ?? 0)}</b></span>
              <strong>Saldo <b>{formatMoney(balance?.balance ?? 0)}</b></strong>
            </div>
          )}
        </section>
      </div>

      {selectedSupplier && (
        <>
          <section className="panel print-area" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Detalle de cuenta corriente</h2>
              <button className="secondary no-print" onClick={handlePrintLedger}>Imprimir</button>
            </div>
            <p className="muted print-only-header">
              {selectedSupplier.name} · {selectedSupplier.category}
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Comprobante</th>
                  <th className="num">Debe (compras)</th>
                  <th className="num">Haber (pagos)</th>
                  <th className="num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.key}>
                    <td>{row.date}</td>
                    <td>{row.detail}</td>
                    <td className="num">{row.debit > 0 ? formatMoney(row.debit) : "-"}</td>
                    <td className="num">{row.credit > 0 ? formatMoney(row.credit) : "-"}</td>
                    <td className="num">{formatMoney(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ledger.length === 0 && <p className="muted">Todavía no hay movimientos para este proveedor.</p>}
          </section>

          <section className="panel no-print" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Nueva compra</h2>
            </div>
            <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
              <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
              <input placeholder="N° de factura" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
            </div>

            {lines.map((line) => {
              const selectedProduct = products.find((p) => p.id === line.productId);
              return (
                <div key={line.key}>
                  <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 4 }}>
                    <select
                      value={line.productId}
                      onChange={(e) => updateLine(line.key, { productId: e.target.value, description: "" })}
                    >
                      <option value="">Sin producto (texto libre)</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>{product.name}</option>
                      ))}
                    </select>
                    {!line.productId && (
                      <input
                        placeholder="Descripción"
                        value={line.description}
                        onChange={(e) => updateLine(line.key, { description: e.target.value })}
                      />
                    )}
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder="Cantidad"
                      value={line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    />
                    <select value={line.unit} onChange={(e) => updateLine(line.key, { unit: e.target.value as "kg" | "unit" })}>
                      <option value="kg">kg</option>
                      <option value="unit">unidad</option>
                    </select>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Precio unitario"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                    />
                    <button className="danger" onClick={() => removeLine(line.key)}>Quitar</button>
                  </div>
                  {selectedProduct && (
                    <p className="muted" style={{ marginBottom: 10 }}>
                      Costo registrado: {formatMoney(selectedProduct.cost)} · Margen: {marginPercent(selectedProduct.cost, selectedProduct.priceRetail)}% · Venta: {formatMoney(selectedProduct.priceRetail)}
                    </p>
                  )}
                </div>
              );
            })}

            <div className="cash-banner-form">
              <button className="secondary" onClick={addLine}>+ Agregar ítem</button>
            </div>

            <div className="totals" style={{ marginTop: 14 }}>
              <strong>Total <b>{formatMoney(draftTotal)}</b></strong>
            </div>

            <button className="charge-button" style={{ marginTop: 14 }} onClick={handleCreatePurchase}>
              Registrar compra
            </button>
          </section>

          <div className="content-grid" style={{ marginTop: 18 }}>
            <section className="panel">
              <div className="panel-title">
                <h2>Compras</h2>
                <span>{purchasesLoading ? "Cargando…" : `${purchases.length} facturas`}</span>
              </div>
              {purchases.map((purchase) => (
                <div key={purchase.id} style={{ marginBottom: 16 }}>
                  <div className="list-row">
                    <strong>{purchase.purchaseDate}{purchase.invoiceNumber ? ` · Fact. ${purchase.invoiceNumber}` : ""}</strong>
                    <span className="num">Total {formatMoney(purchase.total)}</span>
                  </div>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Producto</th>
                        <th>Cantidad</th>
                        <th className="num">Precio</th>
                        <th className="num">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(items[purchase.id] ?? []).map((item) => (
                        <tr key={item.id}>
                          <td>{item.description ?? products.find((p) => p.id === item.productId)?.name ?? "Producto"}</td>
                          {editingItemId === item.id ? (
                            <>
                              <td>
                                <input type="number" step="0.001" value={editQuantity} onChange={(e) => setEditQuantity(e.target.value)} style={{ width: 80 }} />
                                {" "}{item.unit}
                              </td>
                              <td className="num">
                                <input type="text" inputMode="decimal" value={editUnitPrice} onChange={(e) => setEditUnitPrice(e.target.value)} style={{ width: 90 }} />
                              </td>
                              <td className="num">
                                <button onClick={() => handleSaveEdit(item.id)}>Guardar</button>
                                <button className="secondary" onClick={() => setEditingItemId(null)}>Cancelar</button>
                              </td>
                            </>
                          ) : (
                            <>
                              <td>{item.quantity} {item.unit}</td>
                              <td className="num">{formatMoney(item.unitPrice)}</td>
                              <td className="num">
                                {formatMoney(item.lineTotal)}{" "}
                                <button
                                  className="secondary"
                                  onClick={() => {
                                    setEditingItemId(item.id);
                                    setEditQuantity(String(item.quantity));
                                    setEditUnitPrice(String(item.unitPrice));
                                  }}
                                >
                                  Editar
                                </button>
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              {purchases.length === 0 && <p className="muted">Todavía no hay compras cargadas.</p>}
            </section>

            <section className="panel">
              <div className="panel-title">
                <h2>Pagos</h2>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
                <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Monto" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                <select value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
                  <option value="">Pagar desde…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <input placeholder="Nota" value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} />
                <button onClick={handleRegisterPayment}>Registrar pago</button>
              </div>

              <table className="data-table">
                <thead>
                  <tr><th>Fecha</th><th className="num">Monto</th><th>Cuenta</th><th>Nota</th><th></th></tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    editingPaymentId === payment.id ? (
                      <tr key={payment.id}>
                        <td><input type="date" value={editPaymentDate} onChange={(e) => setEditPaymentDate(e.target.value)} /></td>
                        <td>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="num"
                            value={editPaymentAmount}
                            onChange={(e) => setEditPaymentAmount(e.target.value)}
                            style={{ width: 100 }}
                          />
                        </td>
                        <td>
                          <select value={editPaymentAccountId} onChange={(e) => setEditPaymentAccountId(e.target.value)}>
                            <option value="">Pagar desde…</option>
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                          </select>
                        </td>
                        <td><input value={editPaymentNotes} onChange={(e) => setEditPaymentNotes(e.target.value)} /></td>
                        <td>
                          <button onClick={handleSavePayment}>Guardar</button>{" "}
                          <button className="secondary" onClick={() => setEditingPaymentId(null)}>Cancelar</button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={payment.id}>
                        <td>{payment.paymentDate}</td>
                        <td className="num">{formatMoney(payment.amount)}</td>
                        <td>{payment.accountName ?? PAYMENT_METHOD_LABELS[payment.paymentMethod]}</td>
                        <td>{payment.notes ?? "-"}</td>
                        <td>
                          <button className="secondary" onClick={() => startEditPayment(payment)}>Editar</button>{" "}
                          <button className="secondary" onClick={() => handleDeletePayment(payment.id)}>Borrar</button>
                        </td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
              {payments.length === 0 && <p className="muted">Todavía no hay pagos registrados.</p>}
            </section>
          </div>
        </>
      )}
    </>
  );
}
