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
  /** Empresa del usuario que la cobró -- si en esta PC después entra
   * alguien de otra empresa, la venta no se le manda con esa sesión. Las
   * guardadas antes de este campo no lo tienen. */
  companyId?: string;
  /** Total cobrado, para mostrarlo en el aviso (las viejas no lo tienen). */
  total?: number;
  /** Aviso no-error (p. ej. "esperando que se abra un turno"). */
  note?: string;
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

export function addPendingSale(input: CreatePosSaleInput, extra: { companyId?: string; total?: number } = {}): PendingSale {
  const sale: PendingSale = {
    localId: `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    input,
    status: "pending",
    ...extra
  };
  saveQueue([...getPendingSales(), sale]);
  return sale;
}

export function removePendingSale(localId: string): void {
  saveQueue(getPendingSales().filter((s) => s.localId !== localId));
}

export function markPendingSaleError(localId: string, message: string): void {
  saveQueue(getPendingSales().map((s) => (s.localId === localId ? { ...s, status: "error", errorMessage: message, note: undefined } : s)));
}

export function updatePendingSale(localId: string, patch: Partial<Omit<PendingSale, "localId">>): void {
  saveQueue(getPendingSales().map((s) => (s.localId === localId ? { ...s, ...patch } : s)));
}

/** El turno donde se cobró ya no está abierto (lo cerraron, quizás desde
 * otra PC, antes de que la venta llegara). No es un error de la venta: se
 * sube al turno abierto de esa sucursal. */
export function isShiftClosedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { message } = err as { message?: unknown };
  return typeof message === "string" && /no hay un turno de mostrador abierto/i.test(message);
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

/**
 * Rechazo por sesión vencida o todavía no renovada, no por la venta en sí.
 * Caso real (2026-09-30, Carnicería la esquina): el equipo estuvo sin
 * internet, la sesión venció mientras tanto y al volver la conexión el
 * reintento salió como "anon" antes de que se renovara el token -- el
 * servidor contestó 401 "permission denied for function create_pos_sale" y
 * la venta quedó marcada como error para siempre, trabando el cierre del
 * turno. Esto se reintenta igual que una falla de red.
 */
const AUTH_CODES = new Set(["42501", "PGRST301", "PGRST302", "PGRST303"]);
const AUTH_MESSAGE = /jwt|permission denied for function|no autenticado|not authenticated/i;

export function isAuthError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return (typeof code === "string" && AUTH_CODES.has(code)) || (typeof message === "string" && AUTH_MESSAGE.test(message));
}

/** Se puede volver a intentar más tarde sin que nadie toque nada. */
export function isRetryableError(err: unknown): boolean {
  return isNetworkError(err) || isAuthError(err);
}

/** Vuelve a "pendiente" las ventas con error, para reintentarlas. Seguro:
 * cada una lleva su clave de idempotencia, el servidor nunca la duplica. */
export function resetPendingSaleErrors(onlyAuth = false): void {
  saveQueue(
    getPendingSales().map((s) =>
      s.status === "error" && (!onlyAuth || AUTH_MESSAGE.test(s.errorMessage ?? "")) ? { ...s, status: "pending", errorMessage: undefined } : s
    )
  );
}
