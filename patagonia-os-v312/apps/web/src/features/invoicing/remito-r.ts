// Remito R con CAI (migración 147, plan Full). Lógica pura (testeada): leer las
// filas, estado de cada CAI y validar el formulario igual que save_remito_cai.

export interface RemitoCai {
  id: string;
  pointOfSale: number;
  cai: string;
  caiDue: string;
  numberFrom: number;
  numberTo: number;
  active: boolean;
}

export interface RemitoItem {
  description: string;
  code: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Remito {
  id: string;
  caiId: string;
  pointOfSale: number;
  number: number;
  cai: string;
  caiDue: string;
  issuedOn: string;
  customerChargeId: string | null;
  issuer: {
    businessName: string;
    tradeName: string | null;
    cuit: string;
    taxCondition: string | null;
    address: string | null;
    grossIncomeNumber: string | null;
    activityStart: string | null;
  };
  receiver: {
    name: string;
    number: number | null;
    taxId: string | null;
    taxCondition: string | null;
    /** Domicilio comercial del destinatario (Anexo V, II). */
    address: string | null;
    locality: string | null;
    province: string | null;
  };
  items: RemitoItem[];
  showValues: boolean;
  total: number;
  deliveryAddress: string | null;
  /** Transportista tercero (Anexo V, IV). null = transporte propio. */
  carrier: RemitoCarrier | null;
  notes: string | null;
  status: "emitido" | "anulado";
  createdAt: string;
}

export interface RemitoCarrier {
  name: string;
  cuit: string | null;
  address: string | null;
}

/** La 148 guarda el transportista como JSON; la 147 guardaba un texto libre. */
export function parseCarrier(raw: unknown): RemitoCarrier | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw);
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (o && typeof o === "object" && o.name) return { name: String(o.name), cuit: str(o.cuit), address: str(o.address) };
  } catch {
    // Texto libre de un remito viejo.
  }
  return { name: text, cuit: null, address: null };
}

/** Código ARCA del Remito R. */
export const REMITO_R_CODE = "91";

const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

export function parseRemitoCai(row: Record<string, unknown>): RemitoCai {
  return {
    id: String(row.id),
    pointOfSale: Number(row.point_of_sale),
    cai: String(row.cai ?? ""),
    caiDue: String(row.cai_due ?? "").slice(0, 10),
    numberFrom: Number(row.number_from),
    numberTo: Number(row.number_to),
    active: row.active !== false
  };
}

export function parseRemito(row: Record<string, unknown>): Remito {
  const issuer = (row.issuer ?? {}) as Record<string, unknown>;
  const receiver = (row.receiver ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    caiId: String(row.cai_id ?? ""),
    pointOfSale: Number(row.point_of_sale),
    number: Number(row.number),
    cai: String(row.cai ?? ""),
    caiDue: String(row.cai_due ?? "").slice(0, 10),
    issuedOn: String(row.issued_on ?? "").slice(0, 10),
    customerChargeId: str(row.customer_charge_id),
    issuer: {
      businessName: String(issuer.business_name ?? ""),
      tradeName: str(issuer.trade_name),
      cuit: String(issuer.cuit ?? ""),
      taxCondition: str(issuer.tax_condition),
      address: str(issuer.address),
      grossIncomeNumber: str(issuer.gross_income_number),
      activityStart: str(issuer.activity_start)
    },
    receiver: {
      name: String(receiver.name ?? ""),
      number: receiver.number === null || receiver.number === undefined ? null : Number(receiver.number),
      taxId: str(receiver.tax_id),
      taxCondition: str(receiver.tax_condition),
      address: str(receiver.address),
      locality: str(receiver.locality),
      province: str(receiver.province)
    },
    items: ((row.items ?? []) as Array<Record<string, unknown>>).map((i) => ({
      description: String(i.description ?? ""),
      code: str(i.code),
      unit: str(i.unit),
      quantity: Number(i.quantity ?? 0),
      unitPrice: Number(i.unit_price ?? 0),
      lineTotal: Number(i.line_total ?? 0)
    })),
    showValues: Boolean(row.show_values),
    total: Number(row.total ?? 0),
    deliveryAddress: str(row.delivery_address),
    carrier: parseCarrier(row.carrier),
    notes: str(row.notes),
    status: row.status === "anulado" ? "anulado" : "emitido",
    createdAt: String(row.created_at ?? "")
  };
}

export type CaiState = "vigente" | "vencido" | "agotado" | "dado_de_baja";

export interface CaiStatus {
  state: CaiState;
  used: number;
  remaining: number;
  /** Días hasta el vencimiento (0 = vence hoy). Negativo si ya venció. */
  daysLeft: number;
  /** Vigente pero vence en 15 días o menos, o le quedan 20 números o menos. */
  warn: boolean;
}

const dayMs = 86_400_000;
const isoDays = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / dayMs);

/** `lastNumber`: el número más alto ya emitido en ese punto de venta (null si ninguno). */
export function caiStatus(cai: RemitoCai, lastNumber: number | null, todayIso: string): CaiStatus {
  const next = Math.max(cai.numberFrom, (lastNumber ?? 0) + 1);
  const remaining = Math.max(cai.numberTo - next + 1, 0);
  const used = Math.min(Math.max(next - cai.numberFrom, 0), cai.numberTo - cai.numberFrom + 1);
  const daysLeft = isoDays(cai.caiDue) - isoDays(todayIso);
  const state: CaiState = !cai.active ? "dado_de_baja" : daysLeft < 0 ? "vencido" : remaining === 0 ? "agotado" : "vigente";
  return { state, used, remaining, daysLeft, warn: state === "vigente" && (daysLeft <= 15 || remaining <= 20) };
}

/** ¿Hay algún CAI con el que se pueda emitir hoy? */
export function canIssueRemito(cais: RemitoCai[], lastByPos: Map<number, number>, todayIso: string): boolean {
  return cais.some((c) => caiStatus(c, lastByPos.get(c.pointOfSale) ?? null, todayIso).state === "vigente");
}

/** Último número emitido por punto de venta (anulados incluidos: su número no se reusa). */
export function lastNumberByPointOfSale(remitos: Pick<Remito, "pointOfSale" | "number">[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const r of remitos) map.set(r.pointOfSale, Math.max(map.get(r.pointOfSale) ?? 0, r.number));
  return map;
}

export interface CaiForm {
  pointOfSale: string;
  cai: string;
  caiDue: string;
  numberFrom: string;
  numberTo: string;
}

/** Mismas reglas que save_remito_cai, para avisar antes de mandar. null = está bien. */
export function validateCaiForm(f: CaiForm, todayIso: string): string | null {
  const pos = Number(f.pointOfSale);
  if (!Number.isInteger(pos) || pos < 1 || pos > 99999) return "El punto de venta va de 1 a 99999.";
  if (f.cai.replace(/\D/g, "").length !== 14) return "El CAI tiene 14 números.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.caiDue)) return "Elegí la fecha de vencimiento del CAI.";
  if (f.caiDue < todayIso) return "La fecha de vencimiento del CAI ya pasó.";
  const from = Number(f.numberFrom);
  const to = Number(f.numberTo);
  if (!Number.isInteger(from) || from < 1) return "El número desde tiene que ser 1 o más.";
  if (!Number.isInteger(to) || to < from || to > 99_999_999) return "El número hasta tiene que ser mayor o igual que desde.";
  return null;
}

const UNIT_SHORT: Record<string, string> = { kg: "kg", unit: "u.", box: "caja" };

export function remitoQuantityLabel(item: Pick<RemitoItem, "quantity" | "unit">): string {
  const unit = item.unit ? UNIT_SHORT[item.unit] ?? item.unit : "";
  const qty = item.quantity.toLocaleString("es-AR", { maximumFractionDigits: 3 });
  return unit ? `${qty} ${unit}` : qty;
}

/** Leyendas literales del Anexo V de la RG 1415 (I, a, 5 y II). */
export const ISSUER_LEGEND: Record<string, string> = {
  responsable_inscripto: "IVA RESPONSABLE INSCRITO",
  exento: "IVA EXENTO",
  monotributo: "RESPONSABLE MONOTRIBUTO"
};

export const RECEIVER_LEGEND: Record<string, string> = {
  responsable_inscripto: "IVA RESPONSABLE INSCRITO",
  exento: "IVA EXENTO",
  monotributo: "RESPONSABLE MONOTRIBUTO",
  consumidor_final: "A CONSUMIDOR FINAL"
};

/** Desde este importe, a consumidor final se identifica al destinatario (Anexo V, II, d, 2). */
export const CONSUMER_ID_THRESHOLD = 5000;

export interface RemitoIssueForm {
  condition: "consumidor_final" | "responsable_inscripto" | "monotributo" | "exento";
  doc: string;
  address: string;
  thirdPartyCarrier: boolean;
  carrierName: string;
  carrierCuit: string;
  carrierAddress: string;
}

/** Mismas reglas que issue_remito (migración 148). null = está bien. */
export function validateRemitoIssue(f: RemitoIssueForm, amount: number): string | null {
  const doc = f.doc.replace(/\D/g, "");
  if (f.condition !== "consumidor_final") {
    if (!f.address.trim()) return "Falta el domicilio comercial del cliente.";
    if (doc.length !== 11) return "Falta el CUIT del cliente (11 números).";
  } else if (amount >= CONSUMER_ID_THRESHOLD && (!f.address.trim() || !doc)) {
    return "A consumidor final, desde $5.000 el remito lleva domicilio y CUIT, CUIL o DNI del cliente.";
  }
  if (f.thirdPartyCarrier) {
    if (!f.carrierName.trim() || !f.carrierAddress.trim() || f.carrierCuit.replace(/\D/g, "").length !== 11) {
      return "Del transportista van nombre o razón social, domicilio comercial y CUIT (11 números).";
    }
  }
  return null;
}

/** ¿El remito identifica al destinatario o va solo "A CONSUMIDOR FINAL"? */
export function receiverIdentified(r: Pick<Remito, "receiver" | "total">): boolean {
  return r.receiver.taxCondition !== "consumidor_final" || Boolean(r.receiver.taxId) || Boolean(r.receiver.address) || r.total >= CONSUMER_ID_THRESHOLD;
}
