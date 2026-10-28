import type { ScaleModelId } from "./capabilities";
import type { PendingReason } from "./matching";

/**
 * Motor de "Mi balanza": un solo recorrido para cualquier marca.
 *
 *   detectar → leer → comparar → (vincular) → escribir → verificar
 *
 * Cada marca es un adaptador (`adapters/`) que reutiliza el código de protocolo que ya funciona en producción.
 * La pantalla solo conoce estos tipos: nunca puertos, velocidades ni protocolos.
 */

export interface EngineProduct {
  id: string;
  code: string;
  name: string;
  unit: string;
  priceRetail: number;
  active?: boolean;
}

export type EngineStep = "permiso" | "buscar" | "leer" | "comparar" | "sincronizar" | "verificar";

export type ProgressFn = (step: EngineStep, text: string, done?: number, total?: number) => void;

export interface PendingItem {
  code: number;
  scaleName: string;
  byWeight: boolean;
  reason: PendingReason | "ocupado_en_balanza";
  detail: string;
  suggestionId: string | null;
}

export interface PreparedSync {
  model: ScaleModelId;
  /** "Systel Cuora Max", "Kretz Aura"… */
  label: string;
  /** Productos que tiene la balanza (o que se van a mandar, en las que reciben productos desde Patagonia). */
  scaleProducts: number;
  /** Listos para vender: vinculados (de antes o recién) o ya iguales en la balanza. */
  ready: number;
  /** Cambios que hay que escribir en la balanza al sincronizar. */
  writes: number;
  /** Vínculos nuevos que se guardan al sincronizar (no tocan la balanza). */
  newLinks: number;
  pending: PendingItem[];
  /** Productos cuyo precio en la balanza no es el de Patagonia (solo se informa). */
  priceDiffs: number;
  /** false = esta balanza solo se lee: no se escribe nada en ella. */
  canWrite: boolean;
  /** true = no hay nada que hacer: ya está todo listo. */
  upToDate: boolean;
  /** Avisos en palabras simples. */
  notes: string[];
  /** Algo que la persona tiene que hacer en la balanza antes de seguir (no hay botón de sincronizar). */
  blocker?: string;
  /** Productos de Patagonia que no van a la balanza, cada uno con el motivo (código largo, sin precio, centavos…). */
  skipped?: ProductProblem[];
  /** Se mandan, pero conviene saberlo antes (por ejemplo, cómo queda el nombre en la balanza). */
  warnings?: ProductProblem[];
}

/** Un producto puntual y por qué no se mandó o no quedó bien, en palabras simples. */
export interface ProductProblem {
  code: string;
  name: string;
  reason: string;
}

export interface SyncOutcome {
  ok: boolean;
  /** Productos escritos y releídos iguales. */
  verified: number;
  /** Mensaje para el cliente. */
  message: string;
  /** Lo que quedó para revisar. */
  pending: PendingItem[];
  /** Productos que NO quedaron bien en la balanza, cada uno con el motivo (se muestran al cliente). */
  failures?: ProductProblem[];
  /** Detalle para soporte (nunca se muestra al cliente). */
  support?: Record<string, unknown>;
}

export interface ScaleSession {
  model: ScaleModelId;
  label: string;
  prepare(onProgress: ProgressFn): Promise<PreparedSync>;
  /** Escribe (solo lo comprobado), verifica y guarda en Patagonia. `allowReplace` = la persona autorizó reemplazar lo ocupado. */
  sync(prepared: PreparedSync, onProgress: ProgressFn, opts?: { allowReplace?: boolean }): Promise<SyncOutcome>;
  close(): Promise<void>;
  /** Datos técnicos de la conexión para soporte. */
  supportInfo(): Record<string, unknown>;
  /** Lo que contestó la balanza y la distingue de otra igual (número de balanza, letra de equipo). */
  identity?(): Record<string, unknown>;
  /** Cómo imprime los códigos según su configuración leída (Systel: E_P, E_U, E_S), o null. */
  codeFormats?(): { weighed: string | null; unit: string | null; total: string | null } | null;
}

/** Lo técnico de un intento de conexión, para el reporte a soporte (nunca se muestra al cliente). */
export interface ConnectDiag {
  /** "0403:6001" del cable elegido. */
  usb: string | null;
  /** Puertos autorizados en esta computadora (fabricante:producto). */
  authorized: (string | null)[];
  /** Intercambio de bytes con la balanza (de cada marca, lo último). */
  log: unknown[];
  events: unknown[];
  /** Qué pasó en cada paso, en palabras cortas. */
  steps: string[];
  /** Respuesta de las otras pestañas al pedirles que suelten el cable. */
  otherTabs?: unknown;
}

export function emptyDiag(): ConnectDiag {
  return { usb: null, authorized: [], log: [], events: [], steps: [] };
}

export interface EngineContext {
  branchId: string | null;
  products: EngineProduct[];
  /** Hay base de datos (no modo demo). */
  online: boolean;
  /** Dueño o administrador: puede guardar en Patagonia qué producto es cada uno de la balanza. */
  canManageLinks?: boolean;
  /** La balanza registrada a la que se le habla (clave en scale_profiles). Sin esto, la de siempre. */
  scaleKey?: string;
  /** Si viene, cada marca deja acá lo que mandó y recibió (para soporte). */
  diag?: ConnectDiag;
  /**
   * La persona confirmó en pantalla mandar la función 25 de Systel ("liberar el equipo"). Sin esto, conectar y leer es
   * SOLO LECTURA (pedido del dueño 19/10): la 25 cambia el estado de la balanza.
   */
  allowSystelRelease?: boolean;
}

export interface ScaleAdapter {
  family: "systel" | "kretz";
  /** Identifica la balanza en el puerto, SOLO LEYENDO. null = no es de esta marca. */
  identify(port: SerialPort, ctx: EngineContext, onProgress: ProgressFn): Promise<ScaleSession | null>;
}
