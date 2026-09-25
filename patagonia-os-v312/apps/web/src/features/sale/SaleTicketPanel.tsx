import { Fragment } from "react";
import type { Product, TreasuryAccount } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import { UNIT_LABELS } from "./sale-model";
import type { SaleTicket } from "./useSaleTicket";

// Columna izquierda de Mostrador: buscador, ticket armándose, descuentos,
// medios de pago y barra de cobro. Es solo vista: el estado vive en
// useSaleTicket y el cobro (checkout) en Sale.tsx.

export function SaleTicketPanel({ ticket, accounts, busy, onCheckout }: {
  ticket: SaleTicket;
  accounts: TreasuryAccount[];
  busy: boolean;
  onCheckout: () => void;
}) {
  const {
    search,
    setSearch,
    setHighlightedIndex,
    showProductTable,
    setShowProductTable,
    cart,
    itemDiscounts,
    setItemDiscounts,
    saleDiscount,
    setSaleDiscount,
    saleDiscountMode,
    setSaleDiscountMode,
    saleSurcharge,
    setSaleSurcharge,
    saleSurchargeMode,
    setSaleSurchargeMode,
    showDiscountForm,
    setShowDiscountForm,
    showManualForm,
    setShowManualForm,
    manualDesc,
    setManualDesc,
    manualPrice,
    setManualPrice,
    manualQty,
    setManualQty,
    manualUnit,
    setManualUnit,
    payments,
    confirmCharge,
    cashTendered,
    setCashTendered,
    searchInputRef,
    accountSelectRefs,
    amountInputRefs,
    cashTenderedRef,
    chargeButtonRef,
    grossTotal,
    itemDiscountTotal,
    saleSurchargeValue,
    saleDiscountValue,
    total,
    hasAdjustment,
    isSplit,
    singleAccount,
    isSingleCash,
    change,
    splitRemaining,
    filteredProducts,
    productGroups,
    searchMatches,
    activeMatchIndex,
    addProductFromSearch,
    addManualItem,
    handleSearchKeyDown,
    removeFromCart,
    updateCartQuantity,
    clearTicket,
    addPaymentRow,
    removePaymentRow,
    updatePaymentRow,
    selectSinglePaymentAccount
  } = ticket;

  return (
  <section className="panel">
    <div className="pos-search-wrap">
      <input
        ref={searchInputRef}
        type="text"
        className="pos-search"
        placeholder="Escaneá o escribí el nombre / código del producto…"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setHighlightedIndex(-1); }}
        onKeyDown={handleSearchKeyDown}
        autoFocus
      />
      {searchMatches.length > 0 && (
        <div className="pos-dropdown">
          {searchMatches.map((product, idx) => (
            <button
              key={product.id}
              type="button"
              className={`pos-dropdown-item${idx === activeMatchIndex ? " active" : ""}`}
              onMouseEnter={() => setHighlightedIndex(idx)}
              onClick={() => void addProductFromSearch(product)}
            >
              <span>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></span>
              <strong>{formatMoney(product.priceRetail)}</strong>
            </button>
          ))}
        </div>
      )}
    </div>

    <div className="pos-toolbar">
      <button className={`pos-toolbar-btn${showManualForm ? " active" : ""}`} onClick={() => setShowManualForm((v) => !v)}>
        + Vender algo sin código
      </button>
      <button className={`pos-toolbar-btn${showProductTable ? " active" : ""}`} onClick={() => setShowProductTable((v) => !v)}>
        {showProductTable ? "Ocultar tabla de productos" : "Ver tabla de productos"}
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

    {showProductTable && (
      <div className="pos-browse-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Producto</th>
              <th className="num">Precio</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {productGroups.map(([categoryLabel, categoryProducts]) => (
              <Fragment key={categoryLabel}>
                <tr>
                  <td colSpan={4} className="pos-category-row">{categoryLabel}</td>
                </tr>
                {categoryProducts.map((product) => (
                  <tr key={product.id}>
                    <td>{product.code}</td>
                    <td>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></td>
                    <td className="num">{formatMoney(product.priceRetail)}</td>
                    <td><button className="secondary" onClick={() => void addProductFromSearch(product)}>+ Agregar</button></td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {filteredProducts.length === 0 && (
              <tr><td colSpan={4} className="muted">No hay productos que coincidan.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    )}

    {cart.length === 0 ? (
      <div className="pos-cart-empty">Escaneá o buscá un producto para empezar el ticket.</div>
    ) : (
      <div className="pos-cart">
        {cart.map((line) => (
          <div className="pos-cart-row" key={line.key}>
            <div className="name">
              {line.name}
              <small>
                {line.kind === "manual" ? "Manual · " : ""}{formatMoney(line.unitPrice)}{line.unit === "kg" ? " /kg" : ` /${UNIT_LABELS[line.unit]}`}
              </small>
            </div>
            <input
              type="number"
              className="pos-qty-input"
              min={line.unit === "kg" ? "0.001" : "1"}
              step={line.unit === "kg" ? "0.001" : "1"}
              value={line.quantity}
              onChange={(e) => updateCartQuantity(line.key, e.target.value)}
            />
            <input
              type="text"
              inputMode="decimal"
              className="pos-discount-input"
              placeholder="Desc. $"
              value={itemDiscounts[line.key] ?? ""}
              onChange={(e) => setItemDiscounts({ ...itemDiscounts, [line.key]: e.target.value })}
            />
            <span className="pos-line-total">
              {formatMoney(line.quantity * line.unitPrice - (parseAmount(itemDiscounts[line.key] || "0") || 0))}
            </span>
            <button className="pos-remove-btn" onClick={() => removeFromCart(line.key)} aria-label="Quitar" title="Quitar">×</button>
          </div>
        ))}
      </div>
    )}

    {cart.length > 0 && (
      <>
        <div className="pos-toolbar" style={{ marginTop: 10 }}>
          <button
            className={`pos-toolbar-btn${showDiscountForm || hasAdjustment ? " active" : ""}`}
            onClick={() => setShowDiscountForm((v) => !v)}
          >
            {hasAdjustment ? "Descuento / recargo" : "+ Descuento o recargo"}
          </button>
          <button className="pos-toolbar-btn" onClick={clearTicket}>Cancelar ticket</button>
        </div>

        {showDiscountForm && (
          <div className="pos-adjust-card">
            <div className="pos-adjust-row">
              <label>Descuento</label>
              <input
                type="text"
                inputMode="decimal"
                placeholder={saleDiscountMode === "final" ? "Precio final" : "0"}
                value={saleDiscount}
                onChange={(e) => setSaleDiscount(e.target.value)}
              />
              <select value={saleDiscountMode} onChange={(e) => setSaleDiscountMode(e.target.value as "amount" | "percent" | "final")}>
                <option value="amount">$ off</option>
                <option value="percent">% off</option>
                <option value="final">Dejarlo en $</option>
              </select>
              <label>Recargo</label>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={saleSurcharge}
                onChange={(e) => setSaleSurcharge(e.target.value)}
              />
              <select value={saleSurchargeMode} onChange={(e) => setSaleSurchargeMode(e.target.value as "amount" | "percent")}>
                <option value="amount">$</option>
                <option value="percent">%</option>
              </select>
            </div>
          </div>
        )}
        {hasAdjustment && (
          <p className="pos-subtotal-line" style={{ marginTop: showDiscountForm ? 0 : 10 }}>
            Subtotal {formatMoney(grossTotal)}
            {(itemDiscountTotal > 0 || saleDiscountValue > 0) && ` · Descuentos -${formatMoney(itemDiscountTotal + saleDiscountValue)}`}
            {saleSurchargeValue > 0 && ` · Recargo +${formatMoney(saleSurchargeValue)}`}
          </p>
        )}

        <div className="pos-payment-card">
          <p className="pos-section-label">Forma de pago</p>
          {!isSplit && (
            <div className="pos-payment-methods">
              {accounts.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  className={`pos-payment-method-btn${payments[0]?.accountId === a.id ? " active" : ""}`}
                  onClick={() => selectSinglePaymentAccount(a)}
                >
                  {i < 9 && <kbd>F{i + 1}</kbd>}
                  <span>{a.name}</span>
                </button>
              ))}
            </div>
          )}
          {!isSplit && singleAccount && singleAccount.paymentMethod !== "cash" && (
            <div className="pos-payment-row">
              <input
                type="text"
                placeholder="Cupón / N° de operación"
                value={payments[0].reference}
                onChange={(e) => updatePaymentRow(0, "reference", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  chargeButtonRef.current?.focus();
                }}
              />
            </div>
          )}
          {isSplit && payments.map((p, i) => (
            <div className="pos-payment-row" key={i}>
              <select
                ref={(el) => { accountSelectRefs.current[i] = el; }}
                value={p.accountId}
                onChange={(e) => {
                  updatePaymentRow(i, "accountId", e.target.value);
                  requestAnimationFrame(() => amountInputRefs.current[i]?.focus());
                }}
              >
                <option value="">¿Con qué te paga?</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              {isSplit && (
                <input
                  ref={(el) => { amountInputRefs.current[i] = el; }}
                  type="text"
                  inputMode="decimal"
                  placeholder="Monto"
                  value={p.amount}
                  onChange={(e) => updatePaymentRow(i, "amount", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const isLast = i === payments.length - 1;
                    if (!isLast) accountSelectRefs.current[i + 1]?.focus();
                    else if (Math.abs(splitRemaining) <= 0.5) chargeButtonRef.current?.focus();
                    else addPaymentRow();
                  }}
                />
              )}
              {accounts.find((a) => a.id === p.accountId)?.paymentMethod !== "cash" && p.accountId && (
                <input
                  type="text"
                  placeholder="Cupón / N° de operación"
                  value={p.reference}
                  onChange={(e) => updatePaymentRow(i, "reference", e.target.value)}
                />
              )}
              {isSplit && payments.length > 1 && (
                <button className="pos-toolbar-btn" onClick={() => removePaymentRow(i)}>Quitar medio</button>
              )}
            </div>
          ))}

          {isSingleCash && (
            <div className="pos-payment-row">
              <input
                ref={cashTenderedRef}
                type="text"
                inputMode="decimal"
                placeholder="Recibiste ($)"
                value={cashTendered}
                onChange={(e) => setCashTendered(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  chargeButtonRef.current?.focus();
                }}
              />
              {change !== null && (
                <strong className={`pos-change ${change < 0 ? "num-negative" : "num-positive"}`}>
                  Vuelto {formatMoney(Math.max(change, 0))}
                </strong>
              )}
            </div>
          )}

          <div style={{ marginTop: 10, textAlign: "right" }}>
            {!isSplit ? (
              <button className="pos-toolbar-btn" onClick={addPaymentRow}>+ Dividir el pago en más de un medio</button>
            ) : (
              <>
                <p className="muted" style={{ margin: "0 0 8px" }}>
                  {Math.abs(splitRemaining) <= 0.5 ? "Los medios de pago cubren el total." : `Falta pagar ${formatMoney(splitRemaining)}`}
                </p>
                <button className="pos-toolbar-btn" onClick={addPaymentRow}>+ Agregar otro medio de pago</button>
              </>
            )}
          </div>
        </div>

        {confirmCharge && (
          <p className="pos-confirm-banner">
            Vas a cobrar {formatMoney(total)} con{" "}
            {isSplit
              ? payments.map((p) => accounts.find((a) => a.id === p.accountId)?.name ?? "-").join(" + ")
              : singleAccount?.name}
            . Apretá Enter de nuevo (o tocá el botón) para confirmar -- Esc para elegir otro medio.
          </p>
        )}
        <div className="pos-total-bar">
          <div>
            <p className="pos-total-label">Total a cobrar</p>
            <strong className="pos-total-value">{formatMoney(total)}</strong>
          </div>
          <button
            ref={chargeButtonRef}
            className={`charge-button pos-charge-btn${confirmCharge ? " confirming" : ""}`}
            disabled={busy}
            onClick={onCheckout}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onCheckout(); } }}
          >
            {busy ? "Cobrando…" : confirmCharge ? (<>Confirmar cobro <kbd>Enter</kbd></>) : (<>Cobrar <kbd>Enter</kbd></>)}
          </button>
        </div>
      </>
    )}
  </section>
  );
}
