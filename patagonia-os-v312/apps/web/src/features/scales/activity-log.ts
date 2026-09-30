/**
 * Bitácora de soporte (punto 9 del diseño): todo lo que pasa con las
 * balanzas de esta PC -- detecciones, pruebas, certificaciones,
 * sincronizaciones y errores -- queda anotado en orden, con hora, para que
 * el dueño pueda copiarlo y pasárselo al equipo de Patagonia OS sin tener
 * que describir de memoria qué tocó y qué pasó. Nunca sube a ningún
 * servidor -- vive solo en localStorage de esta PC, igual que el resto de
 * la configuración de balanzas.
 */
export interface ScaleActivityEntry {
  at: string;
  kind: "detect" | "test" | "certification" | "sync" | "diagnose" | "error";
  connectionLabel?: string;
  message: string;
}

const LOG_KEY = "patagonia-scale-activity-log";
const MAX_ENTRIES = 200;

export function getActivityLog(): ScaleActivityEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function logScaleActivity(entry: Omit<ScaleActivityEntry, "at">): void {
  try {
    const log = getActivityLog();
    log.push({ ...entry, at: new Date().toISOString() });
    // Se guarda solo lo último -- no hace falta un historial ilimitado para
    // diagnosticar un problema reciente, y evita que localStorage crezca sin límite.
    const trimmed = log.slice(-MAX_ENTRIES);
    localStorage.setItem(LOG_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage lleno o bloqueado -- no crítico, el diagnóstico en pantalla sigue andando igual.
  }
}

export function clearActivityLog(): void {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    // no crítico
  }
}

/** Texto plano listo para copiar y pegar en un mensaje a soporte. */
export function exportActivityLogText(): string {
  const log = getActivityLog();
  if (log.length === 0) return "Sin actividad registrada todavía.";
  return log
    .map((e) => `[${new Date(e.at).toLocaleString("es-AR")}] ${e.kind.toUpperCase()}${e.connectionLabel ? ` (${e.connectionLabel})` : ""}: ${e.message}`)
    .join("\n");
}
