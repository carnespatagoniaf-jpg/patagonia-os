import type { Product } from "@patagonia/domain";

/**
 * Vocabulario común del Scale Manager (arquitectura acordada con el dueño:
 * "Scale Manager -> Kretz Driver -> Systel Driver -> Toledo Driver -> ...").
 * Nada de este archivo sabe de un protocolo puntual -- eso vive en cada
 * driver, bajo drivers/. Agregar una marca nueva nunca debería requerir
 * tocar este archivo.
 */

/** Lo mínimo que hace falta de un producto para mandarlo a una balanza --
 * mismo recorte que ya usaba scale-serial.ts (ScaleSyncableProduct), acá
 * para que el Manager y los drivers lo comparta sin duplicarlo. */
export interface ScaleSyncableProduct {
  id: string;
  code: string;
  name: string;
  unit: Product["unit"];
  priceRetail: number;
  active?: boolean;
}

/** Funciones que un driver puede declarar. No todas las balanzas permiten
 * lo mismo -- cada driver declara solo las que de verdad implementa, y la
 * interfaz de usuario debe ofrecer únicamente botones para esas. */
export type ScaleCapability =
  | "readWeight" // Lectura de peso en vivo
  | "readPlu" // Lectura de PLU
  | "writePlu" // Envío de PLU (un producto)
  | "bulkSync" // Sincronización masiva (catálogo completo)
  | "readCatalog" // Lectura de productos ya cargados en la balanza
  | "ping"; // Estado/conectividad

/**
 * CERTIFICADA: probamos físicamente esa balanza (o el mismo protocolo, ya
 * confirmado contra una unidad real) nosotros.
 * EXPERIMENTAL: implementada a partir de documentación, todavía sin
 * validar contra hardware real. Regla dura: una balanza experimental NUNCA
 * puede darle a la venta un peso o un precio sin que una persona lo haya
 * confirmado antes contra la pantalla física de la balanza.
 */
export type ScaleDriverStatus = "certified" | "experimental";

export interface ScaleWeightReading {
  weightKg: number;
  /** Precio por kg e importe -- solo en los modos que los mandan junto al peso. */
  price?: number;
  amount?: number;
  /** Texto crudo recibido -- siempre presente para diagnóstico, nunca para
   * la pantalla principal (eso es "Configuración avanzada"/soporte). */
  raw: string;
}

export interface ScaleIdentifyResult {
  matched: boolean;
  /** Ajustes resueltos (baudios, bits de stop, ID de equipo, etc.) que
   * hicieron que el driver reconociera la balanza -- se guardan para no
   * tener que detectar de nuevo la próxima vez. Forma libre: cada driver
   * define y entiende los suyos; el Manager los trata como una caja negra
   * que solo persiste y devuelve tal cual. */
  settings?: Record<string, unknown>;
  /** Nombre para mostrar ("Kretz Aura Eco") una vez identificada. */
  displayName?: string;
  /** Texto crudo de diagnóstico -- para "Configuración avanzada"/soporte,
   * nunca para la pantalla principal. */
  debug?: string;
}

/** Resultado de escribir un dato en la balanza (PLU o precio). `verified`
 * distingue tres casos a propósito, no dos -- ver la sincronización segura
 * (etapa 8): "confirmed" es la única confianza real; "unconfirmed" es un
 * estado incierto que nunca debe informarse como éxito sin aclarar. */
export interface ScaleWriteResult {
  verified: "confirmed" | "unconfirmed" | "failed";
  raw?: string;
  message?: string;
}

export interface ScalePingResult {
  ok: boolean;
  raw?: string;
  message?: string;
}

/** Resultado de la prueba de certificación -- ver `checkScaleCompatibility`
 * ya existente en scale-serial.ts, primer caso real de este patrón: carga
 * un dato de prueba descartable, lo relee, compara byte a byte, y lo borra.
 * Nunca confía en el nombre/modelo de la balanza ni en documentación. */
export interface ScaleCertificationResult {
  passed: boolean;
  message: string;
  debug?: string;
}

/**
 * La interfaz que cualquier balanza (marca/protocolo) tiene que implementar
 * para entrar al Scale Manager. Todos los métodos de capacidad son
 * OPCIONALES a propósito: un driver solo implementa los que de verdad
 * puede hacer, y lo declara en `capabilities`.
 *
 * `port` es un navigator.serial.SerialPort ya emparejado por el Manager --
 * ningún driver pide el puerto directamente (requestPort() exige un gesto
 * del usuario, y con varias balanzas por PC no puede haber un solo puerto
 * global cacheado como antes).
 */
export interface ScaleDriver {
  id: string; // "kretz-aura-weight" -- estable, no cambia nunca
  brand: string; // "Kretz"
  models: string[]; // ["Aura Eco", "Aura"] -- solo para mostrar
  status: ScaleDriverStatus;
  capabilities: ScaleCapability[];

  /** Intenta reconocer la balanza en `port`, probando las combinaciones
   * conocidas de velocidad/framing/comando de handshake de este driver.
   * `onProgress` es texto en criollo para el usuario ("Probando 3/9…"),
   * nunca un detalle técnico crudo. */
  identify(port: SerialPort, onProgress?: (text: string) => void): Promise<ScaleIdentifyResult>;

  readWeight?(port: SerialPort, settings: Record<string, unknown>): Promise<ScaleWeightReading>;
  ping?(port: SerialPort, settings: Record<string, unknown>): Promise<ScalePingResult>;
  readPlu?(port: SerialPort, settings: Record<string, unknown>, code: string): Promise<{ found: boolean; raw?: string; message?: string }>;
  writePlu?(port: SerialPort, settings: Record<string, unknown>, product: ScaleSyncableProduct): Promise<ScaleWriteResult>;
  deletePlu?(port: SerialPort, settings: Record<string, unknown>, code: string): Promise<ScaleWriteResult>;

  /** Prueba de certificación repetible -- obligatoria de correr con éxito
   * antes de habilitar sincronización masiva en una instalación nueva, sea
   * el driver certificado o experimental (no cuesta nada repetirla). */
  runCertificationTest?(port: SerialPort, settings: Record<string, unknown>): Promise<ScaleCertificationResult>;
}
