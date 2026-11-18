// Remito Electrónico Cárnico (migración 202). Lógica pura de la pantalla: leer
// filas, armar el pedido para create_rec_remito y revisar las reglas del manual
// de ARCA antes de mandar (las mismas que usa la Edge Function, en remcarne.ts).
import { problemasDelRemito, type RecRemitoInput } from "../../../../../supabase/functions/arca-remito/remcarne";

export type RecStatus = "pendiente" | "incierto" | "generado" | "emitido" | "rechazado" | "anulado" | "descartado";

export interface CodigoDescripcion {
  codigo: string;
  descripcion: string;
}

export interface RecCatalog {
  env?: string;
  fetchedAt?: string;
  puntosEmision: CodigoDescripcion[];
  categoriasEmisor: CodigoDescripcion[];
  categoriasReceptor: CodigoDescripcion[];
  estados: CodigoDescripcion[];
  grupos: CodigoDescripcion[];
  tiposCarne: Array<CodigoDescripcion & { grupo: string }>;
  domiciliosPropios: CodigoDescripcion[];
}

export interface RecSettings {
  categoriaEmisor: number | null;
  categoriaEmisorDesc: string | null;
  enabled: boolean;
  catalog: RecCatalog;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
}

export interface RecPoint {
  id: string;
  pointOfEmission: number;
  branchId: string | null;
  label: string | null;
  active: boolean;
  arcaDescription: string | null;
}

export interface RecItem {
  orden: number;
  productName: string | null;
  codTipoProd: string;
  tropa: number | null;
  kilos: number | null;
  unidades: number | null;
}

export interface RecRemito {
  id: string;
  branchId: string | null;
  pointOfEmission: number;
  idReq: number;
  tipoMovimiento: "ENV" | "REP" | "PLA";
  cuitEmisor: string;
  tipoReceptor: "MI" | "EM" | null;
  categoriaReceptor: number | null;
  cuitReceptor: string | null;
  receptorName: string | null;
  codDomDestino: number | null;
  destinoDesc: string | null;
  motivo: string | null;
  cuitTransportista: string | null;
  transportistaName: string | null;
  cuitConductor: string | null;
  fechaInicioViaje: string | null;
  distanciaKm: number | null;
  dominioVehiculo: string | null;
  dominioAcoplado: string | null;
  issuer: { businessName?: string; cuit?: string; address?: string | null; pointLabel?: string | null; pointDescription?: string | null; categoriaEmisorDesc?: string | null };
  status: RecStatus;
  arcaEstado: string | null;
  codRemito: string | null;
  nroRemito: number | null;
  codAutorizacion: string | null;
  fechaEmision: string | null;
  fechaVencimiento: string | null;
  qrBase64: string | null;
  errorMessage: string | null;
  env: string | null;
  notes: string | null;
  createdAt: string;
  items: RecItem[];
}

const EMPTY_CATALOG: RecCatalog = {
  puntosEmision: [],
  categoriasEmisor: [],
  categoriasReceptor: [],
  estados: [],
  grupos: [],
  tiposCarne: [],
  domiciliosPropios: []
};

type R = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export function parseRecSettings(row: R | null): RecSettings {
  const c = (row?.catalog ?? {}) as Partial<RecCatalog>;
  return {
    categoriaEmisor: num(row?.categoria_emisor),
    categoriaEmisorDesc: str(row?.categoria_emisor_desc),
    enabled: Boolean(row?.enabled),
    catalog: { ...EMPTY_CATALOG, ...c },
    lastCheckAt: str(row?.last_check_at),
    lastCheckOk: row?.last_check_ok === null || row?.last_check_ok === undefined ? null : Boolean(row.last_check_ok),
    lastCheckMessage: str(row?.last_check_message)
  };
}

export function parseRecPoint(row: R): RecPoint {
  return {
    id: String(row.id),
    pointOfEmission: Number(row.point_of_emission),
    branchId: str(row.branch_id),
    label: str(row.label),
    active: Boolean(row.active),
    arcaDescription: str(row.arca_description)
  };
}

export function parseRecRemito(row: R): RecRemito {
  const items = Array.isArray(row.rec_remito_items) ? (row.rec_remito_items as R[]) : [];
  return {
    id: String(row.id),
    branchId: str(row.branch_id),
    pointOfEmission: Number(row.point_of_emission),
    idReq: Number(row.id_req),
    tipoMovimiento: row.tipo_movimiento as RecRemito["tipoMovimiento"],
    cuitEmisor: String(row.cuit_emisor ?? ""),
    tipoReceptor: (str(row.tipo_receptor) as RecRemito["tipoReceptor"]) ?? null,
    categoriaReceptor: num(row.categoria_receptor),
    cuitReceptor: str(row.cuit_receptor),
    receptorName: str(row.receptor_name),
    codDomDestino: num(row.cod_dom_destino),
    destinoDesc: str(row.destino_desc),
    motivo: str(row.motivo),
    cuitTransportista: str(row.cuit_transportista),
    transportistaName: str(row.transportista_name),
    cuitConductor: str(row.cuit_conductor),
    fechaInicioViaje: str(row.fecha_inicio_viaje),
    distanciaKm: num(row.distancia_km),
    dominioVehiculo: str(row.dominio_vehiculo),
    dominioAcoplado: str(row.dominio_acoplado),
    issuer: (() => {
      const i = (row.issuer ?? {}) as R;
      return {
        businessName: str(i.business_name) ?? undefined,
        cuit: str(i.cuit) ?? undefined,
        address: str(i.address),
        pointLabel: str(i.point_label),
        pointDescription: str(i.point_description),
        categoriaEmisorDesc: str(i.categoria_emisor_desc)
      };
    })(),
    status: row.status as RecStatus,
    arcaEstado: str(row.arca_estado),
    codRemito: str(row.cod_remito),
    nroRemito: num(row.nro_remito),
    codAutorizacion: str(row.cod_autorizacion),
    fechaEmision: str(row.fecha_emision),
    fechaVencimiento: str(row.fecha_vencimiento),
    qrBase64: str(row.qr_base64),
    errorMessage: str(row.error_message),
    env: str(row.env),
    notes: str(row.notes),
    createdAt: String(row.created_at ?? ""),
    items: items
      .map((i) => ({
        orden: Number(i.orden),
        productName: str(i.product_name),
        codTipoProd: String(i.cod_tipo_prod),
        tropa: num(i.tropa),
        kilos: num(i.kilos),
        unidades: num(i.unidades)
      }))
      .sort((a, b) => a.orden - b.orden)
  };
}

export const STATUS_LABEL: Record<RecStatus, string> = {
  pendiente: "Sin mandar",
  incierto: "Sin confirmar",
  generado: "Generado, sin emitir",
  emitido: "Emitido",
  rechazado: "Rechazado por ARCA",
  anulado: "Anulado",
  descartado: "Descartado"
};

export const MOVIMIENTO_LABEL = { ENV: "Envío", PLA: "Retiro en planta", REP: "Reparto" } as const;

/** Nombre del estado que devolvió ARCA (consultarTiposEstado), o el código. */
export function arcaEstadoLabel(code: string | null, catalog: RecCatalog): string | null {
  if (!code) return null;
  return catalog.estados.find((e) => e.codigo === code)?.descripcion ?? code;
}

/** Qué botones tiene cada estado. */
export function recActions(status: RecStatus): Array<"send" | "retry" | "refresh" | "emit" | "void" | "discard" | "print"> {
  switch (status) {
    case "pendiente":
      return ["send", "discard"];
    case "incierto":
      return ["retry"];
    case "generado":
      return ["refresh", "emit", "void"];
    case "emitido":
      return ["print", "refresh"];
    case "rechazado":
      return ["discard"];
    default:
      return [];
  }
}

/** Número del remito como el de los comprobantes: 00020-00000015. */
export function recNumberLabel(point: number, nro: number | null): string {
  if (nro === null) return `${String(point).padStart(5, "0")}-…`;
  return `${String(point).padStart(5, "0")}-${String(nro).padStart(8, "0")}`;
}

// ---------- formulario ----------

export interface RecItemForm {
  key: string;
  productId: string;
  productName: string;
  codTipoProd: string;
  tropa: string;
  kilos: string;
  unidades: string;
}

export interface RecForm {
  pointOfEmission: string;
  tipoMovimiento: "ENV" | "PLA" | "REP";
  destino: "propio" | "cliente";
  destinationBranchId: string;
  customerId: string;
  cuitReceptor: string;
  receptorName: string;
  categoriaReceptor: string;
  codDomDestino: string;
  destinoDesc: string;
  motivo: string;
  cuitTransportista: string;
  transportistaName: string;
  cuitConductor: string;
  dominioVehiculo: string;
  dominioAcoplado: string;
  fechaInicioViaje: string;
  distanciaKm: string;
  notes: string;
  items: RecItemForm[];
}

const digits = (s: string) => s.replace(/\D/g, "");
const qty = (s: string): number | null => {
  const t = s.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/** El mismo remito en la forma que lo valida el manual (para avisar antes de mandar). */
export function formToRemcarne(f: RecForm, cuitEmisor: string, categoriaEmisor: number | null): RecRemitoInput {
  const rep = f.tipoMovimiento === "REP";
  const propio = f.destino === "propio";
  return {
    tipoMovimiento: f.tipoMovimiento,
    categoriaEmisor,
    puntoEmision: f.pointOfEmission ? Number(f.pointOfEmission) : null,
    cuitTitularMercaderia: cuitEmisor,
    cuitDepositario: null,
    tipoReceptor: rep ? null : propio ? "EM" : "MI",
    categoriaReceptor: rep || propio || f.categoriaReceptor === "" ? null : Number(f.categoriaReceptor),
    cuitReceptor: rep ? null : propio ? cuitEmisor : digits(f.cuitReceptor) || null,
    codDomOrigen: null,
    codDomDestino: rep || f.tipoMovimiento === "PLA" || f.codDomDestino === "" ? null : Number(f.codDomDestino),
    viaje: {
      cuitTransportista: digits(f.cuitTransportista) || null,
      cuitConductor: digits(f.cuitConductor) || null,
      fechaInicioViaje: f.fechaInicioViaje,
      distanciaKm: qty(f.distanciaKm) ?? 0,
      dominioVehiculo: f.dominioVehiculo.replace(/\s/g, "") || null,
      dominioAcoplado: f.dominioAcoplado.replace(/\s/g, "") || null
    },
    items: f.items.map((i, idx) => ({
      orden: idx + 1,
      codTipoProd: i.codTipoProd.trim(),
      tropa: i.tropa.trim() ? Number(digits(i.tropa)) : null,
      kilos: qty(i.kilos),
      unidades: qty(i.unidades)
    })),
    codRemRedestinado: null
  };
}

/** Problemas del formulario (vacío = se puede emitir). */
export function recFormProblems(f: RecForm, cuitEmisor: string, categoriaEmisor: number | null, today: string): string[] {
  const p: string[] = [];
  if (f.items.some((i) => Number.isNaN(qty(i.kilos)) || Number.isNaN(qty(i.unidades)))) p.push("Revisá los kilos y unidades: tienen que ser números.");
  if (Number.isNaN(qty(f.distanciaKm))) p.push("La distancia tiene que ser un número.");
  if (f.tipoMovimiento === "PLA" && f.destino === "propio") p.push("El retiro en planta es para un cliente que retira.");
  return [...p, ...problemasDelRemito(formToRemcarne(f, cuitEmisor, categoriaEmisor), today)];
}

/** Pedido para create_rec_remito. */
export function formToPayload(f: RecForm, cuitEmisor: string): Record<string, unknown> {
  const r = formToRemcarne(f, cuitEmisor, null);
  return {
    point_of_emission: r.puntoEmision,
    tipo_movimiento: r.tipoMovimiento,
    tipo_receptor: r.tipoReceptor,
    categoria_receptor: r.categoriaReceptor,
    cuit_receptor: r.cuitReceptor,
    receptor_name: f.receptorName.trim() || null,
    cod_dom_destino: r.codDomDestino,
    destino_desc: f.destinoDesc.trim() || null,
    destination_branch_id: f.destino === "propio" && f.destinationBranchId ? f.destinationBranchId : null,
    customer_id: f.destino === "cliente" && f.customerId ? f.customerId : null,
    motivo: f.motivo.trim() || null,
    cuit_transportista: r.viaje?.cuitTransportista,
    transportista_name: f.transportistaName.trim() || null,
    cuit_conductor: r.viaje?.cuitConductor,
    fecha_inicio_viaje: r.viaje?.fechaInicioViaje,
    distancia_km: r.viaje?.distanciaKm,
    dominio_vehiculo: r.viaje?.dominioVehiculo,
    dominio_acoplado: r.viaje?.dominioAcoplado,
    notes: f.notes.trim() || null,
    items: f.items.map((i, idx) => ({
      product_id: i.productId || null,
      product_name: i.productName.trim() || null,
      cod_tipo_prod: r.items[idx].codTipoProd,
      tropa: r.items[idx].tropa,
      kilos: r.items[idx].kilos,
      unidades: r.items[idx].unidades
    }))
  };
}

/** Busca tipos de carne por código ("6.24") o por palabras ("cuadril sin"). */
export function searchTiposCarne(catalog: RecCatalog, text: string, limit = 12): Array<CodigoDescripcion & { grupo: string }> {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const exact = catalog.tiposCarne.filter((t) => t.codigo === q);
  const words = q.split(/\s+/);
  const rest = catalog.tiposCarne.filter((t) => t.codigo !== q && words.every((w) => `${t.codigo} ${t.descripcion}`.toLowerCase().includes(w)));
  return [...exact, ...rest].slice(0, limit);
}
