/**
 * supabase-js devuelve el error de un RPC como un objeto plano ({ message, code, details, hint }), no como `Error`.
 * Las pantallas muestran `err instanceof Error ? err.message : "No se pudo…"`, así que el motivo real del servidor
 * se perdía. Caso real (14/11/2026, M2 Alimentos): la cajera no podía cerrar la caja y solo veía "No se pudo
 * controlar la caja" en 150 intentos, cuando el servidor contestaba "PIN incorrecto".
 *
 * Devuelve un `Error` con el mismo mensaje y conserva code/details/hint, así siguen andando los que miran `code`
 * (offline-queue: isNetworkError, isAuthError).
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    const { message } = error as { message?: unknown };
    const text = typeof message === "string" && message.trim() ? message : "Error del servidor";
    return Object.assign(new Error(text), error, { message: text });
  }
  return new Error(typeof error === "string" && error ? error : "Error del servidor");
}
