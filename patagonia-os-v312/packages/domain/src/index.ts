export type Money = number;
export type Quantity = number;

export type PaymentMethod =
  | "cash"
  | "qr"
  | "debit"
  | "credit"
  | "bank_province"
  | "transfer"
  | "digital";

export interface Product {
  id: string;
  code: string;
  name: string;
  unit: "kg" | "unit" | "box";
  cost: Money;
  priceRetail: Money;
  stock: Quantity;
  minStock: Quantity;
  active?: boolean;
  categoryId?: string;
  /** Presentación que usa el stock de otro producto (el principal). `stock` ya viene en unidades de esta presentación. */
  stockSourceId?: string;
  /** Cuánto del principal descuenta cada unidad de esta presentación (1 si es la misma unidad). */
  stockFactor?: number;
  /** Precio en cada lista de precios activa (ej. Mayorista), por id de lista. manual = escrito a mano (no sale de la regla). */
  listPrices?: Record<string, { price: Money; manual: boolean }>;
}

export interface CartItem {
  product: Product;
  quantity: Quantity;
  unitPrice: Money;
}

export type CashSessionStatus = "open" | "closed";

export interface CashSession {
  id: string;
  branchId: string;
  status: CashSessionStatus;
  openingAmount: Money;
  openedAt: string;
  openedBy: string;
  closingCounted?: Money;
  difference?: Money;
  closedAt?: string;
}

export function lineTotal(item: CartItem): Money {
  return roundMoney(item.quantity * item.unitPrice);
}

export function cartTotal(items: CartItem[]): Money {
  return roundMoney(items.reduce((sum, item) => sum + lineTotal(item), 0));
}

export function estimatedProfit(items: CartItem[]): Money {
  return roundMoney(
    items.reduce(
      (sum, item) => sum + item.quantity * (item.unitPrice - item.product.cost),
      0
    )
  );
}

export function assertSellable(item: CartItem): void {
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
    throw new Error("La cantidad debe ser mayor que cero.");
  }
  if (item.quantity > item.product.stock) {
    throw new Error(`Stock insuficiente de ${item.product.name}.`);
  }
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function marginPercent(cost: Money, priceRetail: Money): number {
  if (cost <= 0) return 0;
  return roundMoney(((priceRetail - cost) / cost) * 100);
}

export function priceFromMargin(cost: Money, marginPct: number): Money {
  return roundMoney(cost * (1 + marginPct / 100));
}

/** Un insumo de una receta: `quantity` es lo que queda NETO en el producto
 * terminado (en la unidad del insumo), `wastePct` la merma al limpiarlo
 * (grasa, nervio, hueso). Lo que hay que comprar es el bruto:
 * neto / (1 - merma). `unitCost` es el costo actual del insumo por su unidad. */
export interface RecipeIngredientInput {
  quantity: Quantity;
  wastePct: number;
  unitCost: Money;
}

export interface RecipeCostInput {
  ingredients: RecipeIngredientInput[];
  /** Packaging, mano de obra, gas, etc. por lote. */
  extraCost: Money;
  /** Cuánto producto terminado sale del lote (en la unidad del producto terminado). */
  yieldQty: Quantity;
  /** Margen objetivo sobre el costo, igual que en Stock: precio = costo × (1 + margen/100). */
  marginPct?: number | null;
}

export interface RecipeLineCost {
  /** Cantidad bruta a comprar para que queden `quantity` netos. */
  grossQuantity: Quantity;
  cost: Money;
}

export interface RecipeCostResult {
  lines: RecipeLineCost[];
  batchCost: Money;
  /** Costo por kg o por unidad del producto terminado. 0 si el rinde no es válido. */
  unitCost: Money;
  suggestedPrice: Money | null;
}

/** Costeo de una receta (escandallo). El mismo cálculo, con el mismo redondeo,
 * lo hace en SQL `apply_recipe_to_product` (migración 097): si se toca uno hay
 * que tocar el otro y sus pruebas. */
export function recipeCost(input: RecipeCostInput): RecipeCostResult {
  const lines = input.ingredients.map((ingredient) => {
    const keep = 1 - ingredient.wastePct / 100;
    const grossQuantity = keep > 0 ? ingredient.quantity / keep : 0;
    return { grossQuantity, cost: roundMoney(grossQuantity * ingredient.unitCost) };
  });
  const batchCost = roundMoney(lines.reduce((sum, line) => sum + line.cost, 0) + input.extraCost);
  const unitCost = input.yieldQty > 0 ? roundMoney(batchCost / input.yieldQty) : 0;
  const hasMargin = input.marginPct !== null && input.marginPct !== undefined && Number.isFinite(input.marginPct);
  return {
    lines,
    batchCost,
    unitCost,
    suggestedPrice: hasMargin && unitCost > 0 ? priceFromMargin(unitCost, input.marginPct as number) : null
  };
}

export interface Supplier {
  id: string;
  name: string;
  category: string;
  phone?: string;
  notes?: string;
  active: boolean;
}

export interface PurchaseItem {
  id: string;
  purchaseId: string;
  productId?: string;
  description?: string;
  quantity: Quantity;
  unit: "kg" | "unit";
  unitPrice: Money;
  lineTotal: Money;
  /** Línea "para despostar" (migración 126): animal y kilos totales; crea la res en Despiece. */
  carcassAnimalType?: string;
  carcassWeight?: Quantity;
}

export interface Purchase {
  id: string;
  branchId: string;
  supplierId: string;
  purchaseDate: string;
  invoiceNumber?: string;
  total: Money;
  status: "active" | "voided";
  createdBy: string;
  createdAt: string;
}

export interface SupplierPayment {
  id: string;
  branchId: string;
  supplierId: string;
  paymentDate: string;
  amount: Money;
  paymentMethod: PaymentMethod;
  accountId?: string;
  accountName?: string;
  notes?: string;
  createdAt: string;
}

export interface PurchaseLineInput {
  quantity: Quantity;
  unitPrice: Money;
}

export function purchaseLineTotal(line: PurchaseLineInput): Money {
  return roundMoney(line.quantity * line.unitPrice);
}

export function purchaseTotal(lines: PurchaseLineInput[]): Money {
  return roundMoney(lines.reduce((sum, line) => sum + purchaseLineTotal(line), 0));
}

export interface TreasuryAccount {
  id: string;
  name: string;
  paymentMethod?: PaymentMethod;
  initialBalance: Money;
  active: boolean;
  /** Sucursal dueña de la cuenta, o undefined si es compartida por todas
   * (el comportamiento de siempre). */
  branchId?: string;
  branchName?: string;
  /** Caja fuerte (migración 117): recibe los retiros de Mostrador y no se
   * ofrece como medio de cobro. */
  isSafe?: boolean;
  /** Cuenta de cheques (migración 150): "Cheques en cartera" o "Cheques
   * propios a pagar". Solo se mueve desde Cheques; no se ofrece para cobrar
   * ni pagar. */
  chequeRole?: "portfolio" | "payable";
}

export type TreasuryMovementDirection = "in" | "out";

export type ShiftPeriod = "morning" | "afternoon";

export interface ShiftRegister {
  id: string;
  branchId: string;
  shiftDate: string;
  shift: ShiftPeriod;
  openingCash: Money;
  closingCountedCash?: Money;
  createdAt: string;
  updatedAt: string;
}

export interface ShiftSale {
  id: string;
  shiftId: string;
  accountId: string;
  amount: Money;
}

export type ShiftOutflowType = "vale_mercaderia" | "vale_adelanto" | "pago_proveedor" | "gasto";

export interface ShiftOutflow {
  id: string;
  shiftId: string;
  accountId: string;
  type: ShiftOutflowType;
  amount: Money;
  detail: string;
  employeeId?: string;
  supplierId?: string;
  createdAt: string;
}

export type SalaryPeriod = "daily" | "weekly" | "biweekly" | "monthly";

export interface Employee {
  id: string;
  branchId: string;
  fullName: string;
  baseSalary: Money;
  salaryPeriod: SalaryPeriod;
  recurringBonusAmount: Money;
  recurringBonusReason?: string;
  active: boolean;
}

export type PayrollAdjustmentType = "bonus" | "deduction";

export interface PayrollAdjustment {
  id: string;
  employeeId: string;
  adjustmentDate: string;
  type: PayrollAdjustmentType;
  amount: Money;
  reason: string;
  /** true si ya lo consumió una liquidación cerrada (payroll_liquidation_id). */
  liquidated?: boolean;
}

export interface PayrollLiquidationPayment {
  id: string;
  accountId: string;
  accountName?: string;
  amount: Money;
}

export interface PayrollLiquidation {
  id: string;
  employeeId: string;
  branchId: string;
  periodStart: string;
  periodEnd: string;
  baseSalary: Money;
  adjustmentsTotal: Money;
  vouchersTotal: Money;
  netAmount: Money;
  accountId?: string;
  accountName?: string;
  payments: PayrollLiquidationPayment[];
  createdAt: string;
}

export interface FixedCost {
  id: string;
  branchId: string;
  name: string;
  monthlyAmount: Money;
  active: boolean;
}

export const STOCK_COUNT_CATEGORIES = ["achura", "cerdo", "pollo", "vacuno", "embutidos", "preparados", "proveeduria", "varios"] as const;

export interface StockCount {
  id: string;
  branchId: string;
  countDate: string;
  category: string;
  value: Money;
}

export interface CarcassBatch {
  id: string;
  branchId: string;
  batchDate: string;
  animalType: string;
  supplierId?: string;
  totalWeight: Quantity;
  totalCost: Money;
  notes?: string;
  createdAt: string;
  /** La res vino de una línea de Compras (migración 126): peso, costo, fecha y proveedor se corrigen en Compras. */
  purchaseItemId?: string;
  /** De dónde salió el reparto automático (migración 163): promedio de reses pesadas de verdad o cortes de siempre. */
  fillSource?: CarcassFillSource;
}

export type CarcassFillSource = { kind: "learned"; batches: number; min: number; max: number } | { kind: "template" };

export interface CarcassCut {
  id: string;
  batchId: string;
  cutName: string;
  productId?: string;
  weight: Quantity;
  unitPrice: Money;
  lineTotal: Money;
  /** Lo repartió el sistema y nadie lo corrigió (false = cargado a mano o pesado de verdad). */
  fromTemplate?: boolean;
}

export function carcassCutLineTotal(cut: { weight: Quantity; unitPrice: Money }): Money {
  return roundMoney(cut.weight * cut.unitPrice);
}

export interface CarcassCostLine {
  productId: string;
  /** Kilos de este producto que salieron de la res. */
  weight: Quantity;
  /** Kilos × precio de venta (lo que vale lo que salió). */
  value: Money;
  /** Parte de la compra de la res que le toca. */
  cost: Money;
  /** Costo real por kilo (redondeado a centavos). */
  costPerKg: Money;
}

/** Cómo se reparte lo que se pagó por una res entre sus cortes. */
export type CarcassCostMethod = "average" | "value";

/**
 * Costo real de cada corte de una res. Dos formas (la misma cuenta, con el mismo redondeo, la hace la base en
 * carcass_apply_costs_core, migración 170: cambiar las dos juntas):
 * - "value" (la de siempre): según lo que VALE cada corte (kilos × precio de venta), así el lomo carga más costo por
 *   kilo que la falda y todos dejan el mismo margen.
 * - "average" (empresas con 'costo_parejo', pedido de La cosa es con carne 2026-10-29: "si compro la media, el kilo
 *   de cada corte me sale lo mismo"): lo que se pagó ÷ los kilos de los cortes que se venden (con precio). Todos
 *   cuestan lo mismo por kilo; el hueso y la grasa sin precio son merma (costo 0). Cada corte deja su propio margen.
 * Si ningún corte tiene precio, en las dos se reparte por kilos. Los cortes sin producto también participan del
 * reparto (se llevan su parte), pero solo se devuelven los que tienen producto, agrupados por producto.
 */
export function allocateCarcassCost(
  totalCost: Money,
  cuts: { productId?: string | null; weight: Quantity; unitPrice: Money }[],
  method: CarcassCostMethod = "value"
): CarcassCostLine[] {
  const totalValue = cuts.reduce((s, c) => s + c.weight * c.unitPrice, 0);
  const totalWeight = cuts.reduce((s, c) => s + c.weight, 0);
  const sellableWeight = cuts.reduce((s, c) => (c.unitPrice > 0 ? s + c.weight : s), 0);
  const byProduct = new Map<string, { weight: number; value: number; cost: number }>();
  for (const c of cuts) {
    if (!c.productId) continue;
    const value = c.weight * c.unitPrice;
    let share: number;
    if (totalValue <= 0) share = totalWeight > 0 ? (totalCost * c.weight) / totalWeight : 0;
    else if (method === "value") share = (totalCost * value) / totalValue;
    else share = c.unitPrice > 0 && sellableWeight > 0 ? (totalCost * c.weight) / sellableWeight : 0;
    const prev = byProduct.get(c.productId) ?? { weight: 0, value: 0, cost: 0 };
    byProduct.set(c.productId, { weight: prev.weight + c.weight, value: prev.value + value, cost: prev.cost + share });
  }
  return [...byProduct].map(([productId, x]) => ({
    productId,
    weight: Math.round(x.weight * 1000) / 1000,
    value: roundMoney(x.value),
    cost: roundMoney(x.cost),
    costPerKg: x.weight > 0 ? roundMoney(x.cost / x.weight) : 0
  }));
}

export interface CarcassCutTemplate {
  id: string;
  animalType: string;
  cutName: string;
  yieldPercent: number;
  productId?: string;
  sortOrder: number;
}

/** Peso esperado de un corte según su % de rendimiento sobre el peso total de la res. */
export function carcassTemplateCutWeight(totalWeight: Quantity, yieldPercent: number): Quantity {
  return Math.round(totalWeight * (yieldPercent / 100) * 1000) / 1000;
}

export interface Creditor {
  id: string;
  branchId: string;
  name: string;
  phone?: string;
  notes?: string;
  paymentTermDays?: number;
  active: boolean;
}

export interface CreditorDebt {
  id: string;
  creditorId: string;
  debtDate: string;
  amount: Money;
  reason: string;
  accountId?: string;
  accountName?: string;
  createdAt: string;
}

export interface CreditorPayment {
  id: string;
  creditorId: string;
  paymentDate: string;
  amount: Money;
  accountId: string;
  accountName?: string;
  notes?: string;
  createdAt: string;
}

export interface CreditorBalance {
  creditorId: string;
  totalDebt: Money;
  totalPaid: Money;
  balance: Money;
  lastActivityDate?: string;
}

export interface Customer {
  id: string;
  branchId: string;
  /** Número de cliente correlativo por empresa (109_customer_number.sql). */
  number?: number;
  name: string;
  phone?: string;
  notes?: string;
  locality?: string;
  province?: string;
  paymentTermDays?: number;
  active: boolean;
  /** Lista de precios del cliente (ej. Mayorista, migración 166); sin lista = minorista. */
  priceListId?: string;
}

export interface CustomerCharge {
  id: string;
  customerId: string;
  chargeDate: string;
  amount: Money;
  reason: string;
  createdAt: string;
}

export interface CustomerPayment {
  id: string;
  customerId: string;
  paymentDate: string;
  amount: Money;
  accountId: string;
  accountName?: string;
  notes?: string;
  createdAt: string;
}

export interface CustomerBalance {
  customerId: string;
  totalCharged: Money;
  totalPaid: Money;
  balance: Money;
  lastActivityDate?: string;
}

/**
 * Un deudor/acreedor está atrasado si tiene saldo pendiente y pasó su
 * propio plazo (paymentTermDays, distinto para cada uno) desde su último
 * pago -- o, si nunca pagó nada, desde su deuda/entrega más vieja
 * (lastActivityDate cubre ambos casos, calculado en la vista SQL). Sin
 * plazo cargado, no se puede saber si está atrasado: no se marca.
 */
export function isOverdueDebt(
  info: { balance: Money; paymentTermDays?: number; lastActivityDate?: string },
  todayIso: string
): boolean {
  if (info.balance <= 0) return false;
  if (!info.paymentTermDays || !info.lastActivityDate) return false;
  const days = Math.floor(
    (new Date(`${todayIso}T00:00:00`).getTime() - new Date(`${info.lastActivityDate}T00:00:00`).getTime()) / 86400000
  );
  return days > info.paymentTermDays;
}

export interface ProfitabilityPeriod {
  id: string;
  branchId: string;
  periodStart: string;
  periodEnd: string;
  salesTotal: Money;
  purchasesTotal: Money;
  fixedCostsTotal: Money;
  stockStart: Money;
  stockEnd: Money;
  grossProfit: Money;
  createdAt: string;
}
