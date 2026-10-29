/**
 * Venta en ruta (migración 161): cuentas del ticket, cola sin señal y
 * texto para mandar por WhatsApp. Sin Supabase: se testea solo.
 */

export interface RouteProduct {
  id: string;
  code: string;
  name: string;
  unit: "kg" | "unit";
  price: number;
  stock: number;
  /** Precio en cada lista de precios activa (Mayorista…), por id de lista. */
  listPrices?: Record<string, number>;
}

export interface RouteCustomer {
  id: string;
  name: string;
  number?: number;
  phone?: string;
  balance: number;
  /** Lista de precios del cliente (migración 167): compra a esos precios. */
  priceListId?: string;
  priceListName?: string;
}

export interface RouteLine {
  productId: string;
  name: string;
  unit: "kg" | "unit";
  quantity: number;
  price: number;
}

export interface RoutePayment {
  accountId: string;
  accountName: string;
  amount: number;
}

/** Venta guardada en el teléfono hasta que se sube (clientId = idempotencia en route_sale). */
export interface QueuedRouteSale {
  clientId: string;
  vehicleId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  lines: RouteLine[];
  payments: RoutePayment[];
  total: number;
  createdAt: string;
  /** Saldo del cliente antes de esta venta, como lo conocía el teléfono. */
  balanceBefore: number;
  status: "pending" | "sent" | "error";
  error?: string;
  chargeId?: string;
  /** Saldo real que devolvió la base al subirla. */
  balanceAfter?: number;
  /** Factura pedida en el momento: se pide a ARCA apenas la venta sube. */
  invoice?: { customerCondition: string; doc: string; name: string };
  invoiceId?: string;
  invoiceMessage?: string;
}

export function lineTotal(line: Pick<RouteLine, "quantity" | "price">): number {
  return line.quantity * line.price;
}

/** Mismo redondeo que create_customer_charge_with_items: suma sin redondear y redondea al peso. */
export function ticketTotal(lines: Pick<RouteLine, "quantity" | "price">[]): number {
  return Math.round(lines.reduce((sum, l) => sum + lineTotal(l), 0));
}

export function paidTotal(payments: Pick<RoutePayment, "amount">[]): number {
  return Math.round(payments.reduce((sum, p) => sum + (p.amount > 0 ? p.amount : 0), 0) * 100) / 100;
}

/** Error para mostrar antes de guardar, o null si la venta está lista. */
export function saleError(lines: RouteLine[], payments: RoutePayment[], customerId: string | null): string | null {
  if (!customerId) return "Elegí el cliente.";
  if (lines.length === 0) return "Agregá al menos un producto.";
  if (lines.some((l) => !(l.quantity > 0))) return "Hay un producto sin cantidad.";
  if (payments.some((p) => p.amount < 0 || !Number.isFinite(p.amount))) return "Revisá lo que cobraste.";
  if (paidTotal(payments) > ticketTotal(lines) + 0.5) return "Cobraste más que el total de la venta.";
  return null;
}

/** Precio para este cliente: el de su lista si tiene una (igual que la base al subir la venta). */
export function routePrice(product: Pick<RouteProduct, "price" | "listPrices">, customer: Pick<RouteCustomer, "priceListId"> | null | undefined): number {
  const listId = customer?.priceListId;
  return listId ? product.listPrices?.[listId] ?? product.price : product.price;
}

/** Suma una línea al ticket; el mismo producto se junta en un solo renglón. */
export function addLine(lines: RouteLine[], product: RouteProduct, quantity: number): RouteLine[] {
  if (!(quantity > 0)) return lines;
  const found = lines.find((l) => l.productId === product.id);
  if (found) {
    return lines.map((l) => (l === found ? { ...l, quantity: Math.round((l.quantity + quantity) * 1000) / 1000 } : l));
  }
  return [...lines, { productId: product.id, name: product.name, unit: product.unit, quantity, price: product.price }];
}

export function searchProducts(products: RouteProduct[], text: string, limit = 12): RouteProduct[] {
  const q = normalize(text);
  if (!q) return [];
  const exactCode = products.filter((p) => p.code === text.trim());
  const rest = products.filter((p) => !exactCode.includes(p) && (normalize(p.name).includes(q) || p.code.startsWith(text.trim())));
  return [...exactCode, ...rest].slice(0, limit);
}

export function searchCustomers(customers: RouteCustomer[], text: string, limit = 12): RouteCustomer[] {
  const q = normalize(text);
  if (!q) return customers.slice(0, limit);
  return customers.filter((c) => normalize(c.name).includes(q) || String(c.number ?? "") === text.trim() || (c.phone ?? "").includes(text.trim())).slice(0, limit);
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Stock del camión que queda en el teléfono contando las ventas que todavía no subieron. */
export function stockAfterQueue(products: RouteProduct[], queue: QueuedRouteSale[]): RouteProduct[] {
  const sold = new Map<string, number>();
  for (const sale of queue) {
    if (sale.status === "sent") continue;
    for (const l of sale.lines) sold.set(l.productId, (sold.get(l.productId) ?? 0) + l.quantity);
  }
  if (sold.size === 0) return products;
  return products.map((p) => (sold.has(p.id) ? { ...p, stock: Math.round((p.stock - (sold.get(p.id) ?? 0)) * 1000) / 1000 } : p));
}

/** Saldo del cliente que ve el vendedor: el último conocido + lo que quedó debiendo en ventas sin subir. */
export function customerBalanceWithQueue(customer: RouteCustomer, queue: QueuedRouteSale[]): number {
  return queue
    .filter((s) => s.customerId === customer.id && s.status !== "sent")
    .reduce((bal, s) => bal + s.total - paidTotal(s.payments), customer.balance);
}

export function formatQty(quantity: number, unit: "kg" | "unit"): string {
  if (unit === "kg") return `${quantity.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;
  return `${quantity.toLocaleString("es-AR", { maximumFractionDigits: 3 })} u.`;
}

export function money(value: number): string {
  return value.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}

/** Comprobante en texto para WhatsApp (el cliente no lo escanea: es para que quede constancia). */
export function whatsappText(sale: QueuedRouteSale, companyName: string): string {
  const paid = paidTotal(sale.payments);
  const owed = sale.total - paid;
  const balance = sale.balanceAfter ?? sale.balanceBefore + owed;
  const date = new Date(sale.createdAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short", hour12: false });
  const rows = sale.lines.map((l) => `• ${l.name}: ${formatQty(l.quantity, l.unit)} x ${money(l.price)} = ${money(lineTotal(l))}`);
  const pays = sale.payments.filter((p) => p.amount > 0).map((p) => `Pagó ${money(p.amount)} (${p.accountName})`);
  return [
    `*${companyName}*`,
    `Remito de entrega · ${date}`,
    `Cliente: ${sale.customerName}`,
    "",
    ...rows,
    "",
    `*Total: ${money(sale.total)}*`,
    ...pays,
    owed > 0.5 ? `Queda a cuenta: ${money(owed)}` : "Pagado.",
    `Saldo de su cuenta: ${money(balance)}`,
    "",
    "Documento no válido como factura."
  ].join("\n");
}

/** Número de WhatsApp argentino para wa.me (549 + área + número, sin 0 ni 15). Null si no parece un número. */
export function whatsappNumber(phone: string | undefined): string | null {
  let d = (phone ?? "").replace(/\D/g, "");
  if (d.length < 8) return null;
  if (d.startsWith("549")) return d;
  if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  // 11 15 1234 5678 → 11 1234 5678
  const m = d.match(/^(\d{2,4})15(\d{6,8})$/);
  if (m && (m[1] + m[2]).length === 10) d = m[1] + m[2];
  return d.length === 10 ? `549${d}` : null;
}
