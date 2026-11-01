import { useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { amountInputText, parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import { itemLabel, stepQuantity, validateDraft, type CustomerOrder, type OrderDraftItem } from "./orders-logic";
import { saveOrder } from "./orders-service";

export interface CustomerOption {
  id: string;
  name: string;
  phone: string | null;
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Nuevo pedido / editar pedido. Pensado para cargarlo parado en el mostrador en menos de 20 segundos. */
export function OrderForm({
  branchId,
  products,
  customers,
  initial,
  defaultDate,
  onSaved,
  onCancel
}: {
  branchId: string;
  products: Product[];
  customers: CustomerOption[];
  initial: CustomerOrder | null;
  defaultDate: string;
  onSaved: (id: string, print: boolean, pickupDate: string) => void;
  onCancel: () => void;
}) {
  const [customerName, setCustomerName] = useState(initial?.customerName ?? "");
  const [customerId, setCustomerId] = useState<string | null>(initial?.customerId ?? null);
  const [customerPhone, setCustomerPhone] = useState(initial?.customerPhone ?? "");
  const [pickupDate, setPickupDate] = useState(initial?.pickupDate ?? defaultDate);
  const [pickupTime, setPickupTime] = useState(initial?.pickupTime ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [totalInput, setTotalInput] = useState(initial?.total != null ? amountInputText(initial.total) : "");
  const [depositInput, setDepositInput] = useState(initial && initial.deposit > 0 ? amountInputText(initial.deposit) : "");
  const [items, setItems] = useState<OrderDraftItem[]>(
    initial?.items.map((i) => ({ productId: i.productId, productName: i.productName, unit: i.unit, quantity: i.quantity, notes: i.notes ?? "" })) ?? []
  );
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const total = totalInput.trim() ? parseAmount(totalInput) : null;
  const deposit = depositInput.trim() ? parseAmount(depositInput) || 0 : 0;
  const due = total !== null ? Math.max(0, total - deposit) : null;

  const shown = useMemo(() => {
    const q = normalize(search);
    const list = q ? products.filter((p) => normalize(p.name).includes(q) || p.code.trim() === search.trim()) : products;
    return list.slice(0, q ? 30 : 18);
  }, [products, search]);

  function pickCustomer(name: string) {
    setCustomerName(name);
    const match = customers.find((c) => normalize(c.name) === normalize(name));
    setCustomerId(match?.id ?? null);
    if (match?.phone && !customerPhone.trim()) setCustomerPhone(match.phone);
  }

  function addProduct(p: Product) {
    setItems((current) => {
      const existing = current.find((i) => i.productId === p.id);
      if (existing) return current.map((i) => (i.productId === p.id ? { ...i, quantity: stepQuantity(i.quantity, i.unit, 1) } : i));
      return [...current, { productId: p.id, productName: p.name, unit: p.unit, quantity: 1, notes: "" }];
    });
    setSearch("");
  }

  function step(productId: string, direction: 1 | -1) {
    setItems((current) => current.map((i) => (i.productId === productId ? { ...i, quantity: stepQuantity(i.quantity, i.unit, direction) } : i)));
  }

  function setQuantityText(productId: string, text: string) {
    const value = Number(text.replace(",", "."));
    if (!Number.isFinite(value) || value < 0) return;
    setItems((current) => current.map((i) => (i.productId === productId ? { ...i, quantity: Math.round(value * 1000) / 1000 } : i)));
  }

  async function handleSave(print: boolean) {
    setError("");
    const problem = validateDraft({ customerName, pickupDate, items, total, deposit });
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const id = await saveOrder({
        id: initial?.id ?? null,
        branchId,
        customerId,
        customerName,
        customerPhone,
        pickupDate,
        pickupTime,
        notes,
        total,
        deposit,
        items
      });
      onSaved(id, print, pickupDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el pedido.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="form-box order-form">
      <div className="panel-title" style={{ marginBottom: 8 }}>
        <h2>{initial ? "Editar pedido" : "Nuevo pedido"}</h2>
        <span className="muted" style={{ fontSize: 13 }}>Es solo informativo: no mueve la caja ni descuenta stock.</span>
      </div>

      <div className="form-grid">
        <label className="span-2">
          Cliente
          <input
            list="order-customers"
            placeholder="Nombre del cliente"
            value={customerName}
            maxLength={80}
            autoFocus
            onChange={(e) => pickCustomer(e.target.value)}
          />
        </label>
        <label>
          Teléfono
          <input type="tel" inputMode="tel" placeholder="Opcional" value={customerPhone} maxLength={40} onChange={(e) => setCustomerPhone(e.target.value)} />
        </label>
        <label>
          Día de retiro
          <input type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} />
        </label>
        <label>
          Hora
          <input type="time" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
        </label>
      </div>
      <datalist id="order-customers">
        {customers.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>

      <p className="order-form-label">Productos</p>
      <input
        style={{ width: "100%", marginBottom: 8 }}
        placeholder="Buscar producto (nombre o código)"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown.length > 0) {
            e.preventDefault();
            addProduct(shown[0]);
          }
        }}
      />
      <div className="order-product-picks">
        {shown.map((p) => (
          <button key={p.id} type="button" className="secondary" onClick={() => addProduct(p)}>
            {p.name}
          </button>
        ))}
        {shown.length === 0 && <span className="muted">No hay productos con ese nombre.</span>}
      </div>

      {items.length > 0 && (
        <ul className="order-lines">
          {items.map((item) => (
            <li key={item.productId}>
              <span className="order-line-name">{item.productName}</span>
              <span className="order-stepper">
                <button type="button" className="secondary" aria-label="Menos" onClick={() => step(item.productId, -1)}>−</button>
                <input
                  type="text"
                  inputMode="decimal"
                  value={String(item.quantity).replace(".", ",")}
                  onChange={(e) => setQuantityText(item.productId, e.target.value)}
                  onFocus={(e) => e.target.select()}
                />
                <button type="button" className="secondary" aria-label="Más" onClick={() => step(item.productId, 1)}>+</button>
                <span className="muted">{item.unit === "kg" ? "kg" : item.unit === "box" ? "caja" : "u"}</span>
              </span>
              <input
                style={{ width: "100%", minWidth: 0 }}
                placeholder="Detalle (ej. en tiras)"
                maxLength={120}
                value={item.notes}
                onChange={(e) => setItems((current) => current.map((i) => (i.productId === item.productId ? { ...i, notes: e.target.value } : i)))}
              />
              <button type="button" className="secondary" onClick={() => setItems((current) => current.filter((i) => i.productId !== item.productId))}>Quitar</button>
            </li>
          ))}
        </ul>
      )}

      <div className="form-grid" style={{ marginTop: 12 }}>
        <label className="span-2">
          Nota
          <input placeholder="Opcional" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label>
          Total $
          <input type="text" inputMode="decimal" placeholder="Opcional" value={totalInput} onChange={(e) => setTotalInput(e.target.value)} />
        </label>
        <label>
          Seña $
          <input type="text" inputMode="decimal" placeholder="0" value={depositInput} onChange={(e) => setDepositInput(e.target.value)} />
        </label>
        <div className="form-field">
          Saldo a cobrar
          <strong className="order-due">{due !== null ? formatMoney(due) : "—"}</strong>
        </div>
      </div>

      {items.length > 0 && (
        <p className="muted" style={{ fontSize: 13, margin: "10px 0 0" }}>{items.filter((i) => i.quantity > 0).map(itemLabel).join(" · ")}</p>
      )}
      {error && <div className="message warning" style={{ marginTop: 10 }}>{error}</div>}

      <div className="form-actions">
        <button disabled={busy} onClick={() => void handleSave(false)}>{busy ? "Guardando…" : "Guardar pedido"}</button>
        <button className="secondary" disabled={busy} onClick={() => void handleSave(true)}>Guardar e imprimir</button>
        <span className="spacer" />
        <button className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
      </div>
    </section>
  );
}
