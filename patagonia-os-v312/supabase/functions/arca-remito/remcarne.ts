// Remito Electrónico Cárnico de ARCA (web service wsremcarne). Lógica pura, sin
// Deno ni red: la usa la Edge Function `arca-remito` y la prueban los tests de
// apps/web (src/features/invoicing/rec/arca-remcarne.test.ts).
//
// Fuentes (bajadas el 2026-11-17):
// - Manual para el Desarrollador WSREMCARNE v3.6 (arca.gob.ar/ws/remitoElecCarnico).
// - WSDL de producción y de homologación (son iguales salvo la dirección).
// El ORDEN de los elementos es el del WSDL: ARCA rechaza los tags fuera de orden
// como error excepcional, así que no hay que reordenarlos.
//
// Lo que el manual NO trae y por eso no se escribe acá a mano: los códigos y
// nombres de las categorías de emisor/receptor, de los estados del remito y de
// los tipos de carne. Se piden a ARCA (consultarTipos*) y se guardan.

export type ArcaEnv = "homo" | "prod";

/** Direcciones del manual (2.1) y del WSDL. */
export const REMCARNE_ENDPOINTS: Record<ArcaEnv, string> = {
  homo: "https://fwshomo.afip.gov.ar/wsremcarne/RemCarneService",
  prod: "https://serviciosjava.afip.gob.ar/wsremcarne/RemCarneService"
};

/** Nombre del servicio para pedir el ticket al WSAA (manual 2.4). */
export const REMCARNE_SERVICE = "wsremcarne";

/** Tipo de comprobante del remito cárnico (manual 2.5.10: "remito cárnico 995"). */
export const REMITO_CARNICO_TIPO = 995;

const NS = "http://ar.gob.afip.wsremcarne/RemCarneService/";

export interface RemcarneAuth {
  token: string;
  sign: string;
  cuit: string;
}

export function soapAction(method: string): string {
  return `"${NS}${method}"`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function el(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

/**
 * Sobre SOAP. El elemento del pedido va con el prefijo del namespace y sus hijos
 * sin prefijo, como en los ejemplos del manual (esquema sin elementFormDefault).
 * `method` = nombre de la operación; el elemento es `<method>Request`.
 */
export function remcarneEnvelope(method: string, auth: RemcarneAuth | null, inner = ""): string {
  const authXml = auth
    ? `<authRequest><token>${auth.token}</token><sign>${auth.sign}</sign><cuitRepresentada>${auth.cuit}</cuitRepresentada></authRequest>`
    : "";
  const body = method === "dummy" ? "" : `<rem:${method}Request>${authXml}${inner}</rem:${method}Request>`;
  return (
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:rem="${NS}">` +
    `<soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`
  );
}

// ---------- datos del remito ----------

export type TipoMovimiento = "ENV" | "REP" | "RED" | "PLA";
export type TipoReceptor = "MI" | "EM";

export interface RecViaje {
  cuitTransportista: string | null;
  cuitConductor: string | null;
  /** AAAA-MM-DD */
  fechaInicioViaje: string;
  distanciaKm: number;
  dominioVehiculo: string | null;
  dominioAcoplado: string | null;
}

export interface RecItem {
  orden: number;
  codTipoProd: string;
  tropa: number | null;
  kilos: number | null;
  unidades: number | null;
}

export interface RecRemitoInput {
  tipoMovimiento: TipoMovimiento;
  categoriaEmisor: number | null;
  puntoEmision: number | null;
  cuitTitularMercaderia: string | null;
  cuitDepositario: string | null;
  tipoReceptor: TipoReceptor | null;
  categoriaReceptor: number | null;
  cuitReceptor: string | null;
  codDomOrigen: number | null;
  codDomDestino: number | null;
  viaje: RecViaje | null;
  items: RecItem[];
  codRemRedestinado: number | null;
}

/** Cantidad con 2 decimales, punto decimal (manual 3.3). Redondeo "half even". */
export function cantidad(n: number): string {
  const scaled = n * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r: number;
  if (Math.abs(diff - 0.5) < 1e-9) r = floor % 2 === 0 ? floor : floor + 1;
  else r = Math.round(scaled);
  return (r / 100).toFixed(2);
}

function viajeXml(v: RecViaje): string {
  const vehiculo = v.dominioVehiculo
    ? `<vehiculo>${el("dominioVehiculo", v.dominioVehiculo.toUpperCase())}${el("dominioAcoplado", v.dominioAcoplado?.toUpperCase())}</vehiculo>`
    : "";
  return (
    `<viaje>${el("cuitTransportista", v.cuitTransportista)}${el("cuitConductor", v.cuitConductor)}` +
    `${el("fechaInicioViaje", v.fechaInicioViaje)}${el("distanciaKm", cantidad(v.distanciaKm))}${vehiculo}</viaje>`
  );
}

/** Cuerpo de generarRemito (orden de RemitoType del WSDL). */
export function generarRemitoInner(idReq: number, r: RecRemitoInput): string {
  const items = r.items
    .map(
      (i) =>
        `<mercaderia>${el("orden", i.orden)}${el("codTipoProd", i.codTipoProd)}${el("tropa", i.tropa)}` +
        `${i.kilos === null ? "" : el("kilos", cantidad(i.kilos))}${i.unidades === null ? "" : el("unidades", cantidad(i.unidades))}</mercaderia>`
    )
    .join("");
  return (
    `${el("idReq", idReq)}<remito>` +
    `${el("tipoComprobante", REMITO_CARNICO_TIPO)}${el("tipoMovimiento", r.tipoMovimiento)}` +
    `${el("categoriaEmisor", r.categoriaEmisor)}${el("puntoEmision", r.puntoEmision)}` +
    `${el("cuitTitularMercaderia", r.cuitTitularMercaderia)}${el("cuitDepositario", r.cuitDepositario)}` +
    `${el("tipoReceptor", r.tipoReceptor)}${el("categoriaReceptor", r.categoriaReceptor)}${el("cuitReceptor", r.cuitReceptor)}` +
    `${el("codDomOrigen", r.codDomOrigen)}${el("codDomDestino", r.codDomDestino)}` +
    `${r.viaje ? viajeXml(r.viaje) : ""}<arrayMercaderias>${items}</arrayMercaderias>` +
    `${el("codRemRedestinado", r.codRemRedestinado)}</remito>`
  );
}

export function emitirRemitoInner(codRemito: number | string): string {
  return el("codRemito", codRemito);
}

export function anularRemitoInner(codRemito: number | string): string {
  return el("codRemito", codRemito);
}

/** consultarRemito por el número que mandamos (idReq) en un punto de emisión (manual 2.5.11). */
export function consultarRemitoPorIdReqInner(idReq: number, puntoEmision: number): string {
  return `${el("idReq", idReq)}${el("puntoEmision", puntoEmision)}`;
}

export function consultarRemitoPorCodigoInner(codRemito: number | string): string {
  return el("codRemito", codRemito);
}

export function consultarUltimoRemitoInner(puntoEmision: number): string {
  return `${el("tipoComprobante", REMITO_CARNICO_TIPO)}${el("puntoEmision", puntoEmision)}`;
}

export function consultarCodigosDomicilioInner(cuit: string): string {
  return el("cuitTitularDomicilio", cuit);
}

export function consultarTiposCarneInner(codGrupoCarne: string): string {
  return el("codGrupoCarne", codGrupoCarne);
}

// ---------- lectura ----------

export function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`));
  return m ? m[1].trim() : null;
}

export function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`, "g");
  return Array.from(xml.matchAll(re), (m) => m[1].trim());
}

function unescape(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export interface CodigoDescripcion {
  codigo: string;
  descripcion: string;
}

/** Lista de <codigoDescripcion> o <codigoDescripcionString> dentro de un array. */
export function codigosDe(xml: string | null): CodigoDescripcion[] {
  if (!xml) return [];
  const blocks = [...tags(xml, "codigoDescripcion"), ...tags(xml, "codigoDescripcionString")];
  return blocks.map((b) => ({ codigo: unescape(tag(b, "codigo") ?? ""), descripcion: unescape(tag(b, "descripcion") ?? "") }));
}

export function parseFault(xml: string): string | null {
  const f = tag(xml, "faultstring");
  return f ? unescape(f) : null;
}

export interface DatosEmision {
  nroRemito: number;
  /** Código de autorización (CRE). Texto: es un long y puede no entrar en un número de JS. */
  codAutorizacion: string;
  fechaEmision: string;
  fechaVencimiento: string;
}

function datosEmisionDe(xml: string): DatosEmision | null {
  const d = tag(xml, "datosEmision");
  if (!d) return null;
  const nro = tag(d, "nroRemito");
  const cod = tag(d, "codAutorizacion");
  const fe = tag(d, "fechaEmision");
  const fv = tag(d, "fechaVencimiento");
  if (!nro || !cod || !fe || !fv) return null;
  return { nroRemito: Number(nro), codAutorizacion: cod, fechaEmision: fe.slice(0, 10), fechaVencimiento: fv.slice(0, 10) };
}

export interface RemitoResult {
  /** A: aprobado, O: observado, R: rechazado. null = no vino (respuesta rara). */
  resultado: "A" | "O" | "R" | null;
  codRemito: string | null;
  puntoEmision: number | null;
  estado: string | null;
  datosEmision: DatosEmision | null;
  /** Imagen del QR en base64, para imprimir en el remito. */
  qr: string | null;
  evento: CodigoDescripcion | null;
  observaciones: CodigoDescripcion[];
  errores: CodigoDescripcion[];
  fault: string | null;
}

/** Lee RemitoReturnType (generarRemito, emitirRemito) o AnularRemitoReturnType. */
export function parseRemitoReturn(xml: string): RemitoResult {
  const fault = parseFault(xml);
  const ret = tag(xml, "generarRemitoReturn") ?? tag(xml, "emitirRemitoReturn") ?? tag(xml, "anularRemitoReturn") ?? "";
  const res = tag(ret, "resultado");
  const evento = tag(ret, "evento");
  const errores = [...codigosDe(tag(ret, "arrayErrores")), ...codigosDe(tag(ret, "arrayErroresFormato"))];
  // datosEmision va adentro del return; el codRemito es el primero del return.
  return {
    resultado: res === "A" || res === "O" || res === "R" ? res : null,
    codRemito: tag(ret, "codRemito"),
    puntoEmision: tag(ret, "puntoEmision") ? Number(tag(ret, "puntoEmision")) : null,
    estado: tag(ret, "estado"),
    datosEmision: datosEmisionDe(ret),
    qr: tag(ret, "qr"),
    evento: evento ? { codigo: tag(evento, "codigo") ?? "", descripcion: unescape(tag(evento, "descripcion") ?? "") } : null,
    observaciones: codigosDe(tag(ret, "arrayObservaciones")),
    errores,
    fault
  };
}

export interface ConsultaResult {
  /** true: ARCA tiene ese remito. false: ARCA respondió y no lo tiene. null: no se puede saber. */
  found: boolean | null;
  idReq: number | null;
  codRemito: string | null;
  estado: string | null;
  datosEmision: DatosEmision | null;
  qr: string | null;
  errores: CodigoDescripcion[];
  fault: string | null;
}

/** Lee ConsultarRemitoReturnType (consultarRemito, consultarUltimoRemitoEmitido). */
export function parseConsultaRemito(xml: string): ConsultaResult {
  const fault = parseFault(xml);
  const ret = tag(xml, "consultarRemitoReturn") ?? tag(xml, "consultarUltimoRemitoReturn");
  if (fault || ret === null) {
    return { found: null, idReq: null, codRemito: null, estado: null, datosEmision: null, qr: null, errores: [], fault: fault ?? "Respuesta de ARCA sin datos" };
  }
  const remito = tag(ret, "remito");
  const errores = [...codigosDe(tag(ret, "arrayErrores")), ...codigosDe(tag(ret, "arrayErroresFormato"))];
  const codRemito = remito ? tag(remito, "codRemito") : null;
  return {
    // Sin remito y con errores de negocio = ARCA contestó que no lo tiene.
    // Sin remito y sin errores: tampoco lo tiene (respuesta vacía).
    found: remito !== null && codRemito !== null ? true : errores.some((e) => /formato/i.test(e.descripcion)) ? null : false,
    idReq: tag(ret, "idReq") ? Number(tag(ret, "idReq")) : null,
    codRemito,
    estado: remito ? tag(remito, "estado") : null,
    datosEmision: remito ? datosEmisionDe(remito) : null,
    qr: tag(ret, "qr"),
    errores,
    fault: null
  };
}

/** Lista simple de consultas de parámetros (categorías, estados, grupos/tipos de carne, puntos, domicilios). */
export function parseLista(xml: string, arrayName: string): { items: CodigoDescripcion[]; errores: CodigoDescripcion[]; fault: string | null } {
  const fault = parseFault(xml);
  return {
    items: codigosDe(tag(xml, arrayName)),
    errores: [...codigosDe(tag(xml, "arrayErrores")), ...codigosDe(tag(xml, "arrayErroresFormato"))],
    fault
  };
}

export function parseDummy(xml: string): { ok: boolean; detail: string } {
  const app = tag(xml, "appserver");
  const auth = tag(xml, "authserver");
  const db = tag(xml, "dbserver");
  return { ok: app === "OK" && auth === "OK" && db === "OK", detail: `app ${app ?? "?"}, auth ${auth ?? "?"}, db ${db ?? "?"}` };
}

export function friendlyRemcarneMessage(r: { errores: CodigoDescripcion[]; observaciones?: CodigoDescripcion[]; fault?: string | null }): string {
  if (r.fault) {
    if (/token|sign|firma|representad/i.test(r.fault)) {
      return `ARCA no aceptó la conexión: ${r.fault}. Revisá que el certificado tenga la relación con el servicio de remito cárnico.`;
    }
    return `ARCA: ${r.fault}`;
  }
  const parts = r.errores.map((e) => `${e.descripcion}${e.codigo ? ` (código ${e.codigo})` : ""}`);
  const obs = (r.observaciones ?? []).map((o) => `Observación: ${o.descripcion}${o.codigo ? ` (${o.codigo})` : ""}`);
  return [...parts, ...obs].join(" · ") || "ARCA no explicó el motivo.";
}

// ---------- reglas del manual (2.5.2.4) que se pueden revisar antes de mandar ----------

/** Tabla de productos con número de tropa obligatorio (manual, tabla "TROPA"). */
const TROPA_OBLIGATORIA = new Set<string>([
  "1.1",
  ...range(2, 10, 23),
  "2.25",
  "2.26",
  "3.8",
  ...range(3, 10, 25),
  "4.1",
  "5.21",
  "5.22",
  "5.23",
  ...range(5, 30, 37),
  "6.25",
  "6.43",
  "6.44",
  "6.45",
  "6.46",
  "13.18",
  "13.30"
]);

function range(table: number, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${table}.${i}`);
  return out;
}

/** "6.24" → 6. null si no tiene el formato tabla.item. */
export function tablaDe(codTipoProd: string): number | null {
  const m = /^(\d{1,2})\.(\d{1,3})$/.exec(codTipoProd.trim());
  return m ? Number(m[1]) : null;
}

export function tropaObligatoria(codTipoProd: string): boolean {
  return TROPA_OBLIGATORIA.has(codTipoProd.trim());
}

export function cuitValido(cuit: string | null | undefined): boolean {
  const d = String(cuit ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = w.reduce((s, x, i) => s + x * Number(d[i]), 0);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) check = 9;
  return check === Number(d[10]);
}

/**
 * Revisa lo que el manual valida en generarRemito, para avisar antes de mandar.
 * Devuelve la lista de problemas (vacía = se puede mandar). ARCA vuelve a validar todo.
 * `hoy` = fecha de Argentina AAAA-MM-DD.
 */
export function problemasDelRemito(r: RecRemitoInput, hoy: string): string[] {
  const p: string[] = [];
  const red = r.tipoMovimiento === "RED";
  if (!red) {
    if (!r.puntoEmision) p.push("Falta el punto de emisión.");
    if (r.categoriaEmisor === null) p.push("Falta la categoría del emisor.");
    if (!r.viaje) p.push("Faltan los datos del viaje.");
    else {
      if (!r.viaje.fechaInicioViaje) p.push("Falta la fecha de inicio del viaje.");
      else if (r.viaje.fechaInicioViaje < hoy) p.push("La fecha de inicio del viaje no puede ser anterior a hoy.");
      if (!(r.viaje.distanciaKm > 0)) p.push("Falta la distancia en km.");
      if (!r.viaje.cuitTransportista) p.push("Falta el CUIT del transportista.");
      else if (!cuitValido(r.viaje.cuitTransportista)) p.push("El CUIT del transportista no es válido.");
      if (r.viaje.cuitConductor && !cuitValido(r.viaje.cuitConductor)) p.push("El CUIT/CUIL del conductor no es válido.");
      if (!r.viaje.dominioVehiculo) p.push("Falta la patente del vehículo.");
    }
  } else if (!r.codRemRedestinado) {
    p.push("En un redestino hay que indicar el remito que se redestina.");
  }
  if (r.tipoMovimiento === "ENV" || r.tipoMovimiento === "RED") {
    if (r.codDomDestino === null) p.push("Falta el domicilio de destino.");
    if (r.tipoReceptor === "MI" && !r.cuitReceptor) p.push("Falta el CUIT del destinatario.");
    if (r.tipoReceptor === "MI" && r.categoriaReceptor === null) p.push("Falta la categoría del destinatario.");
  }
  // A un depósito propio (EM) ARCA rechaza el CUIT del receptor: error 1312 "No se debe informar la CUIT del
  // receptor" (respuesta real de producción, 2026-11-18). El destino es el emisor mismo.
  if (r.tipoReceptor === "EM" && r.cuitReceptor) p.push("A un depósito propio no se informa el CUIT del destinatario.");
  if (r.tipoMovimiento === "REP" && (r.tipoReceptor || r.cuitReceptor || r.codDomDestino !== null || r.categoriaReceptor !== null)) {
    p.push("En un reparto no se informa destinatario ni domicilio de destino.");
  }
  if (r.cuitReceptor && !cuitValido(r.cuitReceptor)) p.push("El CUIT del destinatario no es válido.");
  if (r.cuitDepositario) {
    if (r.cuitTitularMercaderia && r.cuitDepositario === r.cuitTitularMercaderia) p.push("El depositario no puede ser el mismo emisor.");
    if (r.codDomOrigen === null) p.push("Si sale del depósito de un tercero, falta el domicilio de origen.");
  } else if (r.codDomOrigen !== null) {
    p.push("Sin depositario, el origen es el domicilio del punto de emisión: no se indica.");
  }
  if (r.items.length === 0) p.push("Agregá al menos un producto.");
  r.items.forEach((i, idx) => {
    const n = `Renglón ${idx + 1}`;
    const tabla = tablaDe(i.codTipoProd);
    if (tabla === null) {
      p.push(`${n}: el código de mercadería tiene la forma tabla.item (por ejemplo 6.24).`);
      return;
    }
    if (tropaObligatoria(i.codTipoProd) && !i.tropa) p.push(`${n}: ese producto lleva número de tropa.`);
    if (tabla <= 6 && !(i.kilos !== null && i.kilos > 0)) p.push(`${n}: ese producto lleva kilos.`);
    if (tabla >= 7 && !((i.kilos ?? 0) > 0 || (i.unidades ?? 0) > 0)) p.push(`${n}: indicá kilos o unidades.`);
    if ((i.kilos ?? 0) > 999999.99 || (i.unidades ?? 0) > 999999.99) p.push(`${n}: cantidad demasiado grande.`);
  });
  return p;
}
