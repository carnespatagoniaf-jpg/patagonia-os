import type { CreatePosSaleInput } from "./sale-service";

/**
 * Ventas de Mostrador que no se pudieron mandar al servidor por falta de
 * conexión -- quedan guardadas acá (localStorage, por equipo/caja) tal cual
 * se hubieran mandado, y se reintentan solas apenas vuelve internet. Nunca
 * se descartan solas: si al reintentar el servidor las rechaza por un
 * motivo real (no de red), quedan marcadas como error para que alguien las
 * revise a mano en vez de perderse en silencio.
 */
export interface PendingSale {
  localId: string;
  createdAt: string;
  input: CreatePosSaleInput;
  status: "pending" | "error";
  errorMessage?: string;
}

const QUEUE_KEY = "patagonia-pos-offline-queue";

export function getPendingSales(): PendingSale[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as PendingSale[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: PendingSale[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage lleno o bloqueado -- no hay mucho más para hacer acá,
    // pero no es motivo para cortar la venta que se está cobrando.
  }
}

export function addPendingSale(input: CreatePosSaleInput): PendingSale {
  const sale: PendingSale = {
    localId: `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    input,
    status: "pending"
  };
  saveQueue([...getPendingSales(), sale]);
  return sale;
}

export function removePendingSale(localId: string): void {
  saveQueue(getPendingSales().filter((s) => s.localId !== localId));
}

export function markPendingSaleError(localId: string, message: string): void {
  saveQueue(getPendingSales().map((s) => (s.localId === localId ? { ...s, status: "error", errorMessage: message } : s)));
}

/**
 * Distingue "no hay internet / se cortó la conexión" de un rechazo real
 * del servidor (permisos, turno cerrado, datos inválidos, etc.) -- solo lo
 * primero tiene que hacer que la venta quede guardada para reintentar en
 * vez de mostrar un error. Cada RPC sensible de este proyecto rechaza con
 * `RAISE EXCEPTION` en Postgres, que siempre llega como un PostgrestError
 * con `code` (ver el patrón de RPCs en CLAUDE.md) -- una falla de red en
 * cambio nunca tiene `code`, así que alcanza como diferenciador acá.
 */
export function isNetworkError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return !("code" in err && (err as { code?: unknown }).code);
}
