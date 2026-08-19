import { useEffect, useState } from "react";
import type { CartItem, Product } from "@patagonia/domain";
import { assertSellable, cartTotal, lineTotal } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { listProductsForBranch } from "../inventory/inventory-service";
import { useTreasury } from "../shifts/useTreasury";
import { createPosSale } from "./sale-service";
import { formatMoney } from "../shifts/format";
import { parseAmount } from "../../lib/money";

const UNIT_LABELS: Record<Product["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

interface ReceiptState {
  items: CartItem[];
  total: number;
  soldAt: string;
  accountName: string;
  amountTendered: number | null;
  change: number | null;
}

export function Sale() {
  const { branchId } = useActiveBranch();
  const { accounts } = useTreasury();

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<CartItem[]>([]);
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);

  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [amountTendered, setAmountTendered] = useState("");

  const total = cartTotal(cart);
  const selectedAccount = accounts.find((a) => a.id === paymentAccountId) ?? null;
  const isCash = selectedAccount?.paymentMethod === "cash";
  const tenderedValue = amountTendered ? parseAmount(amountTendered) : null;
  const change = isCash && tenderedValue !== null && Number.isFinite(tenderedValue) ? tenderedValue - total : null;

  async function reload() {
    if (!isSupabaseConfigured || !branchId) return;
    setLoading(true);
    try {
      setProducts(await listProductsForBranch(branchId));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  function addToCart(product: Product) {
    setMessage("");
    const raw = quantities[product.id] ?? "";
    const quantity = Number(raw);
    try {
      const alreadyInCart = cart.find((c) => c.product.id === product.id)?.quantity ?? 0;
      const item: CartItem = { product, quantity: alreadyInCart + quantity, unitPrice: product.priceRetail };
      assertSellable(item);
      setCart((current) => {
        const rest = current.filter((c) => c.product.id !== product.id);
        return [...rest, item];
      });
      setQuantities({ ...quantities, [product.id]: "" });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo agregar el producto.");
    }
  }

  function removeFromCart(productId: string) {
    setCart((current) => current.filter((c) => c.product.id !== productId));
  }

  async function checkout() {
    if (cart.length === 0) return;
    if (!paymentAccountId) {
      setMessage("Elegí de qué cuenta cobrás.");
      return;
    }
    if (isCash && (tenderedValue === null || !Number.isFinite(tenderedValue) || tenderedValue < total)) {
      setMessage("Ingresá cuánto te dio el cliente (tiene que alcanzar para el total).");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      if (!isSupabaseConfigured) {
        setReceipt({
          items: cart,
          total: cartTotal(cart),
          soldAt: new Date().toISOString(),
          accountName: selectedAccount?.name ?? "-",
          amountTendered: tenderedValue,
          change
        });
        setCart([]);
        setPaymentAccountId("");
        setAmountTendered("");
        setMessage("Venta registrada (modo demo, no se descuenta stock real).");
        return;
      }
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      const result = await createPosSale({
        branchId,
        items: cart.map((c) => ({ productId: c.product.id, quantity: c.quantity })),
        accountId: paymentAccountId
      });
      setReceipt({
        items: cart,
        total: result.total,
        soldAt: new Date().toISOString(),
        accountName: selectedAccount?.name ?? "-",
        amountTendered: tenderedValue,
        change
      });
      setCart([]);
      setPaymentAccountId("");
      setAmountTendered("");
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar la venta.");
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
          <p className="muted">Elegí productos y cantidad — el stock se descuenta solo al cobrar.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Productos</h2>
            <span>{loading ? "Cargando…" : `${products.length} productos`}</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Precio</th>
                <th className="num">Stock</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {products.filter((p) => p.active ?? true).map((product) => (
                <tr key={product.id}>
                  <td>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></td>
                  <td className="num">{formatMoney(product.priceRetail)}</td>
                  <td className="num">{product.stock}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={quantities[product.id] ?? ""}
                      onChange={(e) => setQuantities({ ...quantities, [product.id]: e.target.value })}
                      style={{ width: 70 }}
                    />{" "}
                    <button className="secondary" onClick={() => addToCart(product)}>Agregar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {products.length === 0 && !loading && <p className="muted">No hay productos cargados.</p>}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Carrito</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Cant.</th>
                <th className="num">Subtotal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cart.map((item) => (
                <tr key={item.product.id}>
                  <td>{item.product.name}</td>
                  <td className="num">{item.quantity} {UNIT_LABELS[item.product.unit]}</td>
                  <td className="num">{formatMoney(lineTotal(item))}</td>
                  <td><button className="secondary" onClick={() => removeFromCart(item.product.id)}>Quitar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {cart.length === 0 && <p className="muted">Todavía no agregaste productos.</p>}

          <div style={{ marginTop: 16 }}>
            <strong style={{ fontSize: 20 }}>Total {formatMoney(total)}</strong>
          </div>

          {cart.length > 0 && (
            <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 12 }}>
              <select value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
                <option value="">¿Con qué te paga?</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              {isCash && (
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Recibiste ($)"
                  value={amountTendered}
                  onChange={(e) => setAmountTendered(e.target.value)}
                  style={{ width: 130 }}
                />
              )}
              {isCash && change !== null && (
                <strong className={change < 0 ? "num-negative" : "num-positive"}>
                  Vuelto {formatMoney(Math.max(change, 0))}
                </strong>
              )}
            </div>
          )}

          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
            <button className="charge-button" disabled={busy || cart.length === 0} onClick={checkout}>
              {busy ? "Cobrando…" : "Cobrar"}
            </button>
          </div>
        </section>
      </div>

      {receipt && (
        <section className="panel print-area" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Último comprobante</h2>
            <button className="secondary no-print" onClick={handlePrint}>Imprimir</button>
          </div>
          <p className="muted print-only-header">{new Date(receipt.soldAt).toLocaleString("es-AR")} · {receipt.accountName}</p>
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
              {receipt.items.map((item) => (
                <tr key={item.product.id}>
                  <td>{item.product.name}</td>
                  <td className="num">{item.quantity} {UNIT_LABELS[item.product.unit]}</td>
                  <td className="num">{formatMoney(item.unitPrice)}</td>
                  <td className="num">{formatMoney(lineTotal(item))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ textAlign: "right", marginTop: 10 }}><strong>Total {formatMoney(receipt.total)}</strong></p>
          {receipt.amountTendered !== null && (
            <p style={{ textAlign: "right" }} className="muted">
              Recibido {formatMoney(receipt.amountTendered)} · Vuelto {formatMoney(Math.max(receipt.change ?? 0, 0))}
            </p>
          )}
        </section>
      )}
    </>
  );
}
