import { getDriverById, SCALE_DRIVERS } from "./registry";
import type { ScaleDriverStatus } from "./types";

/**
 * Una balanza ya emparejada y guardada para esta PC/sucursal. Puede haber
 * varias a la vez (ej. una para peso en Mostrador y otra para PLU en
 * Stock, o dos cajas con su propia balanza) -- por eso esto es una LISTA,
 * a diferencia de los localStorage sueltos de un solo registro que tenían
 * hasta ahora scale-weight.ts (`patagonia-weight-scale-enabled`) y
 * scale-serial.ts (`patagonia-scale-serial-settings`). Esos dos siguen
 * existiendo tal cual mientras la pantalla vieja los use (ver CLAUDE.md) --
 * esta lista es la base de la pantalla nueva "Configuración → Balanzas".
 */
export interface ScaleConnectionRecord {
  id: string;
  driverId: string;
  displayName: string;
  status: ScaleDriverStatus;
  /** Ajustes resueltos por el driver al detectarla (opacos para el Manager). */
  settings: Record<string, unknown>;
  /** Capacidades que ya pasaron una prueba real en ESTA instalación
   * puntual -- no alcanza con que el driver las declare en general, ver
   * `getDeclaredCapabilities` vs. esto. */
  confirmedCapabilities: string[];
  pairedAt: string;
  lastVerifiedAt?: string;
}

const CONNECTIONS_KEY = "patagonia-scale-connections";

export function listScaleConnections(): ScaleConnectionRecord[] {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistScaleConnections(list: ScaleConnectionRecord[]): void {
  try {
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(list));
  } catch {
    // localStorage lleno o bloqueado -- no crítico, se puede volver a detectar.
  }
}

export function saveScaleConnection(record: ScaleConnectionRecord): void {
  const list = listScaleConnections().filter((c) => c.id !== record.id);
  list.push(record);
  persistScaleConnections(list);
}

export function removeScaleConnection(id: string): void {
  persistScaleConnections(listScaleConnections().filter((c) => c.id !== id));
}

export function getScaleConnection(id: string): ScaleConnectionRecord | undefined {
  return listScaleConnections().find((c) => c.id === id);
}

/** Techo de lo que declara el driver de una conexión guardada -- no lo que
 * ya se probó de verdad en esa instalación (eso es `confirmedCapabilities`
 * dentro del registro). */
export function getDeclaredCapabilities(record: ScaleConnectionRecord): string[] {
  return getDriverById(record.driverId)?.capabilities ?? [];
}

export function listAvailableDrivers() {
  return SCALE_DRIVERS;
}

// ---------------------------------------------------------------------------
// Detección, reconexión y manejo de errores centralizado (etapa 5). Nada de
// esto reemplaza el manejo de puerto propio que ya tienen scale-weight.ts y
// scale-serial.ts para SUS conexiones existentes (siguen intactos) -- esto
// es la base para drivers NUEVOS y para la pantalla "Configuración →
// Balanzas", que arranca de cero.
// ---------------------------------------------------------------------------

export function isScaleManagerSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/** Abre el selector de puertos del navegador -- tiene que llamarse desde un
 * click (gesto del usuario). Es el paso "1. Conectá tu balanza". */
export async function requestNewScalePort(): Promise<SerialPort> {
  if (!isScaleManagerSupported()) {
    throw new Error("Este navegador no soporta conexión directa por cable. Usá Chrome o Edge.");
  }
  return navigator.serial.requestPort();
}

/** Puertos ya autorizados en algún momento (no pide nada al usuario). */
export async function getPairedScalePorts(): Promise<SerialPort[]> {
  if (!isScaleManagerSupported()) return [];
  return navigator.serial.getPorts();
}

export interface ScaleDetectionResult {
  driver: (typeof SCALE_DRIVERS)[number];
  identify: Awaited<ReturnType<(typeof SCALE_DRIVERS)[number]["identify"]>>;
}

/**
 * Paso "2/3. Detectar balanza / Patagonia intenta identificarla
 * automáticamente": prueba cada driver dado de alta contra el puerto ya
 * elegido, en orden (certificados primero), hasta que uno la reconozca.
 * Nunca asume marca/modelo por adelantado -- cada driver decide con su
 * propio handshake si es o no la balanza que sabe hablar.
 */
export async function detectScaleOnPort(port: SerialPort, onProgress?: (text: string) => void): Promise<ScaleDetectionResult | null> {
  const ordered = [...SCALE_DRIVERS].sort((a, b) => (a.status === b.status ? 0 : a.status === "certified" ? -1 : 1));
  for (const driver of ordered) {
    onProgress?.(`Probando ${driver.brand} (${driver.models.join(", ")})…`);
    try {
      const identify = await driver.identify(port, onProgress);
      if (identify.matched) return { driver, identify };
    } catch {
      // este driver no reconoció nada en este puerto -- seguir probando los demás
    }
  }
  return null;
}

/**
 * Envoltura genérica de reintento -- generaliza el patrón que ya usan por
 * separado `readScaleWeight()` (scale-weight.ts) y `writeFrameResilient()`
 * (scale-serial.ts): si una llamada falla (ej. "Framing error", un hipo
 * físico del cable), se cierra el puerto y se reintenta una sola vez antes
 * de darse por vencido. Pensada para que los drivers NUEVOS la usen en vez
 * de reimplementar su propio reintento -- los dos drivers Kretz ya
 * existentes conservan el suyo (probado en producción) y no se migran a
 * esto para no tocar código delicado que ya funciona.
 */
export async function callResilient<T>(port: SerialPort, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    try {
      if (port.readable || port.writable) await port.close();
    } catch {
      // ya estaba cerrado o roto -- no importa
    }
    try {
      return await action();
    } catch {
      throw err; // el reintento también falló -- devolver el error original
    }
  }
}

/**
 * Aviso de desconexión física en vivo (evento nativo de Web Serial) --
 * capacidad nueva, no existía en el código anterior. Sirve para que la
 * pantalla de Balanzas (y en el futuro Mostrador/Stock) puedan avisar "se
 * desconectó la balanza" en el momento, en vez de que el próximo intento de
 * uso falle sin explicación. Devuelve una función para dejar de escuchar.
 */
export function onScalePortDisconnect(callback: (port: SerialPort) => void): () => void {
  if (!isScaleManagerSupported()) return () => {};
  const handler = (event: Event) => {
    const port = (event as Event & { target: SerialPort }).target;
    callback(port);
  };
  navigator.serial.addEventListener("disconnect", handler);
  return () => navigator.serial.removeEventListener("disconnect", handler);
}

/** Info identificatoria del puerto (vendor/product ID de USB) -- para
 * distinguir "es el mismo cable/adaptador de siempre" de "esto es un
 * dispositivo distinto" sin exponer nunca una letra de COM al usuario. */
export function describeScalePort(port: SerialPort): string {
  try {
    const info = port.getInfo();
    if (info.usbVendorId !== undefined && info.usbProductId !== undefined) {
      return `USB ${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)}`;
    }
  } catch {
    // getInfo no disponible en este navegador -- no es crítico
  }
  return "puerto serie";
}

// ---------------------------------------------------------------------------
// Puertos "en vivo" por conexión guardada. Un SerialPort no se puede guardar
// en localStorage (no es JSON) -- este mapa en memoria vincula el id de un
// `ScaleConnectionRecord` persistido con el objeto de puerto real de ESTA
// sesión del navegador. Se pierde al recargar la página, igual que pasaba
// antes con `cachedPort` en scale-weight.ts/scale-serial.ts -- por eso
// `reconnectSavedConnections` intenta recuperar el vínculo automáticamente.
// ---------------------------------------------------------------------------

const livePorts = new Map<string, SerialPort>();

export function getLiveScalePort(connectionId: string): SerialPort | undefined {
  return livePorts.get(connectionId);
}

export function setLiveScalePort(connectionId: string, port: SerialPort): void {
  livePorts.set(connectionId, port);
}

export function clearLiveScalePort(connectionId: string): void {
  livePorts.delete(connectionId);
}

/**
 * Al abrir la pantalla de Balanzas (o al recargar la página), ningún
 * `SerialPort` de una sesión anterior sigue en memoria. Web Serial no
 * expone un identificador estable para "este es el mismo puerto que ya
 * guardé" -- lo más parecido es volver a correr el handshake real
 * (`driver.identify`) de cada conexión guardada contra los puertos ya
 * autorizados (`getPorts()`, sin pedirle nada al usuario) hasta encontrar
 * cuál responde. Es la misma prueba de reconocimiento que se usó para
 * guardar la conexión la primera vez, no una suposición por orden de
 * llegada. Las conexiones para las que ningún puerto responde quedan sin
 * enlazar -- la próxima vez que el usuario toque "Probar" se le pide
 * conectar de nuevo.
 */
export async function reconnectSavedConnections(): Promise<{ reconnected: string[]; unmatched: string[] }> {
  const connections = listScaleConnections().filter((c) => !livePorts.has(c.id));
  if (connections.length === 0) return { reconnected: [], unmatched: [] };

  const ports = await getPairedScalePorts();
  const claimed = new Set(livePorts.values());
  const available = ports.filter((p) => !claimed.has(p));

  const reconnected: string[] = [];
  const unmatched: string[] = [];
  for (const connection of connections) {
    const driver = getDriverById(connection.driverId);
    if (!driver) {
      unmatched.push(connection.id);
      continue;
    }
    let matchedPort: SerialPort | null = null;
    for (const port of available) {
      if (Array.from(livePorts.values()).includes(port)) continue;
      try {
        const identify = await driver.identify(port);
        if (identify.matched) {
          matchedPort = port;
          break;
        }
      } catch {
        // este puerto no es esta balanza -- seguir probando los demás
      }
    }
    if (matchedPort) {
      livePorts.set(connection.id, matchedPort);
      reconnected.push(connection.id);
    } else {
      unmatched.push(connection.id);
    }
  }
  return { reconnected, unmatched };
}
