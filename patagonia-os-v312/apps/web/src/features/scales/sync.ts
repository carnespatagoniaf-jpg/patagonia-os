import type { ScaleDriver, ScaleSyncableProduct } from "./types";

/**
 * Sincronización segura (punto 8 del diseño): la seguridad va antes que la
 * velocidad. Para cada producto se guarda un estado de tres valores, no
 * dos -- "confirmado" es la única confianza real:
 * - "confirmed": se escribió Y se pudo verificar razonablemente (relectura
 *   comparada, cuando el driver la soporta).
 * - "uncertain": la balanza dijo que lo recibió, pero no se pudo confirmar
 *   -- nunca se informa como éxito sin aclarar esto.
 * - "failed": la balanza lo rechazó, o no respondió.
 *
 * El estado de cada producto se persiste en cada paso -- si el navegador
 * se cierra o el cable se corta a mitad de camino, la próxima vez se sabe
 * exactamente qué quedó confirmado, qué falló y qué quedó incierto, y solo
 * se reintentan esos, nunca se manda todo de nuevo a ciegas.
 */
export type SyncItemStatus = "pending" | "confirmed" | "failed" | "uncertain";

export interface SyncItemState {
  code: string;
  name: string;
  status: SyncItemStatus;
  message?: string;
  attempts: number;
}

export interface SyncSession {
  connectionId: string;
  startedAt: string;
  updatedAt: string;
  items: SyncItemState[];
}

function sessionKey(connectionId: string): string {
  return `patagonia-scale-sync-session-${connectionId}`;
}

export function getSyncSession(connectionId: string): SyncSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(connectionId));
    return raw ? (JSON.parse(raw) as SyncSession) : null;
  } catch {
    return null;
  }
}

function persistSession(session: SyncSession): void {
  try {
    localStorage.setItem(sessionKey(session.connectionId), JSON.stringify(session));
  } catch {
    // localStorage lleno o bloqueado -- no crítico, se pierde el resumen al recargar.
  }
}

export function clearSyncSession(connectionId: string): void {
  try {
    localStorage.removeItem(sessionKey(connectionId));
  } catch {
    // no crítico
  }
}

export interface SyncSummary {
  total: number;
  confirmed: number;
  uncertain: number;
  failed: number;
  pending: number;
}

export function summarizeSyncSession(session: SyncSession): SyncSummary {
  const summary: SyncSummary = { total: session.items.length, confirmed: 0, uncertain: 0, failed: 0, pending: 0 };
  for (const item of session.items) summary[item.status]++;
  return summary;
}

/** Arranca o retoma una sesión de sincronización para esta conexión: los
 * productos que ya estaban "confirmed" en una sesión previa se preservan
 * tal cual (no se reenvían); los demás (nuevos, "failed", "uncertain")
 * quedan "pending" para el próximo `runSafeSync`. */
export function prepareSyncSession(connectionId: string, products: ScaleSyncableProduct[]): SyncSession {
  const previous = getSyncSession(connectionId);
  const previousByCode = new Map((previous?.items ?? []).map((i) => [i.code, i] as const));
  const now = new Date().toISOString();
  const items: SyncItemState[] = products.map((p) => {
    const prior = previousByCode.get(p.code);
    if (prior && prior.status === "confirmed" && prior.name === p.name) return prior;
    return { code: p.code, name: p.name, status: "pending", attempts: prior?.attempts ?? 0 };
  });
  const session: SyncSession = { connectionId, startedAt: previous?.startedAt ?? now, updatedAt: now, items };
  persistSession(session);
  return session;
}

/**
 * Corre (o retoma) la sincronización: solo reintenta los productos que NO
 * están "confirmed" todavía. Pide siempre verificación de escritura al
 * driver (`verifyWrite: true` en los ajustes) cuando el protocolo lo
 * permite -- para precios y PLU la confirmación importa más que la
 * velocidad, así que no es opcional acá.
 */
export async function runSafeSync(
  driver: ScaleDriver,
  port: SerialPort,
  settings: Record<string, unknown>,
  connectionId: string,
  products: ScaleSyncableProduct[],
  onProgress?: (done: number, total: number, item: SyncItemState) => void
): Promise<SyncSession> {
  if (!driver.writePlu) {
    throw new Error("Esta balanza no tiene envío de productos.");
  }
  const productByCode = new Map(products.map((p) => [p.code, p] as const));
  let session = prepareSyncSession(connectionId, products);
  const pending = session.items.filter((i) => i.status !== "confirmed");
  const verifiedSettings = { ...settings, verifyWrite: true };

  let done = session.items.length - pending.length;
  for (const item of pending) {
    const product = productByCode.get(item.code);
    if (!product) continue;
    try {
      const result = await driver.writePlu(port, verifiedSettings, product);
      item.attempts++;
      item.message = result.message;
      item.status = result.verified === "confirmed" ? "confirmed" : result.verified === "unconfirmed" ? "uncertain" : "failed";
    } catch (err) {
      item.attempts++;
      item.status = "failed";
      item.message = err instanceof Error ? err.message : "Error de conexión.";
    }
    done++;
    session = { ...session, updatedAt: new Date().toISOString() };
    persistSession(session);
    onProgress?.(done, session.items.length, item);
  }
  return session;
}
