// Armado y lectura de los mensajes de ARCA (WSAA + WSFEv1). Lógica pura, sin
// Deno ni red: la usa la Edge Function `arca-invoice` y la prueban los tests
// de apps/web (src/features/invoicing/arca-voucher.test.ts).
//
// Orden de los campos: el del WSDL de producción (bajado el 2026-10-19). ARCA
// valida la secuencia, así que no hay que reordenarlos.

export type ArcaEnv = "homo" | "prod";

export const ARCA_ENDPOINTS: Record<ArcaEnv, { wsaa: string; wsfe: string }> = {
  homo: {
    wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx"
  },
  prod: {
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://servicios1.afip.gov.ar/wsfev1/service.asmx"
  }
};

/** Código de alícuota de ARCA: 0% = 3, 10,5% = 4, 21% = 5, 27% = 6. */
export function vatRateId(rate: number): number {
  if (rate === 10.5) return 4;
  if (rate === 21) return 5;
  if (rate === 27) return 6;
  return 3;
}

/** Condición frente al IVA del receptor (RG 5616; obligatoria desde el 01/12/2026). */
export const RECEIVER_CONDITION_ID: Record<string, number> = {
  responsable_inscripto: 1,
  exento: 4,
  consumidor_final: 5,
  monotributo: 6
};

/** Nota de crédito que anula cada factura: A (1) → 3, B (6) → 8, C (11) → 13. */
export function creditNoteTypeFor(invoiceType: number): number {
  if (invoiceType === 1) return 3;
  if (invoiceType === 6) return 8;
  if (invoiceType === 11) return 13;
  throw new Error(`Tipo de comprobante sin nota de crédito: ${invoiceType}`);
}

/** Fecha de Argentina (UTC−3, sin horario de verano) como AAAAMMDD. */
export function arDate(at: Date): string {
  return new Date(at.getTime() - 3 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** AAAAMMDD → AAAA-MM-DD */
export function isoFromArcaDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Pedido de ticket de acceso (TRA) para el WSAA, válido ±10 minutos. */
export function loginTicketRequestXml(now: Date, service = "wsfe"): string {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header>` +
    `<uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>` +
    `<generationTime>${iso(new Date(now.getTime() - 600_000))}</generationTime>` +
    `<expirationTime>${iso(new Date(now.getTime() + 600_000))}</expirationTime>` +
    `</header><service>${service}</service></loginTicketRequest>`
  );
}

export function wsaaLoginEnvelope(cmsBase64: string): string {
  return (
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">` +
    `<soapenv:Body><wsaa:loginCms><wsaa:in0>${cmsBase64}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`
  );
}

/** Lee token, sign y vencimiento de la respuesta del WSAA (viene escapada dentro de loginCmsReturn). */
export function parseLoginResponse(xml: string): { token: string; sign: string; expiresAt: string } | { fault: string } {
  const inner = (tag(xml, "loginCmsReturn") ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const token = tag(inner, "token");
  const sign = tag(inner, "sign");
  const expiresAt = tag(inner, "expirationTime");
  if (token && sign && expiresAt) return { token, sign, expiresAt };
  return { fault: tag(xml, "faultstring") ?? "El WSAA no devolvió el ticket de acceso" };
}

export interface ArcaAuth {
  token: string;
  sign: string;
  cuit: string;
}

export function wsfeEnvelope(method: string, auth: ArcaAuth, inner = ""): string {
  return (
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soap:Body>` +
    `<ar:${method}><ar:Auth><ar:Token>${auth.token}</ar:Token><ar:Sign>${auth.sign}</ar:Sign><ar:Cuit>${auth.cuit}</ar:Cuit></ar:Auth>${inner}</ar:${method}>` +
    `</soap:Body></soap:Envelope>`
  );
}

export function lastAuthorizedInner(pointOfSale: number, voucherType: number): string {
  return `<ar:PtoVta>${pointOfSale}</ar:PtoVta><ar:CbteTipo>${voucherType}</ar:CbteTipo>`;
}

export function consultInner(pointOfSale: number, voucherType: number, number: number): string {
  return `<ar:FeCompConsReq><ar:CbteTipo>${voucherType}</ar:CbteTipo><ar:CbteNro>${number}</ar:CbteNro><ar:PtoVta>${pointOfSale}</ar:PtoVta></ar:FeCompConsReq>`;
}

export interface VoucherInput {
  pointOfSale: number;
  voucherType: number;
  number: number;
  /** AAAAMMDD */
  date: string;
  docType: number;
  docNumber: string;
  receiverCondition: string;
  total: number;
  net: number;
  vat: number;
  vatRate: number;
  /** Factura que anula una nota de crédito. */
  related?: { voucherType: number; pointOfSale: number; number: number; cuit: string; date: string };
}

/** Factura C: sin IVA discriminado. A y B (y sus notas de crédito): con el bloque Iva. */
export function hasVatDetail(voucherType: number): boolean {
  return voucherType !== 11 && voucherType !== 13;
}

/** Cuerpo de FECAESolicitar para UN comprobante (concepto 1 = productos, en pesos). */
export function caeRequestInner(v: VoucherInput): string {
  const withVat = hasVatDetail(v.voucherType);
  const net = withVat ? v.net : v.total;
  const vat = withVat ? v.vat : 0;
  const condition = RECEIVER_CONDITION_ID[v.receiverCondition] ?? 5;
  const related = v.related
    ? `<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>${v.related.voucherType}</ar:Tipo><ar:PtoVta>${v.related.pointOfSale}</ar:PtoVta>` +
      `<ar:Nro>${v.related.number}</ar:Nro><ar:Cuit>${v.related.cuit}</ar:Cuit><ar:CbteFch>${v.related.date}</ar:CbteFch></ar:CbteAsoc></ar:CbtesAsoc>`
    : "";
  const iva = withVat
    ? `<ar:Iva><ar:AlicIva><ar:Id>${vatRateId(v.vatRate)}</ar:Id><ar:BaseImp>${money(net)}</ar:BaseImp><ar:Importe>${money(vat)}</ar:Importe></ar:AlicIva></ar:Iva>`
    : "";
  return (
    `<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${v.pointOfSale}</ar:PtoVta><ar:CbteTipo>${v.voucherType}</ar:CbteTipo></ar:FeCabReq>` +
    `<ar:FeDetReq><ar:FECAEDetRequest>` +
    `<ar:Concepto>1</ar:Concepto><ar:DocTipo>${v.docType}</ar:DocTipo><ar:DocNro>${escapeXml(v.docNumber || "0")}</ar:DocNro>` +
    `<ar:CbteDesde>${v.number}</ar:CbteDesde><ar:CbteHasta>${v.number}</ar:CbteHasta><ar:CbteFch>${v.date}</ar:CbteFch>` +
    `<ar:ImpTotal>${money(v.total)}</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc><ar:ImpNeto>${money(net)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>${money(vat)}</ar:ImpIVA>` +
    `<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz><ar:CondicionIVAReceptorId>${condition}</ar:CondicionIVAReceptorId>` +
    related +
    iva +
    `</ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>`
  );
}

/** Contenido del primer <nombre>…</nombre> (con o sin prefijo de espacio de nombres). */
export function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`));
  return m ? m[1].trim() : null;
}

export function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`, "g");
  return Array.from(xml.matchAll(re), (m) => m[1].trim());
}

export interface ArcaMessage {
  code: number;
  msg: string;
}

function messages(xml: string, block: "Err" | "Obs" | "Evt"): ArcaMessage[] {
  return tags(xml, block).map((b) => ({ code: Number(tag(b, "Code") ?? 0), msg: tag(b, "Msg") ?? "" }));
}

export function parseErrors(xml: string): ArcaMessage[] {
  return messages(xml, "Err");
}

export function parseLastAuthorized(xml: string): { number: number | null; errors: ArcaMessage[] } {
  const errors = parseErrors(xml);
  const nro = tag(xml, "CbteNro");
  return { number: nro === null ? null : Number(nro), errors };
}

export interface CaeResult {
  /** A aprobado, R rechazado, P parcial (no se usa con un solo comprobante). */
  result: "A" | "R" | "P" | null;
  cae: string | null;
  /** AAAA-MM-DD */
  caeDue: string | null;
  number: number | null;
  /** AAAAMMDD */
  date: string | null;
  errors: ArcaMessage[];
  observations: ArcaMessage[];
}

export function parseCaeResponse(xml: string): CaeResult {
  const det = tag(xml, "FECAEDetResponse") ?? "";
  const result = (tag(det, "Resultado") ?? tag(xml, "Resultado")) as CaeResult["result"];
  const cae = tag(det, "CAE");
  const due = tag(det, "CAEFchVto");
  const nro = tag(det, "CbteDesde");
  return {
    result: result ?? null,
    cae: cae && cae.length > 0 ? cae : null,
    caeDue: due && /^\d{8}$/.test(due) ? isoFromArcaDate(due) : null,
    number: nro ? Number(nro) : null,
    date: tag(det, "CbteFch"),
    errors: parseErrors(xml),
    observations: messages(det, "Obs")
  };
}

/** FECompConsultar: lo que ARCA tiene guardado de un número (para no duplicar tras un corte). */
export function parseConsultResponse(xml: string): { found: boolean; cae: string | null; caeDue: string | null; total: number | null; docNumber: string | null; date: string | null; errors: ArcaMessage[] } {
  const get = tag(xml, "ResultGet");
  const errors = parseErrors(xml);
  if (!get) return { found: false, cae: null, caeDue: null, total: null, docNumber: null, date: null, errors };
  const due = tag(get, "FchVto");
  return {
    found: true,
    cae: tag(get, "CodAutorizacion"),
    caeDue: due && /^\d{8}$/.test(due) ? isoFromArcaDate(due) : null,
    total: tag(get, "ImpTotal") === null ? null : Number(tag(get, "ImpTotal")),
    docNumber: tag(get, "DocNro"),
    date: tag(get, "CbteFch"),
    errors
  };
}

export interface PointOfSaleInfo {
  number: number;
  kind: string;
  blocked: boolean;
  closed: boolean;
}

export function parsePointsOfSale(xml: string): { points: PointOfSaleInfo[]; errors: ArcaMessage[] } {
  const points = tags(xml, "PtoVenta").map((b) => ({
    number: Number(tag(b, "Nro") ?? 0),
    kind: tag(b, "EmisionTipo") ?? "",
    blocked: (tag(b, "Bloqueado") ?? "N").toUpperCase() === "S",
    closed: (tag(b, "FchBaja") ?? "NULL").toUpperCase() !== "NULL"
  }));
  return { points, errors: parseErrors(xml) };
}

/** Error 10016: el número no es el siguiente (otra caja facturó justo antes). Se reintenta. */
export function isNumberRaceError(errors: ArcaMessage[]): boolean {
  return errors.some((e) => e.code === 10016);
}

/** Lo que ARCA respondió, en palabras para el dueño o la cajera. */
export function friendlyArcaMessage(errors: ArcaMessage[], observations: ArcaMessage[] = []): string {
  const all = [...errors, ...observations];
  if (all.length === 0) return "ARCA rechazó el comprobante sin decir el motivo.";
  const parts = all.map((e) => {
    if (e.code === 600 || e.code === 601 || /no aparec[ií]o cuit en lista de relaciones/i.test(e.msg)) {
      return "ARCA no tiene autorizado el certificado para facturar con este CUIT: falta la relación \"Facturación Electrónica\" en el Administrador de Relaciones de su ARCA (paso 4 de Conectar con ARCA).";
    }
    if (e.code === 602) return "ARCA no tiene datos para ese pedido.";
    if (e.code === 10015 || e.code === 10013) return `El documento del cliente no es válido para ARCA (${e.msg}).`;
    return `${e.msg} (código ${e.code})`;
  });
  return Array.from(new Set(parts)).join(" ");
}

/**
 * Por qué un certificado subido no sirve para este negocio (null = sirve).
 * ARCA firma los de producción como "Computadores" y los de prueba como "Computadores Test".
 */
export function certificateProblem(c: {
  env: ArcaEnv;
  issuerCommonName: string;
  subjectCuit: string;
  expectedCuit: string;
  notAfter: Date;
  now: Date;
  keyMatches: boolean;
}): string | null {
  if (!c.keyMatches) return "Ese certificado no corresponde al último pedido que generaste acá. Subí el que bajaste de ARCA después de cargar ese pedido (o generá uno nuevo).";
  if (c.subjectCuit !== c.expectedCuit) return `Ese certificado es del CUIT ${c.subjectCuit || "(sin CUIT)"}, no del ${c.expectedCuit} de los datos fiscales.`;
  const isTest = /test/i.test(c.issuerCommonName);
  if (c.env === "prod" && isTest) return "Ese es un certificado de PRUEBA de ARCA (homologación). Hace falta el de producción: Administración de Certificados Digitales.";
  if (c.env === "homo" && !isTest) return "Ese certificado es de producción, pero este sistema es de prueba (homologación).";
  if (c.notAfter.getTime() <= c.now.getTime()) return "Ese certificado está vencido. Generá un pedido nuevo y bajá otro certificado.";
  return null;
}
