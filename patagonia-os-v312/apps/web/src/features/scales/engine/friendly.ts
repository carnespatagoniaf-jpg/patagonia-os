/**
 * Errores → mensajes que entiende un carnicero. Nunca se muestra un error de programación; el detalle técnico
 * va a soporte.
 */

export type FriendlyKind = "sin_navegador" | "sin_eleccion" | "puerto_ocupado" | "no_contesta" | "frenado" | "sin_internet" | "general";

export const FRIENDLY_MESSAGES: Record<FriendlyKind, string> = {
  sin_navegador: "Para conectar la balanza usá Google Chrome o Microsoft Edge en una computadora.",
  sin_eleccion: "No elegiste la balanza en la lista. Tocá \"Conectar balanza\" de nuevo y elegí la que dice USB.",
  puerto_ocupado: "La balanza está abierta en otra pestaña o programa. Cerrá las otras pestañas de Patagonia y probá de nuevo.",
  no_contesta: "No pudimos conectar tu balanza. Revisá que esté prendida y el cable enchufado, o contactá a soporte.",
  frenado: "Frenamos para cuidar tus productos: no se cambió nada más en la balanza. Ya le avisamos a soporte.",
  sin_internet: "No hay conexión a internet. Revisala y probá de nuevo.",
  general: "Algo no salió bien. Probá de nuevo o contactá a soporte."
};

export class FriendlyError extends Error {
  constructor(readonly kind: FriendlyKind, readonly technical?: string) {
    super(FRIENDLY_MESSAGES[kind]);
  }
}

/** Clasifica cualquier error (de Web Serial, de la base o nuestro) en un mensaje para el cliente. */
export function friendlyKind(err: unknown): FriendlyKind {
  if (err instanceof FriendlyError) return err.kind;
  const name = (err as { name?: string })?.name ?? "";
  const text = `${name} ${err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err)}`;
  if (/no soporta|not supported|navigator\.serial|usá Chrome/i.test(text)) return "sin_navegador";
  if (/NotFoundError|No port selected|no se eligió/i.test(text)) return "sin_eleccion";
  if (/already open|InvalidStateError|abierto en otra|Failed to open|NetworkError|Access denied/i.test(text)) return "puerto_ocupado";
  if (/Failed to fetch|NetworkError when attempting|ERR_INTERNET|offline/i.test(text)) return "sin_internet";
  if (/no contest|no respond|sin respuesta|timeout/i.test(text)) return "no_contesta";
  return "general";
}

export function friendlyMessage(err: unknown): string {
  return FRIENDLY_MESSAGES[friendlyKind(err)];
}
