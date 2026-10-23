// Ingresos Brutos del mes (migración 156). Lógica pura.
// Impuesto = base × alícuota (en Convenio Multilateral, la base de cada
// provincia es base × su coeficiente). A pagar = impuesto − percepciones de las
// facturas de compra − retenciones del banco (SIRCREB) − créditos cargados.
import { isCreditNote, saleVatLines, type SaleVoucher } from "./accounting-view";

export type IibbRegime = "local" | "convenio" | "simplificado" | "exento";

export interface IibbJurisdiction {
  name: string;
  /** % (3,5 = 3,5%) */
  rate: number;
  /** Solo Convenio Multilateral (0 a 1). */
  coefficient: number;
}

export interface IibbSettings {
  regime: IibbRegime;
  jurisdictions: IibbJurisdiction[];
  base: "invoiced" | "sales";
  dueDay: number | null;
}

export interface IibbCredit {
  id: string;
  kind: "retencion" | "percepcion" | "saldo_a_favor" | "otro";
  jurisdiction: string | null;
  amount: number;
  notes: string | null;
}

export const IIBB_CREDIT_LABELS: Record<IibbCredit["kind"], string> = {
  retencion: "Retención",
  percepcion: "Percepción",
  saldo_a_favor: "Saldo a favor del mes anterior",
  otro: "Otro pago a cuenta"
};

export const IIBB_REGIME_LABELS: Record<IibbRegime, string> = {
  local: "Contribuyente local (una provincia)",
  convenio: "Convenio Multilateral (varias provincias)",
  simplificado: "Régimen simplificado (cuota fija, con el monotributo)",
  exento: "Exento"
};

export interface IibbResult {
  base: number;
  baseNote: string;
  lines: { name: string; base: number; rate: number; tax: number }[];
  tax: number;
  perceptions: number;
  bankWithholdings: number;
  credits: number;
  /** Positivo: a pagar. Negativo: saldo a favor. */
  balance: number;
  applies: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Lo facturado del mes sin IVA (A y B: neto; C: total), notas de crédito restadas. */
export function invoicedBase(sales: SaleVoucher[]): number {
  let cents = 0;
  for (const s of sales) {
    const lines = saleVatLines(s);
    const amount = lines.length > 0 ? lines.reduce((a, l) => a + l.net, 0) : s.total;
    cents += (isCreditNote(s.voucherType) ? -1 : 1) * Math.round(amount * 100);
  }
  return cents / 100;
}

export function computeIibb(input: {
  settings: IibbSettings;
  sales: SaleVoucher[];
  /** Ventas del mes registradas en el sistema (Mostrador + a cuenta), con IVA si corresponde. */
  systemSales: number;
  taxCondition: string | null;
  defaultVatRate: number | null;
  perceptions: number;
  bankWithholdings: number;
  credits: IibbCredit[];
}): IibbResult {
  const { settings } = input;
  let base: number;
  let baseNote: string;
  if (settings.base === "sales") {
    const ri = input.taxCondition === "responsable_inscripto";
    const vat = input.defaultVatRate ?? 21;
    base = r2(ri ? input.systemSales / (1 + vat / 100) : input.systemSales);
    baseNote = ri ? `Todas las ventas del sistema, sin el IVA (${String(vat).replace(".", ",")}%)` : "Todas las ventas del sistema";
  } else {
    base = invoicedBase(input.sales);
    baseNote = "Lo facturado a ARCA en el mes, sin IVA";
  }

  const applies = settings.regime === "local" || settings.regime === "convenio";
  const lines = applies
    ? settings.jurisdictions.map((j) => {
        const jBase = r2(settings.regime === "convenio" ? base * j.coefficient : base);
        return { name: j.name, base: jBase, rate: j.rate, tax: r2((jBase * j.rate) / 100) };
      })
    : [];
  const tax = r2(lines.reduce((s, l) => s + l.tax, 0));
  const credits = r2(input.credits.reduce((s, c) => s + c.amount, 0));
  const deductions = applies ? r2(input.perceptions + input.bankWithholdings + credits) : 0;
  return {
    base,
    baseNote,
    lines,
    tax,
    perceptions: input.perceptions,
    bankWithholdings: input.bankWithholdings,
    credits,
    balance: r2(tax - deductions),
    applies
  };
}
