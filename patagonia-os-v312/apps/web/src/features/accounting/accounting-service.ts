// Información contable (migración 155): el mes completo, comprobantes de compra
// y CUIT de los proveedores.
import { supabase } from "../../lib/supabase";
import type { MonotributoCategory, PurchaseVoucher, SaleVoucher, VatLine } from "./accounting-view";
import type { ImportedVoucher } from "./mis-comprobantes";

export interface AccountingMonth {
  period: string;
  periodEnd: string;
  company: { name: string; cuit: string | null; businessName: string | null; taxCondition: "monotributo" | "responsable_inscripto" | null; pointOfSale: number | null; invoicingEnabled: boolean };
  sales: SaleVoucher[];
  purchases: (PurchaseVoucher & { supplierName: string | null })[];
  purchasesWithoutVoucher: { id: string; date: string; supplierId: string | null; supplier: string | null; supplierTaxId: string | null; invoiceNumber: string | null; total: number }[];
  monotributo: { from: string; to: string; invoiced12m: number; sales12m: number; categories: MonotributoCategory[]; categoriesFrom: string | null };
  monthSales: { pos: number; account: number };
  expenses: { category: string; total: number }[];
  payroll: { salaries: number; advances: number };
  supplierPayments: number;
  accounts: { name: string; kind: string | null; balance: number }[];
  receivables: { name: string; taxId: string | null; balance: number }[];
  payables: { name: string; taxId: string | null; balance: number }[];
  debts: { name: string; balance: number }[];
  cheques: { kind: "received" | "issued"; status: string; number: string | null; bank: string | null; drawer: string | null; amount: number; payDate: string | null }[];
  stock: { branch: string; value: number }[];
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function lines(value: unknown): VatLine[] {
  if (!Array.isArray(value)) return [];
  return value.map((l) => ({ rate: Number(l?.rate), net: Number(l?.net), vat: Number(l?.vat) }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapPurchaseVoucher(row: any): PurchaseVoucher & { supplierName: string | null } {
  return {
    id: row.id,
    purchaseId: row.purchase_id ?? null,
    supplierId: row.supplier_id ?? null,
    period: row.period,
    voucherDate: row.voucher_date,
    voucherType: Number(row.voucher_type),
    pointOfSale: Number(row.point_of_sale),
    number: Number(row.number),
    sellerDocType: Number(row.seller_doc_type),
    sellerDoc: row.seller_doc,
    sellerName: row.seller_name,
    vatLines: lines(row.vat_lines),
    netTaxed: num(row.net_taxed),
    vatTotal: num(row.vat_total),
    noTaxed: num(row.no_taxed),
    exempt: num(row.exempt),
    percVat: num(row.perc_vat),
    percIibb: num(row.perc_iibb),
    percNational: num(row.perc_national),
    percMunicipal: num(row.perc_municipal),
    internalTaxes: num(row.internal_taxes),
    otherTaxes: num(row.other_taxes),
    total: num(row.total),
    cae: row.cae ?? null,
    source: row.source,
    notes: row.notes ?? null,
    supplierName: row.supplier_name ?? null
  };
}

/** month: "AAAA-MM" */
export async function getAccountingMonth(month: string): Promise<AccountingMonth> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("accounting_month", { p_month: `${month}-01` });
  if (error) throw error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  return {
    period: d.period,
    periodEnd: d.period_end,
    company: {
      name: d.company?.name ?? "",
      cuit: d.company?.cuit ?? null,
      businessName: d.company?.business_name ?? null,
      taxCondition: d.company?.tax_condition ?? null,
      pointOfSale: d.company?.point_of_sale ?? null,
      invoicingEnabled: Boolean(d.company?.invoicing_enabled)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sales: (d.sales ?? []).map((s: any) => ({
      id: s.id,
      kind: s.kind,
      date: s.date,
      voucherType: Number(s.voucher_type),
      pointOfSale: Number(s.point_of_sale),
      number: Number(s.number),
      letter: s.letter,
      docType: Number(s.doc_type),
      doc: s.doc ?? "0",
      name: s.name ?? null,
      total: num(s.total),
      net: num(s.net),
      vat: num(s.vat),
      vatRate: num(s.vat_rate),
      vatLines: Array.isArray(s.vat_lines) && s.vat_lines.length > 0 ? lines(s.vat_lines) : null
    })),
    purchases: (d.purchases ?? []).map(mapPurchaseVoucher),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    purchasesWithoutVoucher: (d.purchases_without_voucher ?? []).map((p: any) => ({
      id: p.id,
      date: p.date,
      supplierId: p.supplier_id ?? null,
      supplier: p.supplier ?? null,
      supplierTaxId: p.supplier_tax_id ?? null,
      invoiceNumber: p.invoice_number ?? null,
      total: num(p.total)
    })),
    monotributo: {
      from: d.monotributo?.from,
      to: d.monotributo?.to,
      invoiced12m: num(d.monotributo?.invoiced_12m),
      sales12m: num(d.monotributo?.sales_12m),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      categories: (d.monotributo?.categories ?? []).map((c: any) => ({ category: c.category, maxIncome: num(c.max_income) })),
      categoriesFrom: d.monotributo?.categories_from ?? null
    },
    monthSales: { pos: num(d.month_sales?.pos), account: num(d.month_sales?.account) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expenses: (d.expenses ?? []).map((e: any) => ({ category: e.category, total: num(e.total) })),
    payroll: { salaries: num(d.payroll?.salaries), advances: num(d.payroll?.advances) },
    supplierPayments: num(d.supplier_payments),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accounts: (d.accounts ?? []).map((a: any) => ({ name: a.name, kind: a.kind ?? null, balance: num(a.balance) })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    receivables: (d.receivables ?? []).map((r: any) => ({ name: r.name, taxId: r.tax_id ?? null, balance: num(r.balance) })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payables: (d.payables ?? []).map((r: any) => ({ name: r.name, taxId: r.tax_id ?? null, balance: num(r.balance) })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debts: (d.debts ?? []).map((r: any) => ({ name: r.name, balance: num(r.balance) })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cheques: (d.cheques ?? []).map((c: any) => ({ kind: c.kind, status: c.status, number: c.number ?? null, bank: c.bank ?? null, drawer: c.drawer ?? null, amount: num(c.amount), payDate: c.pay_date ?? null })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stock: (d.stock ?? []).map((s: any) => ({ branch: s.branch, value: num(s.value) }))
  };
}

export interface PurchaseVoucherInput {
  id?: string;
  purchaseId?: string | null;
  supplierId?: string | null;
  branchId?: string | null;
  period?: string | null;
  voucherDate: string;
  voucherType: number;
  pointOfSale: number;
  number: number;
  sellerDoc: string;
  sellerName: string;
  vatLines: VatLine[];
  noTaxed: number;
  exempt: number;
  percVat: number;
  percIibb: number;
  percNational: number;
  percMunicipal: number;
  internalTaxes: number;
  otherTaxes: number;
  total: number;
  cae?: string | null;
  notes?: string | null;
}

export async function savePurchaseVoucher(input: PurchaseVoucherInput): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("save_purchase_voucher", {
    p_voucher: {
      id: input.id ?? null,
      purchase_id: input.purchaseId ?? null,
      supplier_id: input.supplierId ?? null,
      branch_id: input.branchId ?? null,
      period: input.period ?? null,
      voucher_date: input.voucherDate,
      voucher_type: input.voucherType,
      point_of_sale: input.pointOfSale,
      number: input.number,
      seller_doc_type: 80,
      seller_doc: input.sellerDoc,
      seller_name: input.sellerName,
      vat_lines: input.vatLines,
      no_taxed: input.noTaxed,
      exempt: input.exempt,
      perc_vat: input.percVat,
      perc_iibb: input.percIibb,
      perc_national: input.percNational,
      perc_municipal: input.percMunicipal,
      internal_taxes: input.internalTaxes,
      other_taxes: input.otherTaxes,
      total: input.total,
      cae: input.cae ?? null,
      notes: input.notes ?? null
    }
  });
  if (error) throw error;
  return String(data);
}

export async function deletePurchaseVoucher(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_purchase_voucher", { p_voucher_id: id });
  if (error) throw error;
}

export interface ImportVouchersResult {
  created: number;
  skipped: number;
  errors: { row: number; error: string }[];
}

export async function importPurchaseVouchers(rows: ImportedVoucher[]): Promise<ImportVouchersResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("import_purchase_vouchers", { p_rows: rows });
  if (error) throw error;
  const d = (data ?? {}) as Partial<ImportVouchersResult>;
  return { created: Number(d.created ?? 0), skipped: Number(d.skipped ?? 0), errors: d.errors ?? [] };
}

/** CUIT y condición de cada proveedor (para Compras y para cargar facturas). */
export async function listSupplierTaxInfo(): Promise<Record<string, { taxId: string | null; taxCondition: string | null }>> {
  if (!supabase) return {};
  const { data, error } = await supabase.from("suppliers").select("id,tax_id,tax_condition");
  if (error) {
    if ((error as { code?: string }).code === "42703") return {};
    throw error;
  }
  return Object.fromEntries((data ?? []).map((r) => [r.id, { taxId: r.tax_id ?? null, taxCondition: r.tax_condition ?? null }]));
}

export async function setSupplierTax(supplierId: string, taxId: string | null, taxCondition: string | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_supplier_tax", { p_supplier_id: supplierId, p_tax_id: taxId, p_tax_condition: taxCondition });
  if (error) throw error;
}

/** El comprobante cargado para una compra (si tiene). */
export async function getVoucherForPurchase(purchaseId: string): Promise<(PurchaseVoucher & { supplierName: string | null }) | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("purchase_vouchers").select("*").eq("purchase_id", purchaseId).maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "42P01") return null;
    throw error;
  }
  return data ? mapPurchaseVoucher(data) : null;
}

/** Las facturas cargadas para estas compras (compra → comprobante). */
export async function listVouchersForPurchases(purchaseIds: string[]): Promise<Record<string, PurchaseVoucher & { supplierName: string | null }>> {
  if (!supabase || purchaseIds.length === 0) return {};
  const { data, error } = await supabase.from("purchase_vouchers").select("*").in("purchase_id", purchaseIds);
  if (error) {
    if ((error as { code?: string }).code === "42P01") return {};
    throw error;
  }
  return Object.fromEntries((data ?? []).map((row) => [row.purchase_id as string, mapPurchaseVoucher(row)]));
}
