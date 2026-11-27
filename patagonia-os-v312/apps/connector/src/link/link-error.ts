// Errores de los enlaces de bytes, con un código estable para la lógica y un
// mensaje en castellano para la persona.

export type LinkErrorCode =
  /** No llegó la respuesta esperada a tiempo. */
  | "timeout"
  /** El enlace se cerró (desconexión o cierre pedido) con una operación en curso. */
  | "closed"
  /** El puerto COM no existe en esta PC (adaptador desenchufado, número equivocado). */
  | "not_found"
  /** Windows niega el acceso: el puerto lo tiene abierto OTRO programa (iTegra, Qendra…). */
  | "busy_other_program"
  /** El puerto ya tiene dueño DENTRO de este servicio. */
  | "in_use_here"
  /** La balanza de red rechazó la conexión (puerto equivocado u otro cliente conectado). */
  | "refused"
  /** No hay ruta hasta la balanza de red (apagada, cable, otra subred). */
  | "unreachable"
  /** La operación se canceló (vigía del trabajo, apagado del servicio). */
  | "aborted"
  /** Cualquier otra falla de entrada/salida. */
  | "io";

export class LinkError extends Error {
  readonly code: LinkErrorCode;

  constructor(code: LinkErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LinkError";
    this.code = code;
  }
}

export function isLinkError(error: unknown, code?: LinkErrorCode): error is LinkError {
  return error instanceof LinkError && (code === undefined || error.code === code);
}

function errorText(error: unknown): { message: string; code: string } {
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; code?: unknown };
    return {
      message: typeof e.message === "string" ? e.message : String(error),
      code: typeof e.code === "string" ? e.code : "",
    };
  }
  return { message: String(error), code: "" };
}

/**
 * Clasifica el error de abrir un puerto o socket. Distingue, sobre todo,
 * "lo tiene otro programa" (en Windows: "Access denied" al abrir el COM) de
 * "no existe" ("File not found"), porque la solución para la persona es otra.
 */
export function classifyOpenError(error: unknown, label: string): LinkError {
  if (error instanceof LinkError) return error;
  const { message, code } = errorText(error);
  const text = `${code} ${message}`;

  if (/access denied|acceso denegado|EACCES|EBUSY|resource busy|being used by another process/i.test(text)) {
    return new LinkError(
      "busy_other_program",
      `${label} lo tiene abierto otro programa (por ejemplo iTegra, Qendra u otra ventana). Cerralo y probá de nuevo.`,
      { cause: error },
    );
  }
  if (/file not found|cannot find the file|no such file|ENOENT|ENODEV/i.test(text)) {
    return new LinkError(
      "not_found",
      `${label} no existe en esta PC. ¿Está enchufado el adaptador? Puede haber cambiado de número de COM.`,
      { cause: error },
    );
  }
  if (/ECONNREFUSED/i.test(text)) {
    return new LinkError(
      "refused",
      `${label} rechazó la conexión. Revisá el puerto, o si otro programa ya está conectado a esa balanza.`,
      { cause: error },
    );
  }
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND|EADDRNOTAVAIL/i.test(text)) {
    return new LinkError(
      "unreachable",
      `No se llega a ${label}. Revisá que esté prendida, el cable de red y que esté en la misma red que esta PC.`,
      { cause: error },
    );
  }
  return new LinkError("io", `No se pudo abrir ${label}: ${message}`, { cause: error });
}
