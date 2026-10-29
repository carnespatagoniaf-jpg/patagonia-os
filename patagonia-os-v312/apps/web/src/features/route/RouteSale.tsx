import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { parseAmount } from "../../lib/money";
import { quantityNumber } from "../sale/quantity";
import { getCompanyName } from "../products/products-service";
import { createCustomer } from "../customers/customers-service";
import { authorizeInvoices, getFiscalSettings, getInvoice, invoicePrintFrom, requestChargeInvoice, type FiscalSettings } from "../invoicing/invoicing-service";
import { emptyInvoiceDraft, invoiceDraftError, type InvoiceDraft, type InvoicePrint } from "../invoicing/invoicing-view";
import { InvoiceRequestFields } from "../invoicing/InvoiceRequestFields";
import { InvoicePaperFooter, InvoicePaperHeader } from "../invoicing/InvoicePaper";
import {
  addLine,
  routePrice,
  customerBalanceWithQueue,
  formatQty,
  lineTotal,
  money,
  paidTotal,
  saleError,
  searchCustomers,
  searchProducts,
  stockAfterQueue,
  ticketTotal,
  whatsappNumber,
  whatsappText,
  type QueuedRouteSale,
  type RouteCustomer,
  type RouteLine,
  type RouteProduct
} from "./route-logic";
import {
  listBranchesSplit,
  loadRouteCatalog,
  readCachedCatalog,
  readQueue,
  sendRouteSale,
  writeCachedCatalog,
  writeQueue,
  type RouteCatalog,
  type Vehicle
} from "./route-service";

const VEHICLES_KEY = "patagonia-route-vehicles";
const CHOSEN_KEY = "patagonia-route-vehicle";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sin lugar
  }
}

/** Error de red (sin señal) vs. error de la base (la venta tiene un problema de verdad). */
function isNetworkError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err);
  return !navigator.onLine || /fetch|network|Load failed|timeout|ERR_/i.test(text);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String((err as { message?: string })?.message ?? err);
}

export function RouteSale() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "owner" || profile?.role === "admin";
  const [vehicles, setVehicles] = useState<Vehicle[]>(() => readJson<Vehicle[]>(VEHICLES_KEY, []));
  const [vehicleId, setVehicleId] = useState<string>(() => readJson<string>(CHOSEN_KEY, ""));
  const [catalog, setCatalog] = useState<RouteCatalog | null>(null);
  const [queue, setQueue] = useState<QueuedRouteSale[]>(() => readQueue());
  const [online, setOnline] = useState(navigator.onLine);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [fiscal, setFiscal] = useState<FiscalSettings | null>(null);

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [newCustomer, setNewCustomer] = useState<{ name: string; phone: string } | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [picked, setPicked] = useState<RouteProduct | null>(null);
  const [qtyText, setQtyText] = useState("");
  const [lines, setLines] = useState<RouteLine[]>([]);
  const [payAccountId, setPayAccountId] = useState("");
  const [payText, setPayText] = useState("");
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceDraft>(emptyInvoiceDraft());
  const [receipt, setReceipt] = useState<QueuedRouteSale | null>(null);
  const [receiptInvoice, setReceiptInvoice] = useState<InvoicePrint | null>(null);
  const syncing = useRef(false);
  const qtyRef = useRef<HTMLInputElement>(null);

  // Camión: el vendedor tiene el suyo fijo (su usuario está asignado a ese camión); dueño/admin elige.
  const myVehicle = vehicles.find((v) => v.id === profile?.branch_id);
  const activeVehicleId = isAdmin ? vehicleId || vehicles[0]?.id || "" : myVehicle?.id ?? "";
  const vehicle = vehicles.find((v) => v.id === activeVehicleId);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    void listBranchesSplit()
      .then(({ vehicles: list }) => {
        setVehicles(list);
        saveJson(VEHICLES_KEY, list);
      })
      .catch(() => {});
    void getCompanyName(profile?.company_id).then((n) => n && setCompanyName(n));
    void getFiscalSettings().then(setFiscal).catch(() => setFiscal(null));
  }, [profile?.company_id]);

  const refreshCatalog = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const fresh = await loadRouteCatalog(id);
      writeCachedCatalog(fresh);
      setCatalog(fresh);
    } catch (err) {
      if (!isNetworkError(err)) setMessage(`No se pudo actualizar la lista: ${errorText(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeVehicleId) return;
    setCatalog(readCachedCatalog(activeVehicleId));
    void refreshCatalog(activeVehicleId);
  }, [activeVehicleId, refreshCatalog]);

  useEffect(() => {
    if (!catalog || payAccountId) return;
    const cash = catalog.accounts.find((a) => a.own && a.isCash) ?? catalog.accounts[0];
    if (cash) setPayAccountId(cash.id);
  }, [catalog, payAccountId]);

  const persist = useCallback((next: QueuedRouteSale[]) => {
    setQueue(next);
    if (!writeQueue(next)) setMessage("El teléfono no tiene lugar para guardar la venta. Subí las pendientes con señal.");
  }, []);

  /** Sube las ventas pendientes, una por una, en orden. Una venta ya subida nunca se duplica (route_sale es idempotente). */
  const syncQueue = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      let current = readQueue();
      for (const sale of current.filter((s) => s.status === "pending")) {
        let updated: QueuedRouteSale;
        try {
          const r = await sendRouteSale(sale);
          updated = { ...sale, status: "sent", chargeId: r.chargeId, balanceAfter: r.balance, error: undefined };
        } catch (err) {
          if (isNetworkError(err)) break;
          updated = { ...sale, status: "error", error: errorText(err) };
        }
        if (updated.status === "sent" && updated.invoice && !updated.invoiceId && updated.chargeId) {
          try {
            const draft: InvoiceDraft = { wanted: true, customerCondition: updated.invoice.customerCondition as InvoiceDraft["customerCondition"], doc: updated.invoice.doc, name: updated.invoice.name };
            const { invoiceId, letter } = await requestChargeInvoice(updated.chargeId, draft);
            const outcome = (await authorizeInvoices(invoiceId)).find((o) => o.id === invoiceId);
            updated.invoiceId = invoiceId;
            updated.invoiceMessage =
              outcome?.status === "autorizada" ? `Factura ${letter} autorizada (CAE ${outcome.cae}).`
              : outcome?.status === "rechazada" ? `ARCA rechazó la factura: ${outcome.message ?? "sin motivo"}. Se puede volver a pedir desde Clientes.`
              : `Factura ${letter} pedida; ARCA todavía no respondió. Se reintenta desde Facturas.`;
          } catch (err) {
            updated.invoiceMessage = `La venta subió pero la factura no: ${errorText(err)}. Pedila desde Clientes.`;
          }
        }
        current = readQueue().map((s) => (s.clientId === sale.clientId ? updated : s));
        persist(current);
        setReceipt((r) => (r?.clientId === sale.clientId ? updated : r));
      }
    } finally {
      syncing.current = false;
    }
  }, [persist]);

  useEffect(() => {
    void syncQueue();
    const timer = setInterval(() => void syncQueue(), 30_000);
    window.addEventListener("online", syncQueue);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", syncQueue);
    };
  }, [syncQueue]);

  // Factura impresa: cuando la venta del comprobante ya tiene factura autorizada.
  useEffect(() => {
    setReceiptInvoice(null);
    if (!receipt?.invoiceId || !fiscal) return;
    void getInvoice(receipt.invoiceId).then((inv) => setReceiptInvoice(inv ? invoicePrintFrom(inv, fiscal) : null)).catch(() => {});
  }, [receipt?.invoiceId, fiscal]);

  const myQueue = useMemo(() => queue.filter((s) => s.vehicleId === activeVehicleId), [queue, activeVehicleId]);
  const products = useMemo(() => stockAfterQueue(catalog?.products ?? [], myQueue), [catalog, myQueue]);
  const customers = catalog?.customers ?? [];
  const customer = customers.find((c) => c.id === customerId) ?? null;

  // Cambió el cliente: el ticket toma su precio (mayorista si tiene lista), igual que la base al subirlo.
  useEffect(() => {
    setLines((current) =>
      current.map((l) => {
        const product = products.find((p) => p.id === l.productId);
        return product ? { ...l, price: routePrice(product, customer) } : l;
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id, customer?.priceListId]);
  const total = ticketTotal(lines);
  const payAmount = payText.trim() === "" ? 0 : parseAmount(payText);
  const payAccount = catalog?.accounts.find((a) => a.id === payAccountId);
  const payments = payAmount > 0 && payAccount ? [{ accountId: payAccount.id, accountName: payAccount.name, amount: payAmount }] : [];
  const pending = myQueue.filter((s) => s.status === "pending").length;
  const failed = myQueue.filter((s) => s.status === "error");
  const invoiceOn = Boolean(fiscal?.enabled);

  function pickProduct(p: RouteProduct) {
    setPicked(p);
    setProductSearch("");
    setQtyText("");
    setTimeout(() => qtyRef.current?.focus(), 0);
  }

  function confirmQuantity() {
    if (!picked) return;
    const qty = quantityNumber(qtyText);
    if (!(qty > 0)) {
      setMessage("Poné la cantidad.");
      return;
    }
    setLines((l) => addLine(l, { ...picked, price: routePrice(picked, customer) }, qty));
    setPicked(null);
    setQtyText("");
    setMessage("");
  }

  async function handleNewCustomer() {
    if (!newCustomer || !newCustomer.name.trim() || !activeVehicleId) return;
    if (!online) {
      setMessage("Para dar de alta un cliente nuevo hace falta señal.");
      return;
    }
    setLoading(true);
    try {
      const { id } = await createCustomer({ branchId: activeVehicleId, name: newCustomer.name.trim(), phone: newCustomer.phone.trim() || undefined });
      const created: RouteCustomer = { id, name: newCustomer.name.trim(), phone: newCustomer.phone.trim() || undefined, balance: 0 };
      const next = catalog ? { ...catalog, customers: [...catalog.customers, created].sort((a, b) => a.name.localeCompare(b.name)) } : catalog;
      if (next) {
        setCatalog(next);
        writeCachedCatalog(next);
      }
      setCustomerId(id);
      setNewCustomer(null);
      setCustomerSearch("");
    } catch (err) {
      setMessage(`No se pudo crear el cliente: ${errorText(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function handleSave() {
    const error = saleError(lines, payments, customerId) ?? (payText.trim() !== "" && !(payAmount >= 0) ? "Revisá lo que cobraste." : null)
      ?? (invoiceOn && fiscal ? invoiceDraftError(fiscal.taxCondition, invoiceDraft, total) : null);
    if (error || !customer || !activeVehicleId) {
      setMessage(error ?? "Elegí el cliente.");
      return;
    }
    const sale: QueuedRouteSale = {
      clientId: crypto.randomUUID(),
      vehicleId: activeVehicleId,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      lines,
      payments,
      total,
      createdAt: new Date().toISOString(),
      balanceBefore: customerBalanceWithQueue(customer, myQueue),
      status: "pending",
      invoice: invoiceOn && invoiceDraft.wanted ? { customerCondition: invoiceDraft.customerCondition, doc: invoiceDraft.doc, name: invoiceDraft.name } : undefined
    };
    persist([...readQueue(), sale]);
    setReceipt(sale);
    setLines([]);
    setCustomerId(null);
    setPayText("");
    setInvoiceDraft(emptyInvoiceDraft());
    setMessage("");
    void syncQueue();
  }

  function discardFailed(clientId: string) {
    if (!window.confirm("¿Borrar esta venta del teléfono? No se subió, así que no queda registrada en ningún lado.")) return;
    persist(readQueue().filter((s) => s.clientId !== clientId));
  }

  function retryFailed(clientId: string) {
    persist(readQueue().map((s) => (s.clientId === clientId ? { ...s, status: "pending", error: undefined } : s)));
    void syncQueue();
  }

  if (!profile) return null;

  if (vehicles.length === 0 || (!isAdmin && !myVehicle)) {
    return (
      <section className="panel">
        <h2>Venta en ruta</h2>
        <p className="muted">
          {vehicles.length === 0
            ? "Todavía no hay camiones. El dueño o un administrador los crea en Camiones."
            : "Tu usuario no está asignado a ningún camión. Pedile al dueño que en Usuarios te ponga en tu camión como sucursal."}
        </p>
      </section>
    );
  }

  if (receipt) {
    const saved = queue.find((s) => s.clientId === receipt.clientId) ?? receipt;
    const paid = paidTotal(saved.payments);
    const owed = saved.total - paid;
    const balance = saved.balanceAfter ?? saved.balanceBefore + owed;
    const wa = whatsappNumber(saved.customerPhone);
    const text = whatsappText(saved, companyName || "Patagonia OS");
    return (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div className="no-print" style={{ marginBottom: 10 }}>
          <StatusLine sale={saved} />
        </div>
        <section className="panel print-area">
          {receiptInvoice ? <InvoicePaperHeader invoice={receiptInvoice} /> : (
            <>
              <h2 style={{ marginBottom: 2 }}>{companyName}</h2>
              <p className="muted" style={{ margin: 0 }}>Remito de entrega · documento no válido como factura</p>
            </>
          )}
          <p style={{ margin: "8px 0" }}>
            <b>{saved.customerName}</b> · {new Date(saved.createdAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false })}
          </p>
          <table className="data-table">
            <tbody>
              {saved.lines.map((l) => (
                <tr key={l.productId}>
                  <td>{l.name}<div className="muted" style={{ fontSize: 12 }}>{formatQty(l.quantity, l.unit)} x {money(l.price)}</div></td>
                  <td className="num">{money(lineTotal(l))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "grid", gap: 4, marginTop: 10, fontSize: 16 }}>
            <strong>Total {money(saved.total)}</strong>
            {saved.payments.filter((p) => p.amount > 0).map((p) => <span key={p.accountId}>Pagó {money(p.amount)} ({p.accountName})</span>)}
            <span>{owed > 0.5 ? `Queda a cuenta ${money(owed)}` : "Pagado"}</span>
            <span className="muted">Saldo de su cuenta: {money(balance)}</span>
          </div>
          {receiptInvoice && <InvoicePaperFooter invoice={receiptInvoice} />}
        </section>
        {saved.invoiceMessage && <p className="no-print">{saved.invoiceMessage}</p>}
        <div className="no-print" style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <a className="button-like" href={`https://wa.me/${wa ?? ""}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" style={bigButton("#25d366")}>
            Mandar por WhatsApp{wa ? "" : " (elegís el contacto)"}
          </a>
          <button className="secondary" style={bigButton()} onClick={() => window.print()}>Imprimir / guardar PDF</button>
          <button style={bigButton("#1f6feb")} onClick={() => setReceipt(null)}>Nueva venta</button>
        </div>
      </div>
    );
  }

  const productMatches = searchProducts(products, productSearch);
  const customerMatches = searchCustomers(customers, customerSearch, 8);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", display: "grid", gap: 12 }}>
      <section className="panel" style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          {isAdmin && vehicles.length > 1 ? (
            <select value={activeVehicleId} onChange={(e) => { setVehicleId(e.target.value); saveJson(CHOSEN_KEY, e.target.value); setLines([]); }} style={{ fontSize: 16 }}>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          ) : (
            <strong style={{ fontSize: 17 }}>{vehicle?.name}</strong>
          )}
          <span style={{ fontSize: 13, color: online ? "#1a7f37" : "#b35900" }}>{online ? "Con señal" : "Sin señal: las ventas se guardan en el teléfono"}</span>
        </div>
        {pending > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "#b35900" }}>{pending} venta(s) sin subir</span>
            <button className="secondary" onClick={() => void syncQueue()} disabled={!online}>Subir ahora</button>
          </div>
        )}
        {failed.map((s) => (
          <div key={s.clientId} style={{ background: "#fff1f0", padding: 8, borderRadius: 6, fontSize: 13 }}>
            <b>No se pudo subir</b> la venta a {s.customerName} ({money(s.total)}): {s.error}
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button className="secondary" onClick={() => retryFailed(s.clientId)}>Reintentar</button>
              <button className="link-button" onClick={() => discardFailed(s.clientId)}>Borrar</button>
            </div>
          </div>
        ))}
        {!catalog && <p className="muted">{loading ? "Bajando productos y clientes…" : "Hace falta señal una vez para bajar productos y clientes."}</p>}
        {catalog && (
          <span className="muted" style={{ fontSize: 12 }}>
            Lista del {new Date(catalog.loadedAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false })}{" "}
            <button className="link-button" disabled={loading || !online} onClick={() => void refreshCatalog(activeVehicleId)}>{loading ? "actualizando…" : "actualizar"}</button>
          </span>
        )}
      </section>

      {catalog && (
        <>
          <section className="panel" style={{ display: "grid", gap: 8 }}>
            <h3 style={{ margin: 0 }}>1. Cliente</h3>
            {customer ? (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <b style={{ fontSize: 17 }}>{customer.name}</b>
                  <div className="muted">Debe {money(customerBalanceWithQueue(customer, myQueue))}{customer.priceListName ? ` · Precio ${customer.priceListName}` : ""}</div>
                </div>
                <button className="secondary" onClick={() => setCustomerId(null)}>Cambiar</button>
              </div>
            ) : newCustomer ? (
              <div style={{ display: "grid", gap: 6 }}>
                <input placeholder="Nombre del cliente o negocio" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} style={{ fontSize: 16 }} />
                <input placeholder="Teléfono (WhatsApp)" inputMode="tel" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} style={{ fontSize: 16 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button disabled={loading || !newCustomer.name.trim()} onClick={() => void handleNewCustomer()}>Crear cliente</button>
                  <button className="secondary" onClick={() => setNewCustomer(null)}>Cancelar</button>
                </div>
              </div>
            ) : (
              <>
                <input placeholder="Buscá el cliente por nombre, número o teléfono" value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} style={{ fontSize: 16, padding: 12 }} />
                <div style={{ display: "grid", gap: 4 }}>
                  {customerMatches.map((c) => (
                    <button key={c.id} type="button" className="secondary" style={{ display: "flex", justifyContent: "space-between", padding: 12, textAlign: "left" }} onClick={() => { setCustomerId(c.id); setCustomerSearch(""); }}>
                      <span>{c.number !== undefined ? `${c.number} · ` : ""}{c.name}</span>
                      <span className="muted">{money(customerBalanceWithQueue(c, myQueue))}</span>
                    </button>
                  ))}
                </div>
                <button className="link-button" style={{ justifySelf: "start" }} onClick={() => setNewCustomer({ name: customerSearch, phone: "" })}>+ Cliente nuevo</button>
              </>
            )}
          </section>

          <section className="panel" style={{ display: "grid", gap: 8 }}>
            <h3 style={{ margin: 0 }}>2. Productos</h3>
            {picked ? (
              <div style={{ display: "grid", gap: 6 }}>
                <b>{picked.name} · {money(routePrice(picked, customer))}{picked.unit === "kg" ? "/kg" : ""}</b>
                <span className="muted" style={{ fontSize: 13 }}>En el camión: {formatQty(picked.stock, picked.unit)}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    ref={qtyRef}
                    type="text"
                    inputMode="decimal"
                    placeholder={picked.unit === "kg" ? "Kilos (ej. 1,250)" : "Unidades"}
                    value={qtyText}
                    onChange={(e) => setQtyText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && confirmQuantity()}
                    style={{ fontSize: 20, flex: 1, minWidth: 0, padding: 10 }}
                  />
                  <button onClick={confirmQuantity} style={{ flexShrink: 0 }}>Agregar</button>
                </div>
                {quantityNumber(qtyText) > 0 && <span>= {money(quantityNumber(qtyText) * routePrice(picked, customer))}</span>}
                <button className="link-button" style={{ justifySelf: "start" }} onClick={() => setPicked(null)}>Cancelar</button>
              </div>
            ) : (
              <>
                <input placeholder="Buscá el producto por nombre o código" value={productSearch} onChange={(e) => setProductSearch(e.target.value)} style={{ fontSize: 16, padding: 12 }} />
                <div style={{ display: "grid", gap: 4 }}>
                  {productMatches.map((p) => (
                    <button key={p.id} type="button" className="secondary" style={{ display: "flex", justifyContent: "space-between", padding: 12, textAlign: "left" }} onClick={() => pickProduct(p)}>
                      <span>{p.name}<span className="muted" style={{ fontSize: 12 }}> · quedan {formatQty(p.stock, p.unit)}</span></span>
                      <strong>{money(routePrice(p, customer))}</strong>
                    </button>
                  ))}
                </div>
              </>
            )}
            {lines.length > 0 && (
              <table className="data-table">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.productId}>
                      <td>{l.name}<div className="muted" style={{ fontSize: 12 }}>{formatQty(l.quantity, l.unit)} x {money(l.price)}</div></td>
                      <td className="num">{money(lineTotal(l))}</td>
                      <td style={{ width: 30 }}>
                        <button className="link-button" aria-label={`Sacar ${l.name}`} onClick={() => setLines(lines.filter((x) => x !== l))}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <strong style={{ fontSize: 20 }}>Total {money(total)}</strong>
          </section>

          <section className="panel" style={{ display: "grid", gap: 8 }}>
            <h3 style={{ margin: 0 }}>3. Cobro</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className={payAmount === total && total > 0 ? "" : "secondary"} onClick={() => setPayText(String(total))} disabled={total === 0}>Pagó todo</button>
              <button className={payText.trim() === "" || payAmount === 0 ? "" : "secondary"} onClick={() => setPayText("")}>Todo a cuenta</button>
            </div>
            <label className="muted" style={{ fontSize: 13 }}>Cuánto pagó ahora (si paga una parte, el resto queda a cuenta)</label>
            <input type="text" inputMode="decimal" placeholder="$ 0" value={payText} onChange={(e) => setPayText(e.target.value)} style={{ fontSize: 18, padding: 10 }} />
            {payAmount > 0 && (
              <select value={payAccountId} onChange={(e) => setPayAccountId(e.target.value)} style={{ fontSize: 16 }}>
                {catalog.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            {total > 0 && <span>{total - paidTotal(payments) > 0.5 ? `Queda a cuenta: ${money(total - paidTotal(payments))}` : "Queda pagado"}</span>}
            {invoiceOn && fiscal && (
              <InvoiceRequestFields issuer={fiscal.taxCondition} draft={invoiceDraft} total={total} onChange={setInvoiceDraft} />
            )}
            {invoiceOn && invoiceDraft.wanted && !online && <span className="muted" style={{ fontSize: 13 }}>Sin señal: la factura se pide sola cuando vuelva la señal.</span>}
          </section>

          {message && <p style={{ color: "#b42318", margin: 0 }}>{message}</p>}
          <button style={bigButton("#1f6feb")} onClick={handleSave} disabled={lines.length === 0}>Guardar venta</button>

          {myQueue.length > 0 && (
            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Ventas de este teléfono</h3>
              <table className="data-table">
                <tbody>
                  {[...myQueue].reverse().slice(0, 15).map((s) => (
                    <tr key={s.clientId} onClick={() => setReceipt(s)} style={{ cursor: "pointer" }}>
                      <td>{s.customerName}<div className="muted" style={{ fontSize: 12 }}>{new Date(s.createdAt).toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false })}</div></td>
                      <td className="num">{money(s.total)}</td>
                      <td style={{ fontSize: 12 }}>{s.status === "sent" ? "Subida" : s.status === "pending" ? "Sin subir" : "Error"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function StatusLine({ sale }: { sale: QueuedRouteSale }) {
  if (sale.status === "sent") return <span style={{ color: "#1a7f37" }}>Venta guardada en el sistema.</span>;
  if (sale.status === "error") return <span style={{ color: "#b42318" }}>No se pudo subir: {sale.error}</span>;
  return <span style={{ color: "#b35900" }}>Guardada en el teléfono. Se sube sola cuando haya señal.</span>;
}

function bigButton(background?: string): React.CSSProperties {
  return {
    fontSize: 18,
    padding: "14px 16px",
    textAlign: "center",
    textDecoration: "none",
    borderRadius: 8,
    ...(background ? { background, color: "#fff", border: "none" } : {})
  };
}
