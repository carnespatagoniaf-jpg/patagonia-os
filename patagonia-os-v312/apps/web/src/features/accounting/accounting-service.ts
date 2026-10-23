// Información contable (migración 155): el mes completo, comprobantes de compra
// y CUIT de los proveedores.
import { supabase } from "../../lib/supabase";
import type { MonotributoCategory, PurchaseVoucher, SaleVoucher, VatLine } from "./accounting-view";
import type { ImportedVoucher } from "./mis-comprobantes";
import type { IibbCredit, IibbSettings } from "./iibb";
import type { Obligation, OfficialDue, TaxReminder } from "./tax-calendar";

export interface AccountingMonth {
  period: string;
  periodEnd: string;
  company: { name: string; cuit: string | null; businessName: string | null; taxCondition: "monotributo" | "responsable_inscripto" | null; pointOfSale: number | null; invoicingEnabled: boolean; defaultVatRate: number | null };
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
  iibb: {
    settings: (IibbSettings & { obligations: Obligation[] | null }) | null;
    perceptions: number;
    bankWithholdings: number;
    bankWithholdingLines: number;
    credits: IibbCredit[];
  };
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
    attachmentPath: row.attachment_path ?? null,
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
      invoicingEnabled: Boolean(d.company?.invoicing_enabled),
      defaultVatRate: d.company?.default_vat_rate === null || d.company?.default_vat_rate === undefined ? null : Number(d.company.default_vat_rate)
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
    stock: (d.stock ?? []).map((s: any) => ({ branch: s.branch, value: num(s.value) })),
    iibb: {
      settings: mapTaxSettings(d.iibb?.settings),
      perceptions: num(d.iibb?.perceptions),
      bankWithholdings: num(d.iibb?.bank_withholdings),
      bankWithholdingLines: num(d.iibb?.bank_withholding_lines),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credits: (d.iibb?.credits ?? []).map((c: any) => ({ id: c.id, kind: c.kind, jurisdiction: c.jurisdiction ?? null, amount: num(c.amount), notes: c.notes ?? null }))
    }
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTaxSettings(t: any): (IibbSettings & { obligations: Obligation[] | null }) | null {
  if (!t) return null;
  return {
    regime: t.iibb_regime ?? "local",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jurisdictions: (t.iibb_jurisdictions ?? []).map((j: any) => ({ name: j.name, rate: num(j.rate), coefficient: j.coefficient === null || j.coefficient === undefined ? 1 : num(j.coefficient) })),
    base: t.iibb_base === "sales" ? "sales" : "invoiced",
    dueDay: t.iibb_due_day ?? null,
    obligations: Array.isArray(t.obligations) ? t.obligations : null
  };
}

/* ---------------------------------------------- impuestos y vencimientos (migración 156) */

export async function saveTaxSettings(input: IibbSettings & { obligations?: Obligation[] | null }): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const payload: Record<string, unknown> = {
    iibb_regime: input.regime,
    iibb_jurisdictions: input.jurisdictions,
    iibb_base: input.base,
    iibb_due_day: input.dueDay
  };
  if (input.obligations !== undefined) payload.obligations = input.obligations;
  const { error } = await supabase.rpc("save_company_tax_settings", { p_settings: payload });
  if (error) throw error;
}

export async function addIibbCredit(input: { period: string; kind: IibbCredit["kind"]; jurisdiction: string | null; amount: number; notes: string | null }): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("add_iibb_credit", { p_period: input.period, p_kind: input.kind, p_jurisdiction: input.jurisdiction, p_amount: input.amount, p_notes: input.notes });
  if (error) throw error;
}

export async function deleteIibbCredit(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_iibb_credit", { p_id: id });
  if (error) throw error;
}

export async function listTaxReminders(): Promise<TaxReminder[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("tax_reminders").select("id,title,day_of_month,active").order("day_of_month");
  if (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
  return (data ?? []).map((r) => ({ id: r.id, title: r.title, dayOfMonth: Number(r.day_of_month), active: Boolean(r.active) }));
}

export async function saveTaxReminder(input: { id?: string | null; title: string; dayOfMonth: number; active: boolean }): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("save_tax_reminder", { p_id: input.id ?? null, p_title: input.title, p_day: input.dayOfMonth, p_active: input.active });
  if (error) throw error;
}

export async function deleteTaxReminder(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_tax_reminder", { p_id: id });
  if (error) throw error;
}

/** Calendario oficial de ARCA desde un mes (AAAA-MM-01). */
export async function listOfficialDues(fromMonth: string): Promise<OfficialDue[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("official_due_dates").select("month,obligation,digits,due_date").gte("month", fromMonth);
  if (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
  return (data ?? []).map((r) => ({ month: r.month, obligation: r.obligation, digits: r.digits, dueDate: r.due_date }));
}

/** Lo que usa Inicio para avisar los vencimientos (dueño o administrador, plan Full). */
export async function getTaxCalendarInputs(): Promise<{ cuit: string | null; taxCondition: string | null; settings: (IibbSettings & { obligations: Obligation[] | null }) | null; reminders: TaxReminder[]; official: OfficialDue[] }> {
  if (!supabase) return { cuit: null, taxCondition: null, settings: null, reminders: [], official: [] };
  const sixMonthsAgo = new Date(Date.now() - 183 * 86400_000).toISOString().slice(0, 8) + "01";
  const [fiscal, settings, reminders, official] = await Promise.all([
    supabase.from("company_fiscal_settings").select("cuit,tax_condition").maybeSingle(),
    supabase.from("company_tax_settings").select("*").maybeSingle(),
    listTaxReminders(),
    listOfficialDues(sixMonthsAgo)
  ]);
  return {
    cuit: fiscal.data?.cuit ?? null,
    taxCondition: fiscal.data?.tax_condition ?? null,
    settings: settings.error ? null : mapTaxSettings(settings.data),
    reminders,
    official
  };
}

/* ---------------------------------------------- antigüedad de saldos */

export interface AgingRow {
  name: string;
  taxId: string | null;
  phone: string | null;
  balance: number;
  b0_30: number;
  b31_60: number;
  b61_90: number;
  b90: number;
  oldest: string | null;
}

export async function getAging(): Promise<{ asOf: string; receivables: AgingRow[]; payables: AgingRow[] }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("accounting_aging", { p_as_of: null });
  if (error) throw error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = (r: any): AgingRow => ({
    name: r.name,
    taxId: r.tax_id ?? null,
    phone: r.phone ?? null,
    balance: num(r.balance),
    b0_30: num(r.b0_30),
    b31_60: num(r.b31_60),
    b61_90: num(r.b61_90),
    b90: num(r.b90),
    oldest: r.oldest ?? null
  });
  return { asOf: d.as_of, receivables: (d.receivables ?? []).map(map), payables: (d.payables ?? []).map(map) };
}

/* ---------------------------------------------- inventario al cierre */

export interface InventorySnapshot {
  id: string;
  takenOn: string;
  label: string | null;
  totalValue: number;
  itemsCount: number;
  createdAt: string;
}

export interface InventorySnapshotItem {
  branchName: string;
  code: string | null;
  name: string;
  category: string | null;
  unit: string | null;
  quantity: number;
  unitCost: number;
  value: number;
}

export async function listInventorySnapshots(): Promise<InventorySnapshot[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("inventory_snapshots").select("id,taken_on,label,total_value,items_count,created_at").order("taken_on", { ascending: false });
  if (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
  return (data ?? []).map((r) => ({ id: r.id, takenOn: r.taken_on, label: r.label ?? null, totalValue: num(r.total_value), itemsCount: Number(r.items_count), createdAt: r.created_at }));
}

export async function listInventorySnapshotItems(snapshotId: string): Promise<InventorySnapshotItem[]> {
  if (!supabase) return [];
  const out: InventorySnapshotItem[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("inventory_snapshot_items")
      .select("branch_name,code,name,category,unit,quantity,unit_cost,value")
      .eq("snapshot_id", snapshotId)
      .order("branch_name")
      .order("name")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) {
      out.push({ branchName: r.branch_name, code: r.code ?? null, name: r.name, category: r.category ?? null, unit: r.unit ?? null, quantity: num(r.quantity), unitCost: num(r.unit_cost), value: num(r.value) });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function takeInventorySnapshot(date: string, label: string | null): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("take_inventory_snapshot", { p_date: date, p_label: label });
  if (error) throw error;
  return String(data);
}

export async function deleteInventorySnapshot(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_inventory_snapshot", { p_id: id });
  if (error) throw error;
}

/* ---------------------------------------------- foto o PDF de la factura */

const DOCS_BUCKET = "purchase-docs";

/** Sube el archivo a la carpeta de la empresa y lo vincula a la factura (reemplaza el anterior si había). */
export async function attachVoucherFile(companyId: string, voucher: { id: string; attachmentPath?: string | null }, file: File): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  if (file.size > 10 * 1024 * 1024) throw new Error("El archivo pesa más de 10 MB. Sacá la foto con menos resolución o subí el PDF.");
  if (!/^image\//.test(file.type) && file.type !== "application/pdf") throw new Error("Subí una foto (JPG o PNG) o un PDF.");
  const fromName = (file.name.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const ext = fromName || (file.type === "application/pdf" ? "pdf" : "jpg");
  const path = `${companyId}/${voucher.id}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  const { error: linkError } = await supabase.rpc("set_purchase_voucher_attachment", { p_voucher_id: voucher.id, p_path: path });
  if (linkError) {
    await supabase.storage.from(DOCS_BUCKET).remove([path]);
    throw linkError;
  }
  if (voucher.attachmentPath) await supabase.storage.from(DOCS_BUCKET).remove([voucher.attachmentPath]);
  return path;
}

export async function removeVoucherFile(voucher: { id: string; attachmentPath?: string | null }): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_purchase_voucher_attachment", { p_voucher_id: voucher.id, p_path: null });
  if (error) throw error;
  if (voucher.attachmentPath) await supabase.storage.from(DOCS_BUCKET).remove([voucher.attachmentPath]);
}

/** Enlace temporal (10 minutos) para ver el archivo. */
export async function voucherFileUrl(path: string): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.storage.from(DOCS_BUCKET).createSignedUrl(path, 600);
  if (error || !data) throw error ?? new Error("No se pudo abrir el archivo.");
  return data.signedUrl;
}
