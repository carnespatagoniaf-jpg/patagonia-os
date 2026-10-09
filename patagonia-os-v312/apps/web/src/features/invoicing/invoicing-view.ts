// Lógica pura de la factura electrónica (sin Supabase, para probarla con node --test).
// Las mismas reglas las vuelve a chequear la base (request_invoice, migración 113):
// esto es para avisarle a la cajera ANTES de cobrar, no para reemplazar al servidor.

export type IssuerCondition = "monotributo" | "responsable_inscripto";
export type CustomerCondition = "consumidor_final" | "responsable_inscripto" | "monotributo" | "exento";
export type InvoiceLetter = "A" | "B" | "C";

export const CUSTOMER_CONDITION_LABEL: Record<CustomerCondition, string> = {
  consumidor_final: "Consumidor final",
  responsable_inscripto: "Responsable inscripto",
  monotributo: "Monotributista",
  exento: "Exento"
};

export const ISSUER_CONDITION_LABEL: Record<IssuerCondition, string> = {
  monotributo: "Monotributo",
  responsable_inscripto: "Responsable inscripto"
};

/** Desde este total, a un consumidor final hay que identificarlo (RG 5700/2025). */
export const IDENTIFY_FROM = 10_000_000;

export function digitsOnly(text: string): string {
  return text.replace(/\D/g, "");
}

/** Dígito verificador del CUIT/CUIL (módulo 11, pesos 5-4-3-2-7-6-5-4-3-2). */
export function isValidCuit(raw: string): boolean {
  const cuit = digitsOnly(raw);
  if (!/^\d{11}$/.test(cuit)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(cuit[i]), 0);
  const mod = 11 - (sum % 11);
  const check = mod === 11 ? 0 : mod === 10 ? 9 : mod;
  return check === Number(cuit[10]);
}

/** 27182448902 → 27-18244890-2 */
export function formatCuit(raw: string): string {
  const cuit = digitsOnly(raw);
  return cuit.length === 11 ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}` : raw;
}

/** Qué letra sale: monotributo siempre C; inscripto A a inscriptos/monotributistas y B al resto. */
export function invoiceLetterFor(issuer: IssuerCondition, customer: CustomerCondition): InvoiceLetter {
  if (issuer === "monotributo") return "C";
  return customer === "responsable_inscripto" || customer === "monotributo" ? "A" : "B";
}

export interface InvoiceDraft {
  wanted: boolean;
  customerCondition: CustomerCondition;
  doc: string;
  name: string;
}

export const emptyInvoiceDraft = (): InvoiceDraft => ({ wanted: false, customerCondition: "consumidor_final", doc: "", name: "" });

/** null si se puede pedir; si no, el motivo en palabras de la cajera. */
export function invoiceDraftError(issuer: IssuerCondition, draft: InvoiceDraft, total: number): string | null {
  if (!draft.wanted) return null;
  const doc = digitsOnly(draft.doc);
  if (doc !== "" && !(doc.length === 11 || doc.length === 7 || doc.length === 8)) {
    return "El documento del cliente tiene que ser un CUIT (11 números) o un DNI (7 u 8).";
  }
  if (doc.length === 11 && !isValidCuit(doc)) return "El CUIT del cliente no es válido: revisá los números.";
  const letter = invoiceLetterFor(issuer, draft.customerCondition);
  if (letter === "A" && doc.length !== 11) return "Para Factura A hace falta el CUIT del cliente.";
  if (doc === "" && total >= IDENTIFY_FROM) return "Desde $10.000.000 hay que poner el DNI o CUIT del cliente.";
  return null;
}

export interface InvoiceLike {
  kind: "factura" | "nota_credito";
  letter: InvoiceLetter;
  pointOfSale: number;
  number: number | null;
}

/** "Factura B 00005-00000123", o "Factura B (pendiente)" mientras ARCA no la autoriza. */
export function invoiceLabel(inv: InvoiceLike): string {
  const name = inv.kind === "nota_credito" ? "Nota de crédito" : "Factura";
  if (inv.number === null) return `${name} ${inv.letter} (sin número todavía)`;
  return `${name} ${inv.letter} ${String(inv.pointOfSale).padStart(5, "0")}-${String(inv.number).padStart(8, "0")}`;
}
