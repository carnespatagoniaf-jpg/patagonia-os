/**
 * Candado por balanza entre las pestañas de Patagonia de este Chrome (Web Locks API, `navigator.locks`).
 *
 * Por qué (plan balanzas v2, C19/C20): con dos balanzas por red, o con el vigía de 30 s de "Mis balanzas" abierto en
 * otra pestaña, una pestaña podía abrir o cerrar la conexión mientras otra estaba pasando productos, y el envío se
 * cortaba. Mostrador además cerraba el puerto serie que tenía abierto la sincronización de la Report. Con el candado,
 * quien usa una balanza la tiene sola desde que abre hasta que cierra; el resto espera o, si no puede esperar (el
 * vigía), no hace nada.
 *
 * Claves: `red:IP:puerto` por cada balanza por red (y `red:programa` mientras el programa de la PC sea de una sola
 * conexión, versión 6 o anterior) y `serie:…` por cada puerto serie.
 *
 * Sin `navigator.locks` (Chrome viejo, o fuera de un contexto seguro) no hay candado: todo funciona como antes.
 */

export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal; mode?: "exclusive" | "shared" }, callback: (lock: unknown) => Promise<unknown> | unknown): Promise<unknown>;
}

const PREFIX = "patagonia-balanza:";

let override: LockManagerLike | null | undefined;

/** Solo para pruebas: otro administrador de candados, o null para simular un Chrome sin `navigator.locks`. */
export function setScaleLocksForTests(l: LockManagerLike | null | undefined): void {
  override = l;
}

function lockManager(): LockManagerLike | null {
  if (override !== undefined) return override;
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { locks?: LockManagerLike });
  return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null;
}

/** ¿Hay candado de verdad en este navegador? */
export function scaleLocksAvailable(): boolean {
  return lockManager() !== null;
}

export type ReleaseLock = () => void;

const noop: ReleaseLock = () => {};

export interface AcquireOptions {
  /** true: si está tomado no espera, devuelve null (el vigía). */
  ifAvailable?: boolean;
  /** Cuánto esperar como mucho a que lo suelten (sin esto, espera lo que haga falta). */
  waitMs?: number;
}

/**
 * Toma el candado de esa balanza y lo tiene hasta que se llama a la función que devuelve. null = no se consiguió
 * (tomado y `ifAvailable`, o se venció `waitMs`). Sin `navigator.locks` siempre se consigue (no hay con quién pelear).
 */
export function acquireScaleLock(key: string, opts: AcquireOptions = {}): Promise<ReleaseLock | null> {
  const lm = lockManager();
  if (!lm) return Promise.resolve(noop);
  let free!: () => void;
  const held = new Promise<void>((r) => (free = r));
  let released = false;
  const release: ReleaseLock = () => {
    if (released) return;
    released = true;
    free();
  };
  return new Promise<ReleaseLock | null>((resolve, reject) => {
    const controller = !opts.ifAvailable && opts.waitMs !== undefined && typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(0, opts.waitMs ?? 0)) : null;
    const options = opts.ifAvailable ? { ifAvailable: true } : controller ? { signal: controller.signal } : {};
    let request: Promise<unknown>;
    try {
      request = lm.request(PREFIX + key, options, async (lock) => {
        if (timer) clearTimeout(timer);
        if (!lock) {
          resolve(null);
          return;
        }
        resolve(release);
        await held;
      });
    } catch {
      // el navegador tiene `locks` pero no deja usarlo: como antes, sin candado
      if (timer) clearTimeout(timer);
      resolve(noop);
      return;
    }
    request.catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      if ((err as { name?: string } | null)?.name === "AbortError") resolve(null);
      else reject(err);
    });
  });
}

/** Toma varios candados en el orden dado (siempre el mismo orden: así dos pestañas nunca se traban entre sí). */
export async function acquireScaleLocks(keys: string[], opts: AcquireOptions = {}): Promise<ReleaseLock | null> {
  const held: ReleaseLock[] = [];
  for (const key of keys) {
    const r = await acquireScaleLock(key, opts);
    if (!r) {
      for (const h of held.reverse()) h();
      return null;
    }
    held.push(r);
  }
  return () => {
    for (const h of [...held].reverse()) h();
  };
}

export class ScaleBusyError extends Error {
  constructor(message = "La balanza la está usando otra pestaña de Patagonia en esta computadora. Esperá a que termine y probá de nuevo.") {
    super(message);
    this.name = "ScaleBusyError";
  }
}

export function isScaleBusyError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "ScaleBusyError";
}

/**
 * Corre `fn` con el candado de esa balanza tomado y lo suelta al terminar (salga bien o mal). Si no se consigue
 * (`ifAvailable` o `waitMs`), tira ScaleBusyError sin correr `fn`.
 */
export async function withScaleLock<T>(key: string | string[], fn: () => Promise<T>, opts: AcquireOptions = {}): Promise<T> {
  const release = await acquireScaleLocks(Array.isArray(key) ? key : [key], opts);
  if (!release) throw new ScaleBusyError();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Clave de un puerto serie: por el aparato USB (dos adaptadores iguales comparten candado; mejor de más que de menos). */
export function serialLockKey(port: { getInfo?: () => { usbVendorId?: number; usbProductId?: number } }): string {
  const info = port.getInfo?.() ?? {};
  const hex = (n?: number) => (n === undefined ? "?" : n.toString(16).padStart(4, "0"));
  return `serie:${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
}
