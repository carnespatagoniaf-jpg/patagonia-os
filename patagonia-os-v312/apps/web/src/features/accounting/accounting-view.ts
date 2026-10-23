// Información contable (migración 155): tipos de comprobante, posición de IVA
// y control del monotributo. Lógica pura, sin Supabase.

export interface VatLine {
  rate: number;
  net: number;
  vat: number;
}

/** Comprobante de venta autorizado por ARCA (de accounting_month.sales). */
export interface SaleVoucher {
  id: string;
  kind: "factura" | "nota_credito";
  date: string;
  voucherType: number;
  pointOfSale: number;
  number: number;
  letter: string;
  docType: number;
  doc: string;
  name: string | null;
  total: number;
  net: number;
  vat: number;
  vatRate: number;
  vatLines: VatLine[] | null;
}

/** Comprobante de compra (tabla purchase_vouchers). */
export interface PurchaseVoucher {
  id: string;
  purchaseId: string | null;
  supplierId: string | null;
  period: string;
  voucherDate: string;
  voucherType: number;
  pointOfSale: number;
  number: number;
  sellerDocType: number;
  sellerDoc: string;
  sellerName: string;
  vatLines: VatLine[];
  netTaxed: number;
  vatTotal: number;
  noTaxed: number;
  exempt: number;
  percVat: number;
  percIibb: number;
  percNational: number;
  percMunicipal: number;
  internalTaxes: number;
  otherTaxes: number;
  total: number;
  cae: string | null;
  source: "manual" | "compras" | "arca";
  notes: string | null;
}

/** Tabla de comprobantes de ARCA (los que usa un comercio). */
export const VOUCHER_TYPE_LABELS: Record<number, string> = {
  1: "Factura A",
  2: "Nota de Débito A",
  3: "Nota de Crédito A",
  6: "Factura B",
  7: "Nota de Débito B",
  8: "Nota de Crédito B",
  11: "Factura C",
  12: "Nota de Débito C",
  13: "Nota de Crédito C",
  51: "Factura M",
  52: "Nota de Débito M",
  53: "Nota de Crédito M",
  81: "Tique Factura A",
  82: "Tique Factura B",
  83: "Tique",
  111: "Tique Factura C",
  201: "Factura de Crédito MiPyME A",
  202: "Nota de Débito MiPyME A",
  203: "Nota de Crédito MiPyME A",
  206: "Factura de Crédito MiPyME B",
  207: "Nota de Débito MiPyME B",
  208: "Nota de Crédito MiPyME B",
  211: "Factura de Crédito MiPyME C",
  212: "Nota de Débito MiPyME C",
  213: "Nota de Crédito MiPyME C"
};

/** Los que se ofrecen al cargar una compra a mano (el resto entra importando). */
export const PURCHASE_VOUCHER_TYPES = [1, 3, 6, 8, 11, 13, 51, 53, 2, 7, 12] as const;

const CREDIT_NOTES = new Set([3, 8, 13, 53, 203, 208, 213]);
const DISCRIMINATES = new Set([1, 2, 3, 51, 52, 53, 81, 201, 202, 203]);

export function voucherTypeLabel(type: number): string {
  return VOUCHER_TYPE_LABELS[type] ?? `Comprobante ${type}`;
}

export function isCreditNote(type: number): boolean {
  return CREDIT_NOTES.has(type);
}

/** En la compra: A y M discriminan IVA (se computa como crédito fiscal); B y C no. */
export function purchaseDiscriminatesVat(type: number): boolean {
  return DISCRIMINATES.has(type);
}

/** En la venta: A y B llevan IVA (en la B, el contenido); C no. */
export function saleHasVat(sale: Pick<SaleVoucher, "letter">): boolean {
  return sale.letter === "A" || sale.letter === "B";
}

/** IVA de una venta por alícuota (las viejas, sin desglose, con su alícuota única). */
export function saleVatLines(sale: SaleVoucher): VatLine[] {
  if (!saleHasVat(sale)) return [];
  if (sale.vatLines && sale.vatLines.length > 0) return sale.vatLines;
  return [{ rate: sale.vatRate, net: sale.net, vat: sale.vat }];
}

const cents = (n: number) => Math.round(n * 100);
const sign = (type: number) => (isCreditNote(type) ? -1 : 1);

export interface RateTotal {
  rate: number;
  net: number;
  vat: number;
}

function addRate(map: Map<number, { net: number; vat: number }>, rate: number, net: number, vat: number) {
  const cur = map.get(rate) ?? { net: 0, vat: 0 };
  cur.net += net;
  cur.vat += vat;
  map.set(rate, cur);
}

function rateTotals(map: Map<number, { net: number; vat: number }>): RateTotal[] {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, t]) => ({ rate, net: t.net / 100, vat: t.vat / 100 }));
}

export interface VatPosition {
  /** IVA de las ventas (débito fiscal), notas de crédito restadas. */
  debit: number;
  /** IVA de las compras A/M (crédito fiscal), notas de crédito restadas. */
  credit: number;
  /** Percepciones de IVA que te hicieron los proveedores. */
  perceptions: number;
  /** Positivo: a pagar. Negativo: saldo a favor. */
  balance: number;
  salesByRate: RateTotal[];
  purchasesByRate: RateTotal[];
}

/** Posición de IVA del mes (estimada: el contador la confirma en el F. 2002). */
export function vatPosition(sales: SaleVoucher[], purchases: PurchaseVoucher[]): VatPosition {
  const salesRates = new Map<number, { net: number; vat: number }>();
  let debit = 0;
  for (const s of sales) {
    for (const l of saleVatLines(s)) {
      const k = sign(s.voucherType);
      debit += k * cents(l.vat);
      addRate(salesRates, l.rate, k * cents(l.net), k * cents(l.vat));
    }
  }
  const purchaseRates = new Map<number, { net: number; vat: number }>();
  let credit = 0;
  let perceptions = 0;
  for (const p of purchases) {
    const k = sign(p.voucherType);
    perceptions += k * cents(p.percVat);
    if (!purchaseDiscriminatesVat(p.voucherType)) continue;
    for (const l of p.vatLines) {
      credit += k * cents(l.vat);
      addRate(purchaseRates, l.rate, k * cents(l.net), k * cents(l.vat));
    }
  }
  return {
    debit: debit / 100,
    credit: credit / 100,
    perceptions: perceptions / 100,
    balance: (debit - credit - perceptions) / 100,
    salesByRate: rateTotals(salesRates),
    purchasesByRate: rateTotals(purchaseRates)
  };
}

export interface MonotributoCategory {
  category: string;
  maxIncome: number;
}

export interface MonotributoStatus {
  income: number;
  /** Categoría que corresponde por lo facturado (null: pasó la K). */
  category: string | null;
  limit: number | null;
  /** Cuánto falta para el tope de esa categoría. */
  remaining: number | null;
  /** 0–100+: cuánto del tope de la categoría ya se usó. */
  usedPct: number | null;
  level: "ok" | "cerca" | "excede";
}

/** Qué categoría corresponde a lo facturado en 12 meses y cuánto falta para el tope. */
export function monotributoStatus(income: number, categories: MonotributoCategory[]): MonotributoStatus {
  const sorted = [...categories].sort((a, b) => a.maxIncome - b.maxIncome);
  const cat = sorted.find((c) => income <= c.maxIncome) ?? null;
  if (!cat) {
    return { income, category: null, limit: sorted.length ? sorted[sorted.length - 1].maxIncome : null, remaining: null, usedPct: null, level: "excede" };
  }
  const usedPct = cat.maxIncome > 0 ? Math.round((income / cat.maxIncome) * 1000) / 10 : 0;
  return {
    income,
    category: cat.category,
    limit: cat.maxIncome,
    remaining: Math.round((cat.maxIncome - income) * 100) / 100,
    usedPct,
    // Desde el 90% del tope de su categoría conviene avisar (la próxima recategorización la sube).
    level: usedPct >= 90 ? "cerca" : "ok"
  };
}

/** "2026-10" → "octubre 2026" */
export function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  const names = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  return `${names[(m || 1) - 1]} ${y}`;
}

/** "0003-00001234" */
export function voucherNumber(pointOfSale: number, number: number): string {
  return `${String(pointOfSale).padStart(5, "0")}-${String(number).padStart(8, "0")}`;
}

/** Número como se escribe en Compras: "0003-00001234", "3-1234" o "000300001234" → punto de venta y número. */
export function parseVoucherNumber(text: string | null | undefined): { pointOfSale: number; number: number } | null {
  const s = (text ?? "").trim();
  const parts = s.match(/^(\d{1,5})\s*[-/ ]\s*(\d{1,8})$/);
  if (parts) return { pointOfSale: Number(parts[1]), number: Number(parts[2]) };
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length > 8) return { pointOfSale: Number(digits.slice(0, -8)), number: Number(digits.slice(-8)) };
  return { pointOfSale: 0, number: Number(digits) };
}

/** Suma lo que forma el total de una compra A/M (lo mismo que controla la base, con $1 de tolerancia). */
export function purchaseParts(v: Pick<PurchaseVoucher, "vatLines" | "noTaxed" | "exempt" | "percVat" | "percIibb" | "percNational" | "percMunicipal" | "internalTaxes" | "otherTaxes">): number {
  const lines = v.vatLines.reduce((s, l) => s + cents(l.net) + cents(l.vat), 0);
  const rest = [v.noTaxed, v.exempt, v.percVat, v.percIibb, v.percNational, v.percMunicipal, v.internalTaxes, v.otherTaxes].reduce((s, n) => s + cents(n || 0), 0);
  return (lines + rest) / 100;
}
