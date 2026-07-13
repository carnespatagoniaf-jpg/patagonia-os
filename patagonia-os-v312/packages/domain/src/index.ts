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
}

export interface CartItem {
  product: Product;
  quantity: Quantity;
  unitPrice: Money;
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
