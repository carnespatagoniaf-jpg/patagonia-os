import { useMemo, useState } from "react";
import { Minus, Plus, Search, Trash2 } from "lucide-react";
import {
  assertSellable,
  cartTotal,
  estimatedProfit,
  type CartItem,
  type PaymentMethod,
  type Product
} from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { useCashSession } from "../cash/useCashSession";

export function Pos() {
  const [products, setProducts] = useState<Product[]>(demoProducts);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [search, setSearch] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [message, setMessage] = useState("");
  const {
    session: cashSession,
    loading: cashLoading,
    error: cashError,
    lastClose,
    open: openCash,
    close: closeCash,
    registerCashSale
  } = useCashSession();
  const [openingAmount, setOpeningAmount] = useState("");
  const [cashMessage, setCashMessage] = useState("");
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [closingAmount, setClosingAmount] = useState("");
  const cashSessionOpen = cashSession?.status === "open";

  const filtered = products.filter((p) =>
    `${p.name} ${p.code}`.toLowerCase().includes(search.toLowerCase())
  );
  const total = useMemo(() => cartTotal(cart), [cart]);
  const profit = useMemo(() => estimatedProfit(cart), [cart]);

  function addProduct(product: Product) {
    const quantity = product.unit === "kg" ? 1 : 1;
    const item: CartItem = { product, quantity, unitPrice: product.priceRetail };
    try {
      assertSellable(item);
      setCart((current) => [...current, item]);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo agregar.");
    }
  }

  function updateQuantity(index: number, quantity: number) {
    setCart((current) => {
      const next = [...current];
      const item = { ...next[index], quantity };
      assertSellable(item);
      next[index] = item;
      return next;
    });
  }

  async function handleOpenCash() {
    try {
      const amount = Number(openingAmount);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error("Ingresá un monto inicial válido.");
      }
      await openCash(amount);
      setOpeningAmount("");
      setCashMessage("");
    } catch (error) {
      setCashMessage(error instanceof Error ? error.message : "No se pudo abrir la caja.");
    }
  }

  async function handleCloseCash() {
    try {
      const amount = Number(closingAmount);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error("Ingresá un monto contado válido.");
      }
      await closeCash(amount);
      setClosingAmount("");
      setShowCloseForm(false);
      setCashMessage("");
    } catch (error) {
      setCashMessage(error instanceof Error ? error.message : "No se pudo cerrar la caja.");
    }
  }

  function charge() {
    try {
      if (!cashSessionOpen) throw new Error("Abrí la caja antes de cobrar.");
      cart.forEach(assertSellable);
      if (!cart.length) throw new Error("Agregá al menos un producto.");

      setProducts((current) =>
        current.map((product) => {
          const sold = cart
            .filter((item) => item.product.id === product.id)
            .reduce((sum, item) => sum + item.quantity, 0);
          return { ...product, stock: product.stock - sold };
        })
      );

      if (paymentMethod === "cash") registerCashSale(total);

      setMessage(`Venta registrada en modo demo por ${formatMoney(total)} · ${paymentMethod}`);
      setCart([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo cobrar.");
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">PUNTO DE VENTA</p>
          <h1>Nueva venta</h1>
          <p className="muted">Modo demostración local. La versión cloud usará transacciones SQL.</p>
        </div>
      </header>

      {!cashLoading && cashSession && cashSession.status === "open" && (
        <section className="panel cash-status">
          <div className="cash-status-row">
            <div>
              <strong>Caja abierta</strong>
              <p className="muted">Apertura: {formatMoney(cashSession.openingAmount)}</p>
            </div>
            {!showCloseForm && (
              <button onClick={() => setShowCloseForm(true)}>Cerrar caja</button>
            )}
            {showCloseForm && (
              <div className="cash-close-form">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Monto contado"
                  value={closingAmount}
                  onChange={(event) => setClosingAmount(event.target.value)}
                />
                <button onClick={handleCloseCash}>Confirmar cierre</button>
                <button className="secondary" onClick={() => setShowCloseForm(false)}>Cancelar</button>
              </div>
            )}
          </div>
          {cashMessage && <div className="message">{cashMessage}</div>}
        </section>
      )}

      {!cashLoading && !cashSessionOpen && (
        <section className="panel cash-banner">
          {lastClose && (
            <div className={`message${lastClose.difference < 0 ? " warning" : ""}`}>
              Caja cerrada · Contado {formatMoney(lastClose.closingCounted)} · Esperado{" "}
              {formatMoney(lastClose.expectedCash)} · Diferencia {formatMoney(lastClose.difference)}
            </div>
          )}
          <div className="cash-banner-row">
            <div>
              <strong>No hay caja abierta para esta sucursal.</strong>
              <p className="muted">Ingresá el monto inicial para abrir la caja y empezar a vender.</p>
            </div>
            {cashError ? (
              <p className="message">{cashError}</p>
            ) : (
              <div className="cash-banner-form">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Monto inicial"
                  value={openingAmount}
                  onChange={(event) => setOpeningAmount(event.target.value)}
                />
                <button onClick={handleOpenCash}>Abrir caja</button>
              </div>
            )}
          </div>
          {cashMessage && <div className="message">{cashMessage}</div>}
        </section>
      )}

      <div className={cashSessionOpen ? "pos-layout" : "pos-layout pos-layout-disabled"}>
        <section className="panel products-panel">
          <div className="search-box">
            <Search size={19} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar producto o código…"
            />
          </div>

          <div className="product-grid">
            {filtered.map((product) => (
              <button className="product-card" key={product.id} onClick={() => addProduct(product)}>
                <span>{product.code}</span>
                <strong>{product.name}</strong>
                <small>Stock: {product.stock} {product.unit}</small>
                <b>{formatMoney(product.priceRetail)}</b>
              </button>
            ))}
          </div>
        </section>

        <section className="panel cart-panel">
          <div className="panel-title">
            <h2>Carrito</h2>
            <span>{cart.length} productos</span>
          </div>

          <div className="cart-list">
            {cart.length === 0 && <p className="muted">Todavía no agregaste productos.</p>}
            {cart.map((item, index) => (
              <div className="cart-row" key={`${item.product.id}-${index}`}>
                <div>
                  <strong>{item.product.name}</strong>
                  <span>{formatMoney(item.unitPrice)} por {item.product.unit}</span>
                </div>
                <div className="qty-control">
                  <button onClick={() => updateQuantity(index, Math.max(0.001, item.quantity - 1))}><Minus size={15} /></button>
                  <input
                    value={item.quantity}
                    type="number"
                    min="0.001"
                    step="0.001"
                    onChange={(event) => {
                      try {
                        updateQuantity(index, Number(event.target.value));
                        setMessage("");
                      } catch (error) {
                        setMessage(error instanceof Error ? error.message : "Cantidad inválida.");
                      }
                    }}
                  />
                  <button onClick={() => updateQuantity(index, item.quantity + 1)}><Plus size={15} /></button>
                  <button className="danger" onClick={() => setCart((current) => current.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
                </div>
              </div>
            ))}
          </div>

          <div className="checkout">
            <div className="totals">
              <span>Ganancia estimada <b>{formatMoney(profit)}</b></span>
              <strong>Total <b>{formatMoney(total)}</b></strong>
            </div>

            <label>
              Medio de pago
              <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}>
                <option value="cash">Efectivo</option>
                <option value="qr">Mercado Pago QR</option>
                <option value="debit">Débito</option>
                <option value="credit">Crédito</option>
                <option value="bank_province">Banco Provincia</option>
                <option value="transfer">Transferencia</option>
              </select>
            </label>

            <button className="charge-button" onClick={charge}>Cobrar {formatMoney(total)}</button>
            {message && <div className="message">{message}</div>}
          </div>
        </section>
      </div>
    </>
  );
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(value);
}
