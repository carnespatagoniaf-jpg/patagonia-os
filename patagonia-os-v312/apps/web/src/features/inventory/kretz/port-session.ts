/**
 * Apertura y cierre del puerto serie para la Kretz Aura (y modelos nuevos)
 * durante "Probar todo" y la lectura de productos. NO lo usa la Report LT
 * (scale-serial.ts mantiene su propio manejo, que ya funciona y no se toca).
 *
 * Por qué existe (Aura de una clienta, 2026-10-01/02): después de una
 * comunicación real exitosa, Windows empezó a rechazar la apertura y la prueba
 * insistió hasta 700 veces en 5 minutos (464 de ellas "destrabar"): eran los
 * reintentos de la propia prueba, no un bucle de fondo. Reglas:
 * 1. Una sola prueba por puerto a la vez en esta pestaña (`claimPort`).
 * 2. Presupuesto de aperturas por prueba (`newSession`): agotado, se corta.
 * 3. El error se clasifica por su nombre (`classifyOpenError`). Web Serial no
 *    expone el código de Windows: "NetworkError: Failed to open serial port."
 *    cubre todo lo que rechaza el sistema operativo; el detalle de Windows
 *    queda en chrome://device-log.
 * 4. Si el adaptador se desenchufó y volvió (`connected === false`), se busca
 *    el puerto nuevo del mismo aparato USB (`freshPortFor`).
 */

export type OpenErrorKind = "ya_abierto_en_esta_pestana" | "windows_rechazo" | "desconectado" | "sin_permiso" | "presupuesto" | "otro";

export interface ClassifiedError {
  kind: OpenErrorKind;
  name: string;
  message: string;
  explanation: string;
}

export function classifyOpenError(err: unknown, connected?: boolean): ClassifiedError {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  if (connected === false || name === "NotFoundError" || /device has been lost|not found|disconnected/i.test(message)) {
    return { kind: "desconectado", name, message, explanation: "el adaptador USB no está conectado (se desenchufó, o Windows lo reinició)" };
  }
  if (name === "InvalidStateError") {
    return { kind: "ya_abierto_en_esta_pestana", name, message, explanation: "el puerto ya estaba abierto en esta misma pestaña" };
  }
  if (name === "SecurityError") {
    return { kind: "sin_permiso", name, message, explanation: "el navegador no dio permiso para usar el puerto" };
  }
  if (name === "NetworkError") {
    return {
      kind: "windows_rechazo",
      name,
      message,
      explanation:
        "Windows rechazó abrir el puerto: lo tiene abierto otro programa, otra ventana o perfil de Chrome, o el adaptador USB / su driver dejó de responder"
    };
  }
  return { kind: "otro", name, message, explanation: "error inesperado al abrir el puerto" };
}

export interface OpenAttempt {
  at: string;
  settings: string;
  try: number;
  ok: boolean;
  /** "Nombre: mensaje" tal cual lo dio Chrome. */
  error?: string;
  kind?: OpenErrorKind;
  /** Estado del puerto ANTES de intentar. */
  before: string;
}

export interface PortSession {
  /** Máximo de llamadas a port.open() en toda la prueba. */
  budget: number;
  used: number;
  log: OpenAttempt[];
  /** "Destrabar" (abrir un instante en otra velocidad) se hace UNA vez por prueba como mucho. */
  primed: boolean;
  /** El último error clasificado. */
  lastError: ClassifiedError | null;
}

export function newSession(budget = 12, log: OpenAttempt[] = []): PortSession {
  return { budget, used: 0, log, primed: false, lastError: null };
}

type PortLike = SerialPort & { connected?: boolean };

export function portState(port: SerialPort): string {
  const p = port as PortLike;
  const s = (x: { locked: boolean } | null) => (x ? (x.locked ? "bloqueado" : "sí") : "no");
  return `readable=${s(port.readable)} writable=${s(port.writable)} conectado=${p.connected === undefined ? "?" : p.connected ? "sí" : "no"}`;
}

export async function closeQuietly(port: SerialPort): Promise<void> {
  try {
    if (port.readable || port.writable) await port.close();
  } catch {
    // ya cerrado, o un stream todavía bloqueado (los lectores/escritores se sueltan siempre en finally)
  }
}

const settingsLabel = (o: SerialOptions) => `${o.baudRate}/${o.dataBits ?? 8}/${o.parity ?? "none"}/${o.stopBits ?? 1}`;

/** Una sola llamada a port.open(), descontada del presupuesto y anotada. */
export async function openOnce(port: SerialPort, options: SerialOptions, session: PortSession, tryNo: number, note = ""): Promise<ClassifiedError | null> {
  if (session.used >= session.budget) {
    const err: ClassifiedError = { kind: "presupuesto", name: "Presupuesto", message: "se agotaron los intentos de abrir el puerto en esta prueba", explanation: "se dejó de insistir" };
    session.log.push({ at: new Date().toISOString(), settings: settingsLabel(options) + note, try: tryNo, ok: false, error: err.message, kind: err.kind, before: portState(port) });
    return err;
  }
  session.used++;
  const before = portState(port);
  try {
    await port.open(options);
    session.log.push({ at: new Date().toISOString(), settings: settingsLabel(options) + note, try: tryNo, ok: true, before });
    return null;
  } catch (err) {
    const c = classifyOpenError(err, (port as PortLike).connected);
    session.log.push({ at: new Date().toISOString(), settings: settingsLabel(options) + note, try: tryNo, ok: false, error: `${c.name}: ${c.message}`, kind: c.kind, before });
    return c;
  }
}

const PRIME_RATES = [4800, 115200];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Abre el puerto. Hasta `tries` intentos (por defecto 2), cortando antes si el
 * error dice que reintentar no sirve (desconectado / sin permiso / presupuesto).
 * Caso real (CH340, 2026-10-01): Windows rechazaba 9600 pero abría en 4800 y
 * justo después abría en 9600; por eso, ante el primer rechazo de Windows de
 * la prueba, se abre UNA vez un instante en otra velocidad (sin mandar nada).
 */
export async function openForSession(port: SerialPort, options: SerialOptions, session: PortSession, tries = 2, waitMs = 1000): Promise<void> {
  let last: ClassifiedError | null = null;
  for (let i = 0; i < tries; i++) {
    const wasOpen = Boolean(port.readable || port.writable);
    await closeQuietly(port);
    // Algunos adaptadores (CH340) fallan si se reabre enseguida de cerrar.
    if (wasOpen || i > 0) await sleep(400);
    last = await openOnce(port, options, session, i + 1);
    if (!last) return;
    session.lastError = last;
    if (last.kind === "desconectado" || last.kind === "sin_permiso" || last.kind === "presupuesto") break;
    if (last.kind === "windows_rechazo" && !session.primed) {
      session.primed = true;
      for (const baudRate of PRIME_RATES) {
        if (baudRate === options.baudRate) continue;
        const primeErr = await openOnce(port, { baudRate, dataBits: 8, stopBits: 1, parity: "none" }, session, 0, " (destrabar)");
        if (!primeErr) {
          await sleep(150);
          await closeQuietly(port);
          await sleep(300);
          break;
        }
        if (primeErr.kind === "presupuesto") break;
      }
    }
    if (i < tries - 1) await sleep(waitMs);
  }
  const error = new Error(last ? `${last.name}: ${last.message}` : "No se pudo abrir el puerto");
  error.name = last?.name ?? "Error";
  throw Object.assign(error, { classified: last });
}

export function errorClassification(err: unknown): ClassifiedError | null {
  return (err as { classified?: ClassifiedError | null } | null)?.classified ?? null;
}

/* Puertos con una prueba en curso en esta pestaña. Un segundo "Probar todo"
 * (doble clic, o leer productos mientras corre la prueba) no abre el puerto
 * otra vez: se rechaza al instante. */
const claimed = new WeakSet<object>();

export function claimPort(port: SerialPort): boolean {
  if (claimed.has(port)) return false;
  claimed.add(port);
  return true;
}

export function releasePort(port: SerialPort): void {
  claimed.delete(port);
}

/**
 * Si el objeto de puerto quedó viejo (el adaptador se desenchufó y volvió,
 * `connected === false`), devuelve el puerto actual del mismo aparato USB.
 */
export async function freshPortFor(port: SerialPort): Promise<SerialPort> {
  if ((port as PortLike).connected !== false) return port;
  if (typeof navigator === "undefined" || !("serial" in navigator)) return port;
  const info = port.getInfo?.() ?? {};
  const all = (await navigator.serial.getPorts()) as PortLike[];
  const same = all.find((x) => {
    const i = x.getInfo?.() ?? {};
    return x !== port && x.connected !== false && i.usbVendorId === info.usbVendorId && i.usbProductId === info.usbProductId;
  });
  return same ?? port;
}
