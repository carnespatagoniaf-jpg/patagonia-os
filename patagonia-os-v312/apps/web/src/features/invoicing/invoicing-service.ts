import { supabase } from "../../lib/supabase";
import { arcaQrUrl, invoiceLabel, type CustomerCondition, type InvoiceDraft, type InvoiceLetter, type InvoicePrint, type IssuerCondition } from "./invoicing-view";

// Factura electrónica ARCA (migración 113). Lectura directa de las tablas (la
// política de seguridad deja ver solo las de la empresa, y solo en plan Full);
// todo lo que escribe va por funciones de la base. La autorización ante ARCA
// (CAE) la hace la Edge Function arca-invoice (parte 2, migración 136).

export interface FiscalSettings {
  cuit: string;
  businessName: string;
  /** Nombre de fantasía: va grande arriba de la factura (migración 138). La razón social sigue, más chica. */
  tradeName: string;
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
    .select("cuit,business_name,trade_name,tax_condition,point_of_sale,address,gross_income_number,activity_start,default_vat_rate,enabled,last_check_at,last_check_ok,last_check_message")
    .maybeSingle();
  // Antes de la migración (o en un plan sin factura) la tabla no existe o se lee vacía: es "sin configurar".
  if (error) return null;
  if (!data) return null;
  return {
    cuit: data.cuit,
    businessName: data.business_name,
    tradeName: data.trade_name ?? "",
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

export async function saveFiscalSettings(input: Omit<FiscalSettings, "enabled" | "lastCheckAt" | "lastCheckOk" | "lastCheckMessage" | "tradeName">): Promise<void> {
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

/** Nombre de fantasía de la factura (vacío = sale solo la razón social). */
export async function setFiscalTradeName(tradeName: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_fiscal_trade_name", { p_trade_name: tradeName });
  if (error) throw error;
}

export type InvoiceStatus = "pendiente" | "autorizada" | "rechazada";

export interface Invoice {
  id: string;
  posSaleId: string | null;
  customerChargeId: string | null;
  kind: "factura" | "nota_credito";
  letter: InvoiceLetter;
  voucherType: number;
  pointOfSale: number;
  number: number | null;
  status: InvoiceStatus;
  cae: string | null;
  caeDue: string | null;
  issuedOn: string | null;
  customerDocType: number;
  customerDocNumber: string;
  customerName: string | null;
  customerTaxCondition: CustomerCondition;
  total: number;
  net: number;
  vat: number;
  vatRate: number;
  relatedInvoiceId: string | null;
  errorMessage: string | null;
  createdAt: string;
}

const INVOICE_COLUMNS =
  "id,pos_sale_id,customer_charge_id,kind,letter,voucher_type,point_of_sale,number,status,cae,cae_due,issued_on,customer_doc_type,customer_doc_number,customer_name,customer_tax_condition,total,net,vat,vat_rate,related_invoice_id,error_message,created_at";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapInvoice(row: any): Invoice {
  return {
    id: row.id,
    posSaleId: row.pos_sale_id,
    customerChargeId: row.customer_charge_id ?? null,
    kind: row.kind,
    letter: row.letter,
    voucherType: Number(row.voucher_type),
    pointOfSale: Number(row.point_of_sale),
    number: row.number === null ? null : Number(row.number),
    status: row.status,
    cae: row.cae,
    caeDue: row.cae_due,
    issuedOn: row.issued_on ?? null,
    customerDocType: Number(row.customer_doc_type),
    customerDocNumber: row.customer_doc_number,
    customerName: row.customer_name,
    customerTaxCondition: row.customer_tax_condition,
    total: Number(row.total),
    net: Number(row.net),
    vat: Number(row.vat),
    vatRate: Number(row.vat_rate),
    relatedInvoiceId: row.related_invoice_id ?? null,
    errorMessage: row.error_message,
    createdAt: row.created_at
  };
}

export async function listInvoices(limit = 200): Promise<Invoice[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("invoices").select(INVOICE_COLUMNS).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []).map(mapInvoice);
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

/** Texto de error de una Edge Function (viene en el cuerpo, no en error.message). */
async function invokeArca<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.functions.invoke("arca-invoice", { body });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const payload = await context.json();
        if (payload?.error) message = payload.error;
      } catch {
        // queda el mensaje de supabase-js
      }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

/** "Probar conexión con ARCA": si da bien, la factura queda activa (enabled). */
export async function checkArcaConnection(): Promise<{ ok: boolean; message: string; env: "homo" | "prod" }> {
  return invokeArca({ action: "check" });
}

export interface AuthorizeOutcome {
  id: string;
  status: InvoiceStatus;
  letter: InvoiceLetter;
  kind: "factura" | "nota_credito";
  number: number | null;
  cae: string | null;
  caeDue: string | null;
  message: string | null;
}

/** Pide el CAE de esa factura (o de todas las pendientes de la empresa, hasta 10). */
export async function authorizeInvoices(invoiceId?: string): Promise<AuthorizeOutcome[]> {
  const data = await invokeArca<{ results: AuthorizeOutcome[] }>({ action: "authorize", invoiceId });
  return data.results ?? [];
}

/** Factura de una venta en cuenta corriente (Clientes). Sin factura, sigue saliendo el remito. */
export async function requestChargeInvoice(chargeId: string, draft: InvoiceDraft): Promise<{ invoiceId: string; letter: InvoiceLetter }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("request_charge_invoice", {
    p_charge_id: chargeId,
    p_customer_tax_condition: draft.customerCondition,
    p_customer_doc: draft.doc,
    p_customer_name: draft.name
  });
  if (error) throw error;
  return { invoiceId: data.invoice_id, letter: data.letter };
}

/** Anular una factura autorizada: deja su nota de crédito pendiente (después, authorizeInvoices). */
export async function requestCreditNote(invoiceId: string): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("request_credit_note", { p_invoice_id: invoiceId });
  if (error) throw error;
  return data as string;
}

export async function getInvoice(invoiceId: string): Promise<Invoice | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("invoices").select(INVOICE_COLUMNS).eq("id", invoiceId).maybeSingle();
  if (error) throw error;
  return data ? mapInvoice(data) : null;
}

/** Facturas de un grupo de ventas en cuenta corriente (para marcar cuáles ya tienen). */
export async function listChargeInvoices(chargeIds: string[]): Promise<Invoice[]> {
  if (!supabase || chargeIds.length === 0) return [];
  const { data, error } = await supabase.from("invoices").select(INVOICE_COLUMNS).in("customer_charge_id", chargeIds);
  if (error) throw error;
  return (data ?? []).map(mapInvoice);
}

/** Todo lo que lleva impreso un comprobante autorizado (emisor, cliente, CAE y QR). */
export function invoicePrintFrom(inv: Invoice, fiscal: FiscalSettings, related?: Invoice | null): InvoicePrint | null {
  if (inv.status !== "autorizada" || inv.number === null || !inv.cae) return null;
  const issuedOn = inv.issuedOn ?? inv.createdAt.slice(0, 10);
  return {
    voucherType: inv.voucherType,
    letter: inv.letter,
    pointOfSale: inv.pointOfSale,
    number: inv.number,
    cae: inv.cae,
    caeDue: inv.caeDue ?? "",
    issuedOn,
    issuer: {
      businessName: fiscal.businessName,
      tradeName: fiscal.tradeName,
      cuit: fiscal.cuit,
      taxCondition: fiscal.taxCondition,
      address: fiscal.address,
      grossIncomeNumber: fiscal.grossIncomeNumber,
      activityStart: fiscal.activityStart
    },
    customer: { name: inv.customerName, docType: inv.customerDocType, docNumber: inv.customerDocNumber, taxCondition: inv.customerTaxCondition },
    total: inv.total,
    net: inv.net,
    vat: inv.vat,
    vatRate: inv.vatRate,
    qrUrl: arcaQrUrl({
      issuedOn,
      cuit: fiscal.cuit,
      pointOfSale: inv.pointOfSale,
      voucherType: inv.voucherType,
      number: inv.number,
      total: inv.total,
      docType: inv.customerDocType,
      docNumber: inv.customerDocNumber,
      cae: inv.cae
    }),
    relatedLabel: related ? invoiceLabel(related) : undefined
  };
}

export interface InvoiceItemLine {
  name: string;
  quantity: number;
  unit: "kg" | "unit" | "box";
  unitPrice: number;
  lineTotal: number;
}

/** Renglones de la venta facturada, para reimprimir desde Facturas. */
export async function loadInvoiceItems(inv: Invoice): Promise<InvoiceItemLine[]> {
  if (!supabase) return [];
  if (inv.customerChargeId) {
    const { data, error } = await supabase.rpc("get_customer_charge_items", { p_charge_id: inv.customerChargeId });
    if (error) throw error;
    return ((data ?? []) as { product_name: string; quantity: number; unit_price: number; line_total: number }[]).map((r) => ({
      name: r.product_name,
      quantity: Number(r.quantity),
      unit: "unit" as const,
      unitPrice: Number(r.unit_price),
      lineTotal: Number(r.line_total)
    }));
  }
  if (!inv.posSaleId) return [];
  const { data, error } = await supabase.from("pos_sale_items").select("quantity,unit_price,line_total,description,product_id").eq("sale_id", inv.posSaleId);
  if (error) throw error;
  const rows = (data ?? []) as { quantity: number; unit_price: number; line_total: number; description: string | null; product_id: string | null }[];
  const ids = [...new Set(rows.map((r) => r.product_id).filter((id): id is string => !!id))];
  const products = new Map<string, { name: string; unit: "kg" | "unit" | "box" }>();
  if (ids.length > 0) {
    // products_price_list: los cajeros no leen products (051), esta vista sí y no trae costo.
    const { data: list, error: listError } = await supabase.from("products_price_list").select("id,name,unit").in("id", ids);
    if (listError) throw listError;
    for (const p of (list ?? []) as { id: string; name: string; unit: "kg" | "unit" | "box" }[]) products.set(p.id, { name: p.name, unit: p.unit });
  }
  return rows.map((r) => ({
    name: (r.product_id && products.get(r.product_id)?.name) || r.description || "-",
    quantity: Number(r.quantity),
    unit: (r.product_id && products.get(r.product_id)?.unit) || "unit",
    unitPrice: Number(r.unit_price),
    lineTotal: Number(r.line_total)
  }));
}

/** CUIT/DNI y condición que se usaron en la última factura de este cliente (migración 136). */
export async function getCustomerTaxData(customerId: string): Promise<{ taxId: string; taxCondition: CustomerCondition | null }> {
  if (!supabase) return { taxId: "", taxCondition: null };
  const { data, error } = await supabase.from("customers").select("tax_id,tax_condition").eq("id", customerId).maybeSingle();
  // Antes de la migración 136 las columnas no existen: se arranca vacío.
  if (error || !data) return { taxId: "", taxCondition: null };
  return { taxId: data.tax_id ?? "", taxCondition: data.tax_condition ?? null };
}

export interface ArcaCertificateStatus {
  env: "homo" | "prod";
  /** Alias con el que se da de alta en ARCA (siempre "patagonia"). */
  alias: string;
  /** Carnes Patagonia: factura con el certificado de Patagonia OS, que es de su propio CUIT. */
  usesShared: boolean;
  hasRequest: boolean;
  csrPem: string | null;
  hasCertificate: boolean;
  certExpiresAt: string | null;
}

/** Estado del certificado propio del negocio (migración 137). */
export async function getArcaCertificateStatus(): Promise<ArcaCertificateStatus> {
  return invokeArca({ action: "cert_status" });
}

/** Genera (o devuelve el que ya estaba) el pedido de certificado para subir en ARCA. */
export async function requestArcaCertificate(regenerate = false): Promise<{ csrPem: string; alias: string }> {
  return invokeArca({ action: "cert_request", regenerate });
}

/** Guarda el certificado que el negocio bajó de ARCA (el servidor lo valida contra su pedido). */
export async function uploadArcaCertificate(pem: string): Promise<{ ok: boolean; certExpiresAt: string }> {
  return invokeArca({ action: "cert_upload", pem });
}
