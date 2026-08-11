export type Money = number;
export type Quantity = number;

export type PaymentMethod =
  | "cash"
  | "qr"
  | "debit"
  | "credit"
  | "bank_province"
  | "transfer";

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
}

export interface Purchase {
  id: string;
  branchId: string;
  supplierId: string;
  purchaseDate: string;
  invoiceNumber?: string;
  total: Money;
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

export type SalaryPeriod = "weekly" | "monthly";

export interface Employee {
  id: string;
  branchId: string;
  fullName: string;
  baseSalary: Money;
  salaryPeriod: SalaryPeriod;
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
  createdAt: string;
}

export interface FixedCost {
  id: string;
  branchId: string;
  name: string;
  monthlyAmount: Money;
  active: boolean;
}

export const STOCK_COUNT_CATEGORIES = ["achura", "cerdo", "pollo", "vacuno", "embutidos", "preparados", "varios"] as const;

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
}

export interface CarcassCut {
  id: string;
  batchId: string;
  cutName: string;
  productId?: string;
  weight: Quantity;
  unitPrice: Money;
  lineTotal: Money;
}

export function carcassCutLineTotal(cut: { weight: Quantity; unitPrice: Money }): Money {
  return roundMoney(cut.weight * cut.unitPrice);
}

export interface Creditor {
  id: string;
  branchId: string;
  name: string;
  phone?: string;
  notes?: string;
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
