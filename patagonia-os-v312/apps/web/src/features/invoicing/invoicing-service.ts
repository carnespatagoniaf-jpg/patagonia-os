import { supabase } from "../../lib/supabase";
import type { CustomerCondition, InvoiceDraft, InvoiceLetter, IssuerCondition } from "./invoicing-view";

// Factura electrónica ARCA (migración 113). Lectura directa de las tablas (la
// política de seguridad deja ver solo las de la empresa, y solo en plan Full);
// todo lo que escribe va por funciones de la base. La autorización ante ARCA
// (CAE) la hace una Edge Function aparte (parte 2, cuando estén los certificados).

export interface FiscalSettings {
  cuit: string;
  businessName: string;
  taxCondition: IssuerCondition;
  pointOfSale: number;
  address: string;
  grossIncomeNumber: string;
  activityStart: string;
  defaultVatRate: number;
  enabled: boolean;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
}

export async function getFiscalSettings(): Promise<FiscalSettings | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("company_fiscal_settings")
    .select("cuit,business_name,tax_condition,point_of_sale,address,gross_income_number,activity_start,default_vat_rate,enabled,last_check_at,last_check_ok,last_check_message")
    .maybeSingle();
  // Antes de la migración (o en un plan sin factura) la tabla no existe o se lee vacía: es "sin configurar".
  if (error) return null;
  if (!data) return null;
  return {
    cuit: data.cuit,
    businessName: data.business_name,
    taxCondition: data.tax_condition,
    pointOfSale: Number(data.point_of_sale),
    address: data.address ?? "",
    grossIncomeNumber: data.gross_income_number ?? "",
    activityStart: data.activity_start ?? "",
    defaultVatRate: Number(data.default_vat_rate),
    enabled: Boolean(data.enabled),
    lastCheckAt: data.last_check_at,
    lastCheckOk: data.last_check_ok,
    lastCheckMessage: data.last_check_message
  };
}

export async function saveFiscalSettings(input: Omit<FiscalSettings, "enabled" | "lastCheckAt" | "lastCheckOk" | "lastCheckMessage">): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("save_fiscal_settings", {
    p_cuit: input.cuit,
    p_business_name: input.businessName,
    p_tax_condition: input.taxCondition,
    p_point_of_sale: input.pointOfSale,
    p_address: input.address,
    p_gross_income_number: input.grossIncomeNumber,
    p_activity_start: input.activityStart || null,
    p_default_vat_rate: input.defaultVatRate
  });
  if (error) throw error;
}

export type InvoiceStatus = "pendiente" | "autorizada" | "rechazada";

export interface Invoice {
  id: string;
  posSaleId: string | null;
  kind: "factura" | "nota_credito";
  letter: InvoiceLetter;
  pointOfSale: number;
  number: number | null;
  status: InvoiceStatus;
  cae: string | null;
  caeDue: string | null;
  customerDocType: number;
  customerDocNumber: string;
  customerName: string | null;
  customerTaxCondition: CustomerCondition;
  total: number;
  errorMessage: string | null;
  createdAt: string;
}

export async function listInvoices(limit = 200): Promise<Invoice[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("invoices")
    .select("id,pos_sale_id,kind,letter,point_of_sale,number,status,cae,cae_due,customer_doc_type,customer_doc_number,customer_name,customer_tax_condition,total,error_message,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    posSaleId: row.pos_sale_id,
    kind: row.kind,
    letter: row.letter,
    pointOfSale: Number(row.point_of_sale),
    number: row.number === null ? null : Number(row.number),
    status: row.status,
    cae: row.cae,
    caeDue: row.cae_due,
    customerDocType: Number(row.customer_doc_type),
    customerDocNumber: row.customer_doc_number,
    customerName: row.customer_name,
    customerTaxCondition: row.customer_tax_condition,
    total: Number(row.total),
    errorMessage: row.error_message,
    createdAt: row.created_at
  }));
}

export interface UninvoicedSale {
  id: string;
  total: number;
  createdAt: string;
}

/** Ventas de Mostrador de los últimos días que no tienen factura (para facturar después de cobrar). */
export async function listUninvoicedSales(branchId: string, days = 7): Promise<UninvoicedSale[]> {
  if (!supabase) return [];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: sales, error } = await supabase
    .from("pos_sales")
    .select("id,total,created_at")
    .eq("branch_id", branchId)
    .is("voided_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const ids = (sales ?? []).map((s) => s.id);
  if (ids.length === 0) return [];
  const { data: invoiced, error: invError } = await supabase
    .from("invoices")
    .select("pos_sale_id,status")
    .in("pos_sale_id", ids)
    .eq("kind", "factura")
    .neq("status", "rechazada");
  if (invError) throw invError;
  const taken = new Set((invoiced ?? []).map((i) => i.pos_sale_id));
  return (sales ?? []).filter((s) => !taken.has(s.id)).map((s) => ({ id: s.id, total: Number(s.total), createdAt: s.created_at }));
}

export async function requestInvoice(saleId: string, draft: InvoiceDraft): Promise<{ invoiceId: string; letter: InvoiceLetter }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("request_invoice", {
    p_sale_id: saleId,
    p_customer_tax_condition: draft.customerCondition,
    p_customer_doc: draft.doc,
    p_customer_name: draft.name
  });
  if (error) throw error;
  return { invoiceId: data.invoice_id, letter: data.letter };
}
