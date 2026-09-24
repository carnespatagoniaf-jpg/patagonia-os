import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { isOverdueDebt, type Product } from "@patagonia/domain";
import { useCustomers } from "./useCustomers";
import { useTreasury } from "../shifts/useTreasury";
import { todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { listProductsForBranch } from "../inventory/inventory-service";
import type { CustomerChargeItem } from "./customers-service";

const UNIT_LABELS: Record<Product["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

interface ChargeCartLine {
  key: string;
  productId?: string;
  name: string;
  unit: Product["unit"];
  quantity: number;
  unitPrice: number;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

interface LedgerRow {
  key: string;
  type: "charge" | "payment";
  id: string;
  date: string;
  detail: string;
  debit: number;
  credit: number;
  balance: number;
}

export function Customers() {
  const {
    branchId,
    customers,
    loading,
    error,
    create,
    update,
    charges,
    payments,
    balance,
    detailLoading,
    loadDetail,
    addChargeWithItems,
    loadChargeItems,
    registerPayment,
    editCharge,
    removeCharge,
    editPayment,
    removePayment
  } = useCustomers();
  const { accounts } = useTreasury();

  const [products, setProducts] = useState<Product[]>([]);
  const [chargeSearch, setChargeSearch] = useState("");
  const [chargeCart, setChargeCart] = useState<ChargeCartLine[]>([]);
  const [chargeNote, setChargeNote] = useState("");
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDesc, setManualDesc] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [manualUnit, setManualUnit] = useState<Product["unit"]>("unit");
  const [printCharge, setPrintCharge] = useState<{ date: string; reason: string; amount: number; items: CustomerChargeItem[] } | null>(null);
  const [remitoBusyId, setRemitoBusyId] = useState<string | null>(null);
  const printSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!branchId) return;
    void listProductsForBranch(branchId).then(setProducts);
  }, [branchId]);

  useEffect(() => {
    if (printCharge) printSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [printCharge]);

  const chargeMatches = chargeSearch.trim()
    ? products.filter((p) => (p.active ?? true) && p.name.toLowerCase().includes(chargeSearch.toLowerCase())).slice(0, 8)
    : [];

  function addProductToCharge(product: Product) {
    setChargeCart((current) => {
      const existing = current.find((l) => l.productId === product.id);
      if (existing) {
        return current.map((l) => (l.productId === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...current, { key: product.id, productId: product.id, name: product.name, unit: product.unit, quantity: 1, unitPrice: product.priceRetail }];
    });
    setChargeSearch("");
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
    setChargeCart((current) => [...current, { key, name: desc, unit: manualUnit, quantity: qty, unitPrice: price }]);
    setManualDesc("");
    setManualPrice("");
    setManualQty("1");
    setManualUnit("unit");
    setShowManualForm(false);
  }

  function updateChargeItemQty(key: string, raw: string) {
    const parsed = Number(raw);
    setChargeCart((current) => current.map((l) => (l.key === key ? { ...l, quantity: l.unit === "kg" ? parsed : Math.round(parsed) } : l)));
  }

  function removeChargeItem(key: string) {
    setChargeCart((current) => current.filter((l) => l.key !== key));
  }

  const chargeTotal = chargeCart.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [locality, setLocality] = useState("");
  const [province, setProvince] = useState("");

  const [editingCustomer, setEditingCustomer] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editNotesField, setEditNotesField] = useState("");
  const [editLocality, setEditLocality] = useState("");
  const [editProvince, setEditProvince] = useState("");
  const [editTermDays, setEditTermDays] = useState("");
  const [editActive, setEditActive] = useState(true);

  const [chargeDate, setChargeDate] = useState(todayIso());

  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");

  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editReason, setEditReason] = useState("");
  const [editAccountId, setEditAccountId] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const selectedCustomer = customers.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedCustomer) {
      setEditName(selectedCustomer.name);
      setEditPhone(selectedCustomer.phone ?? "");
      setEditNotesField(selectedCustomer.notes ?? "");
      setEditLocality(selectedCustomer.locality ?? "");
      setEditProvince(selectedCustomer.province ?? "");
      setEditTermDays(selectedCustomer.paymentTermDays ? String(selectedCustomer.paymentTermDays) : "");
      setEditActive(selectedCustomer.active);
      setEditingCustomer(false);
    }
  }, [selectedCustomer]);

  function selectCustomer(id: string) {
    setSelectedId(id);
    void loadDetail(id);
  }

  async function handleUpdateCustomer() {
    if (busy || !selectedCustomer) return;
    setBusy(true);
    try {
      if (!editName.trim()) throw new Error("El nombre es obligatorio.");
      const termDays = editTermDays.trim() ? Number(editTermDays) : undefined;
      if (termDays !== undefined && (!Number.isFinite(termDays) || termDays <= 0)) throw new Error("El plazo tiene que ser un número mayor que cero.");
      await update({
        id: selectedCustomer.id,
        name: editName.trim(),
        phone: editPhone.trim() || undefined,
        notes: editNotesField.trim() || undefined,
        locality: editLocality.trim() || undefined,
        province: editProvince.trim() || undefined,
        paymentTermDays: termDays,
        active: editActive
      });
      setEditingCustomer(false);
      if (!editActive) setSelectedId(null);
      setMessage(editActive ? "Cliente actualizado." : "Cliente eliminado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo actualizar el cliente.");
    } finally {
      setBusy(false);
    }
  }

  const ledger = useMemo<LedgerRow[]>(() => {
    const rows: Omit<LedgerRow, "balance">[] = [
      ...charges.map((c) => ({
        key: `charge-${c.id}`,
        type: "charge" as const,
        id: c.id,
        date: c.chargeDate,
        detail: `Venta · ${c.reason}`,
        debit: c.amount,
        credit: 0
      })),
      ...payments.map((p) => ({
        key: `payment-${p.id}`,
        type: "payment" as const,
        id: p.id,
        date: p.paymentDate,
        detail: `Pago · ${p.accountName ?? "-"}${p.notes ? ` · ${p.notes}` : ""}`,
        debit: 0,
        credit: p.amount
      }))
    ].sort((a, b) => a.date.localeCompare(b.date));

    let running = 0;
    return rows.map((row) => {
      running += row.debit - row.credit;
      return { ...row, balance: running };
    });
  }, [charges, payments]);

  async function handleCreateCustomer() {
    if (busy) return;
    setBusy(true);
    try {
      if (!name.trim()) throw new Error("El nombre es obligatorio.");
      const result = await create({
        name: name.trim(),
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        locality: locality.trim() || undefined,
        province: province.trim() || undefined
      });
      setName("");
      setPhone("");
      setNotes("");
      setLocality("");
      setProvince("");
      selectCustomer(result.id);
      setMessage("Cliente creado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el cliente.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddCharge() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      if (chargeCart.length === 0) throw new Error("Agregá al menos un producto.");
      const cartSnapshot = chargeCart;
      const noteSnapshot = chargeNote.trim();
      const result = await addChargeWithItems({
        customerId: selectedCustomer.id,
        chargeDate,
        items: cartSnapshot.map((l) =>
          l.productId
            ? { productId: l.productId, quantity: l.quantity }
            : { description: l.name, unitPrice: l.unitPrice, quantity: l.quantity }
        ),
        reason: noteSnapshot || undefined
      });
      setChargeCart([]);
      setChargeNote("");
      setMessage("Venta registrada -- se descontó el stock, igual que en el Mostrador.");
      // Se muestra el remito de ESTA venta al toque -- la mercadería tiene
      // que salir con la boleta en el momento, no buscarla después en el
      // historial (ahí es fácil confundir la de hoy con una vieja).
      setPrintCharge({
        date: chargeDate,
        reason: noteSnapshot || cartSnapshot.map((l) => l.name).join(", "),
        amount: result.amount,
        items: cartSnapshot.map((l) => ({
          id: l.key,
          productName: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.quantity * l.unitPrice
        }))
      });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar la venta.");
    } finally {
      setBusy(false);
    }
  }

  /** El remito se arma al toque con lo que ya está guardado (los items de
   * la venta) -- no hace falta cargar nada de nuevo, solo traerlos. */
  async function handleShowRemito(row: LedgerRow) {
    setRemitoBusyId(row.id);
    try {
      const items = await loadChargeItems(row.id);
      if (items.length === 0) {
        setMessage("Esta venta no tiene detalle de productos (se cargó con el formulario viejo de monto + texto).");
        return;
      }
      setPrintCharge({ date: row.date, reason: row.detail, amount: row.debit, items });
    } catch (err) {
      // Detalle crudo del error -- para diagnosticar sin acceso a la base,
      // ya que el mensaje "lindo" de más abajo no alcanzó para ver la causa
      // real la primera vez que esto falló.
      const raw = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err);
      const code = (err as { code?: string })?.code;
      setMessage(`No se pudo cargar el detalle de la venta. [detalle: ${raw}${code ? ` · code ${code}` : ""}]`);
    } finally {
      setRemitoBusyId(null);
    }
  }

  async function handleRegisterPayment() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      const amount = parseAmount(paymentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!paymentAccountId) throw new Error("Elegí a qué cuenta entra el pago.");
      const result = await registerPayment({
        customerId: selectedCustomer.id,
        paymentDate,
        amount,
        accountId: paymentAccountId,
        notes: paymentNotes.trim() || undefined
      });
      setPaymentAmount("");
      setPaymentAccountId("");
      setPaymentNotes("");
      setMessage(`Pago registrado. Saldo restante: ${formatMoney(result.balance)}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el pago.");
    } finally {
      setBusy(false);
    }
  }

  function startEditRow(row: LedgerRow) {
    setEditingRowKey(row.key);
    setEditDate(row.date);
    if (row.type === "charge") {
      const charge = charges.find((c) => c.id === row.id);
      setEditAmount(String(charge?.amount ?? ""));
      setEditReason(charge?.reason ?? "");
    } else {
      const payment = payments.find((p) => p.id === row.id);
      setEditAmount(String(payment?.amount ?? ""));
      setEditAccountId(payment?.accountId ?? "");
      setEditNotes(payment?.notes ?? "");
    }
  }

  async function handleSaveRow(row: LedgerRow) {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      const amount = parseAmount(editAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");

      if (row.type === "charge") {
        if (!editReason.trim()) throw new Error("Ingresá un detalle.");
        await editCharge(selectedCustomer.id, { id: row.id, chargeDate: editDate, amount, reason: editReason.trim() });
      } else {
        if (!editAccountId) throw new Error("Elegí a qué cuenta entra el pago.");
        await editPayment(selectedCustomer.id, {
          id: row.id,
          paymentDate: editDate,
          amount,
          accountId: editAccountId,
          notes: editNotes.trim() || undefined
        });
      }
      setEditingRowKey(null);
      setMessage(row.type === "charge" ? "Venta actualizada." : "Pago actualizado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRow(row: LedgerRow) {
    if (busy) return;
    const label = row.type === "charge" ? "esta venta" : "este pago";
    if (!window.confirm(`¿Seguro que querés borrar ${label}? No se puede deshacer.`)) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      if (row.type === "charge") {
        await removeCharge(selectedCustomer.id, row.id);
        setMessage("Venta borrada.");
      } else {
        await removePayment(selectedCustomer.id, row.id);
        setMessage("Pago borrado.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo borrar.");
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
          <p className="eyebrow">CLIENTES</p>
          <h1>Clientes y cuenta corriente</h1>
          <p className="muted">Clientes a los que les vendés fiado, sin cobrar en el momento (mayoristas, etc.). Elegí un cliente de la lista y abajo vas a poder cargarle una venta o registrar un pago.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Clientes</h2>
            <span>{loading ? "Cargando…" : `${customers.length}`}</span>
          </div>
          <div className="panel-list-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Nombre</th><th className="num">Saldo</th><th></th></tr>
              </thead>
              <tbody>
                {customers.map((c) => {
                  const overdue = isOverdueDebt(c, todayIso());
                  return (
                    <tr key={c.id} style={overdue ? { background: "#fdecea" } : undefined}>
                      <td>
                        {c.name}
                        {overdue && <span className="message warning" style={{ display: "inline-block", marginLeft: 8, padding: "1px 8px", fontSize: 11 }}>Atrasado</span>}
                      </td>
                      <td className="num">{formatMoney(c.balance)}</td>
                      <td>
                        <button className={c.id === selectedId ? "" : "secondary"} onClick={() => selectCustomer(c.id)}>
                          {c.id === selectedId ? "Seleccionado" : "Ver cuenta"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {customers.length === 0 && !loading && <p className="muted">Todavía no cargaste ningún cliente.</p>}

          <div className="cash-banner-form" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="Teléfono (opcional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <input placeholder="Localidad (opcional)" value={locality} onChange={(e) => setLocality(e.target.value)} />
            <input placeholder="Provincia (opcional)" value={province} onChange={(e) => setProvince(e.target.value)} />
            <input placeholder="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <button disabled={busy} onClick={handleCreateCustomer}>Agregar cliente</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Cuenta corriente</h2>
          </div>
          {!selectedCustomer && <p className="muted">Elegí un cliente para ver su cuenta.</p>}
          {selectedCustomer && !editingCustomer && (
            <div className="totals">
              <span>Cliente <b>{selectedCustomer.name}</b></span>
              <span>Total vendido <b>{formatMoney(balance?.totalCharged ?? 0)}</b></span>
              <span>Pagado <b>{formatMoney(balance?.totalPaid ?? 0)}</b></span>
              <strong>Saldo (te debe) <b>{formatMoney(balance?.balance ?? 0)}</b></strong>
              <span>Plazo de pago <b>{selectedCustomer.paymentTermDays ? `${selectedCustomer.paymentTermDays} días` : "sin definir"}</b></span>
              {(selectedCustomer.locality || selectedCustomer.province) && (
                <span>Ubicación <b>{[selectedCustomer.locality, selectedCustomer.province].filter(Boolean).join(", ")}</b></span>
              )}
              <button className="secondary" style={{ marginTop: 10 }} onClick={() => setEditingCustomer(true)}>Editar</button>
            </div>
          )}
          {selectedCustomer && editingCustomer && (
            <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
              <input placeholder="Nombre" value={editName} onChange={(e) => setEditName(e.target.value)} />
              <input placeholder="Teléfono" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
              <input placeholder="Localidad" value={editLocality} onChange={(e) => setEditLocality(e.target.value)} />
              <input placeholder="Provincia" value={editProvince} onChange={(e) => setEditProvince(e.target.value)} />
              <input placeholder="Nota" value={editNotesField} onChange={(e) => setEditNotesField(e.target.value)} />
              <input
                type="number"
                placeholder="Plazo de pago (días)"
                value={editTermDays}
                onChange={(e) => setEditTermDays(e.target.value)}
                style={{ width: 170 }}
              />
              <select value={editActive ? "1" : "0"} onChange={(e) => setEditActive(e.target.value === "1")}>
                <option value="1">Activo</option>
                <option value="0">Inactivo (eliminado)</option>
              </select>
              <button disabled={busy} onClick={handleUpdateCustomer}>Guardar</button>
              <button className="secondary" disabled={busy} onClick={() => setEditingCustomer(false)}>Cancelar</button>
            </div>
          )}
        </section>
      </div>

      {printCharge && (
        <section ref={printSectionRef} className="panel print-area" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Remito</h2>
            <div className="no-print">
              <button className="secondary" onClick={handlePrint}>Imprimir</button>{" "}
              <button className="secondary" onClick={() => setPrintCharge(null)}>Cerrar</button>
            </div>
          </div>
          <div className="print-only-header">
            <p className="muted">{selectedCustomer?.name}</p>
            <p className="muted">Fecha de venta: {printCharge.date}</p>
            {printCharge.reason && <p className="muted">{printCharge.reason}</p>}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Cantidad</th>
                <th className="num">Precio unit.</th>
                <th className="num">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {printCharge.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.productName}</td>
                  <td className="num">{item.quantity}</td>
                  <td className="num">{formatMoney(item.unitPrice)}</td>
                  <td className="num">{formatMoney(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="totals" style={{ marginTop: 12 }}>
            <strong>Total <b>{formatMoney(printCharge.amount)}</b></strong>
          </div>
        </section>
      )}

      {selectedCustomer && (
        <>
          <div className="content-grid" style={{ marginTop: 18 }}>
            <section className="panel">
              <div className="panel-title">
                <h2>Nueva venta (fiado)</h2>
                <span className="muted" style={{ fontSize: 12 }}>Descuenta stock y suma al saldo del cliente, igual que una venta del Mostrador</span>
              </div>
              <div className="cash-banner-form" style={{ marginBottom: 10 }}>
                <label className="muted">Fecha</label>
                <input type="date" value={chargeDate} onChange={(e) => setChargeDate(e.target.value)} />
              </div>
              <div className="pos-search-wrap">
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>Producto</label>
                <input
                  type="text"
                  className="pos-search"
                  placeholder="Buscá el producto que le vendés…"
                  value={chargeSearch}
                  onChange={(e) => setChargeSearch(e.target.value)}
                  style={{ fontSize: 16, padding: "12px 14px 12px 42px" }}
                />
                {chargeMatches.length > 0 && (
                  <div className="pos-dropdown">
                    {chargeMatches.map((product) => (
                      <button key={product.id} type="button" className="pos-dropdown-item" onClick={() => addProductToCharge(product)}>
                        <span>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></span>
                        <strong>{formatMoney(product.priceRetail)}</strong>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {products.length === 0 && (
                <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Todavía no cargaste productos en el catálogo — usá "Vender algo sin código" para cargar la venta igual.
                </p>
              )}

              <div className="pos-toolbar">
                <button className={`pos-toolbar-btn${showManualForm ? " active" : ""}`} onClick={() => setShowManualForm((v) => !v)}>
                  + Vender algo sin código
                </button>
              </div>

              {showManualForm && (
                <div className="pos-manual-card">
                  <input placeholder="Descripción" value={manualDesc} onChange={(e) => setManualDesc(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={manualUnit === "kg" ? "Precio /kg" : "Precio"}
                    value={manualPrice}
                    onChange={(e) => setManualPrice(e.target.value)}
                    style={{ width: 100 }}
                  />
                  <input
                    type="number"
                    min={manualUnit === "kg" ? "0.001" : "1"}
                    step={manualUnit === "kg" ? "0.001" : "1"}
                    placeholder="Cant."
                    value={manualQty}
                    onChange={(e) => setManualQty(e.target.value)}
                    style={{ width: 70 }}
                  />
                  <select value={manualUnit} onChange={(e) => setManualUnit(e.target.value as Product["unit"])}>
                    <option value="unit">Unidad</option>
                    <option value="kg">Kg</option>
                  </select>
                  <button onClick={addManualItem}>Agregar</button>
                  <button className="secondary" onClick={() => setShowManualForm(false)}>Cancelar</button>
                </div>
              )}

              {chargeCart.length === 0 ? (
                <p className="muted" style={{ marginTop: 12 }}>Buscá y agregá los productos que le estás vendiendo.</p>
              ) : (
                <div className="pos-cart">
                  {chargeCart.map((line) => (
                    <div className="pos-cart-row" key={line.key} style={{ gridTemplateColumns: "1fr 90px 110px 34px" }}>
                      <div className="name">
                        {line.name}
                        <small>{formatMoney(line.unitPrice)} /{UNIT_LABELS[line.unit]}</small>
                      </div>
                      <input
                        type="number"
                        className="pos-qty-input"
                        min={line.unit === "kg" ? "0.001" : "1"}
                        step={line.unit === "kg" ? "0.001" : "1"}
                        value={line.quantity}
                        onChange={(e) => updateChargeItemQty(line.key, e.target.value)}
                      />
                      <span className="pos-line-total">{formatMoney(line.quantity * line.unitPrice)}</span>
                      <button className="pos-remove-btn" onClick={() => removeChargeItem(line.key)} aria-label="Quitar" title="Quitar">×</button>
                    </div>
                  ))}
                </div>
              )}

              {chargeCart.length > 0 && (
                <>
                  <div className="cash-banner-form" style={{ marginTop: 12 }}>
                    <input placeholder="Nota (opcional, ej. nº de factura)" value={chargeNote} onChange={(e) => setChargeNote(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
                  </div>
                  <div className="pos-total-bar" style={{ marginTop: 12 }}>
                    <div>
                      <p className="pos-total-label">Total de la venta</p>
                      <strong className="pos-total-value">{formatMoney(chargeTotal)}</strong>
                    </div>
                    <button className="charge-button pos-charge-btn" disabled={busy} onClick={handleAddCharge}>
                      {busy ? "Registrando…" : "Registrar venta"}
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="panel">
              <div className="panel-title">
                <h2>Registrar pago</h2>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
                <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Monto" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                <select value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
                  <option value="">Entra a…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                <input placeholder="Nota (opcional)" value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
                <button disabled={busy} onClick={handleRegisterPayment}>{busy ? "Registrando…" : "Registrar pago"}</button>
              </div>
            </section>
          </div>

          <section className={`panel${printCharge ? "" : " print-area"}`} style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Detalle de cuenta corriente</h2>
              <button className="secondary no-print" onClick={handlePrint}>Imprimir</button>
            </div>
            <p className="muted print-only-header">{selectedCustomer.name}</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Concepto</th>
                  <th className="num">Venta</th>
                  <th className="num">Pago</th>
                  <th className="num">Saldo</th>
                  <th className="no-print"></th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) =>
                  editingRowKey === row.key ? (
                    <Fragment key={row.key}>
                      <tr className="no-print">
                        <td><input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></td>
                        <td>
                          {row.type === "charge" ? (
                            <input placeholder="Detalle" value={editReason} onChange={(e) => setEditReason(e.target.value)} />
                          ) : (
                            <input placeholder="Nota" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
                          )}
                        </td>
                        <td colSpan={2}>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="num"
                            value={editAmount}
                            onChange={(e) => setEditAmount(e.target.value)}
                            style={{ width: 100 }}
                          />{" "}
                          {row.type === "payment" && (
                            <select value={editAccountId} onChange={(e) => setEditAccountId(e.target.value)}>
                              <option value="">Entra a…</option>
                              {accounts.map((a) => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td colSpan={2}>
                          <button disabled={busy} onClick={() => handleSaveRow(row)}>Guardar</button>{" "}
                          <button className="secondary" disabled={busy} onClick={() => setEditingRowKey(null)}>Cancelar</button>
                        </td>
                      </tr>
                    </Fragment>
                  ) : (
                    <tr key={row.key}>
                      <td>{row.date}</td>
                      <td>{row.detail}</td>
                      <td className="num">{row.debit > 0 ? formatMoney(row.debit) : "-"}</td>
                      <td className="num">{row.credit > 0 ? formatMoney(row.credit) : "-"}</td>
                      <td className="num">{formatMoney(row.balance)}</td>
                      <td className="no-print">
                        {row.type === "charge" && (
                          <>
                            <button className="secondary" disabled={remitoBusyId === row.id} onClick={() => handleShowRemito(row)}>
                              {remitoBusyId === row.id ? "…" : "Remito"}
                            </button>{" "}
                          </>
                        )}
                        <button className="secondary" disabled={busy} onClick={() => startEditRow(row)}>Editar</button>{" "}
                        <button className="secondary" disabled={busy} onClick={() => handleDeleteRow(row)}>Borrar</button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
            {ledger.length === 0 && !detailLoading && <p className="muted">Todavía no hay movimientos para este cliente.</p>}
          </section>
        </>
      )}
    </>
  );
}
