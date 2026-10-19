/**
 * Lo que cada COMPUTADORA sabe de cada balanza: por qué cable USB entra y con qué configuración contestó.
 *
 * Por qué así: el código de cada marca (systel-discovery, scale-serial) guarda su configuración en una sola clave de
 * localStorage, pensada para una balanza. En vez de reescribir esos protocolos (que funcionan en clientes reales),
 * cada balanza guarda una COPIA de esas claves al conectarse bien, y antes de hablarle se restauran. Así dos
 * balanzas en la misma computadora no se pisan la configuración.
 *
 * Web Serial no da un número de serie del equipo: el cable se reconoce por fabricante:producto del adaptador USB, y
 * si hay dos iguales, por lo que contesta la balanza (su número o su letra), que es la identidad guardada en la base.
 */

const KEY = "patagonia-scale-bindings";

/** Claves de configuración de conexión de cada marca (NO incluye formatos de etiqueta ni ventas). */
export const CONNECTION_KEYS: Record<"systel" | "kretz", string[]> = {
  systel: ["patagonia-systel-link"],
  kretz: ["patagonia-scale-serial-settings", "patagonia-scale-serial-port", "patagonia-scale-model", "patagonia-scale-balance-number", "patagonia-scale-verified"]
};

export interface ScaleBinding {
  branchId: string;
  family: "systel" | "kretz";
  /** "0403:6001" del adaptador, o null si no es USB. */
  usb: string | null;
  /** Copia de CONNECTION_KEYS al momento de la última conexión buena (null = la clave no existía). */
  snapshot: Record<string, string | null>;
  lastOkAt: string;
}

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadBindings(s: StorageLike | null = store()): Record<string, ScaleBinding> {
  try {
    const raw = s?.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, ScaleBinding>) : {};
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, ScaleBinding>, s: StorageLike | null) {
  try {
    s?.setItem(KEY, JSON.stringify(all));
  } catch {
    // sin localStorage: la próxima vez se elige el cable de nuevo
  }
}

export function bindingFor(scaleKey: string, branchId: string, s: StorageLike | null = store()): ScaleBinding | null {
  const b = loadBindings(s)[`${branchId}|${scaleKey}`];
  return b ?? null;
}

/** Después de conectar bien: guarda el cable y una copia de la configuración de conexión de esa marca. */
export function saveBinding(scaleKey: string, b: Omit<ScaleBinding, "snapshot" | "lastOkAt">, s: StorageLike | null = store(), now = new Date()): ScaleBinding {
  const snapshot: Record<string, string | null> = {};
  for (const k of CONNECTION_KEYS[b.family]) snapshot[k] = s?.getItem(k) ?? null;
  const binding: ScaleBinding = { ...b, snapshot, lastOkAt: now.toISOString() };
  const all = loadBindings(s);
  all[`${b.branchId}|${scaleKey}`] = binding;
  saveAll(all, s);
  return binding;
}

/** Antes de hablarle a una balanza: deja la configuración de conexión de su marca como la tenía ESA balanza. */
export function restoreBinding(binding: ScaleBinding, s: StorageLike | null = store()): void {
  for (const k of CONNECTION_KEYS[binding.family]) {
    if (!(k in binding.snapshot)) continue;
    const v = binding.snapshot[k];
    try {
      if (v === null) s?.removeItem(k);
      else s?.setItem(k, v);
    } catch {
      // nada
    }
  }
}

export function forgetBinding(scaleKey: string, branchId: string, s: StorageLike | null = store()): void {
  const all = loadBindings(s);
  delete all[`${branchId}|${scaleKey}`];
  saveAll(all, s);
}
