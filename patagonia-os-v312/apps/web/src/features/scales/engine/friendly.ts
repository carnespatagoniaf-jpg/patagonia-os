/**
 * Errores → mensajes que entiende un carnicero. Nunca se muestra un error de programación; el detalle técnico
 * va a soporte.
 */

export type FriendlyKind = "sin_navegador" | "sin_eleccion" | "puerto_ocupado" | "puerto_otro_programa" | "otra_balanza" | "elegir_cable" | "balanza_ocupada" | "no_contesta" | "frenado" | "sin_internet" | "general";

export const FRIENDLY_MESSAGES: Record<FriendlyKind, string> = {
  sin_navegador: "Para conectar la balanza usá Google Chrome o Microsoft Edge en una computadora.",
  sin_eleccion: "No elegiste la balanza en la lista. Tocá \"Conectar balanza\" de nuevo y elegí la que dice USB.",
  puerto_ocupado: "Otra pestaña de Patagonia está usando la balanza en este momento. Esperá unos segundos y probá de nuevo.",
  puerto_otro_programa: "Otro programa tiene tomada la balanza (por ejemplo Qendra, el programa de la balanza, u otra ventana de Chrome o Edge). Cerralo y probá de nuevo.",
  otra_balanza: "La balanza que contestó no es la que elegiste. Revisá que el cable sea el de esa balanza.",
  elegir_cable: "Esta computadora todavía no conoce el cable de esta balanza. Tocá \"Elegir el cable\" y elegila en la lista (la que dice USB).",
  // Lo único comprobado es el código E3; Systel no documenta su causa (V6.0 pág. 4). No se le pide nada al cliente.
  balanza_ocupada: "La balanza respondió con el código E3 y no atendió el pedido. Según Systel, E3 es \"equipo ocupado, orden desatendida\" (por ejemplo, una venta o un menú abierto en la balanza).",
  no_contesta: "No pudimos conectar tu balanza. Revisá que esté prendida y el cable enchufado, o contactá a soporte.",
  frenado: "Frenamos para cuidar tus productos: no se cambió nada más en la balanza. Ya le avisamos a soporte.",
  sin_internet: "No hay conexión a internet. Revisala y probá de nuevo.",
  general: "Algo no salió bien. Probá de nuevo o contactá a soporte."
};

/**
 * Después de mandar y releer los productos. NO dice "ya podés vender": eso recién se sabe cuando Mostrador lee bien una
 * etiqueta impresa (paso 5, install-status.ts). Antes decía "¡Listo! Tu balanza está conectada y ya podés vender".
 */
export const SENT_AND_CHECKED = "Productos pasados y comprobados en la balanza. Falta el último paso: pesá algo, imprimí la etiqueta y escaneala en Mostrador.";
export const ALREADY_SAME = "La balanza ya tiene los mismos productos y precios que Patagonia (comprobado uno por uno). Falta el último paso: pesá algo, imprimí la etiqueta y escaneala en Mostrador.";

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
  // Internet primero: "NetworkError when attempting to fetch" también dice NetworkError (antes se mostraba como
  // "otra pestaña usa la balanza"; auditoría 28/10).
  if (/Failed to fetch|NetworkError when attempting|ERR_INTERNET|offline/i.test(text)) return "sin_internet";
  // Ya abierto por Patagonia (otra pestaña o esta misma).
  if (/already open|InvalidStateError|abierto en otra/i.test(text)) return "puerto_ocupado";
  // Windows no deja abrir el puerto: otro programa lo tiene (Qendra, iTegra, otra ventana) o el driver del cable falla.
  if (/Failed to open|NetworkError|Access denied|acceso denegado/i.test(text)) return "puerto_otro_programa";
  if (/no contest|no respond|sin respuesta|timeout/i.test(text)) return "no_contesta";
  return "general";
}

/** El puerto no se pudo abrir (otra pestaña, otro programa o el driver): no tiene sentido probar otra marca. */
export function isPortOpenError(err: unknown): boolean {
  const kind = friendlyKind(err);
  return kind === "puerto_ocupado" || kind === "puerto_otro_programa";
}

export function friendlyMessage(err: unknown): string {
  return FRIENDLY_MESSAGES[friendlyKind(err)];
}
