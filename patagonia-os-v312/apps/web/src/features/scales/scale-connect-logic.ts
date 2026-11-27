/**
 * "Computadoras con Scale Connect" (Mis balanzas, migración 226): lógica pura, sin Supabase. Probada en
 * scale-connect-logic.test.ts.
 */

export interface ScaleConnector {
  id: string;
  name: string;
  branchId: string | null;
  branchName: string | null;
  version: string | null;
  status: "active" | "revoked";
  lastSeenAt: string | null;
  online: boolean;
  scales: Array<{ key: string; name: string; online: boolean }>;
  pairedAt: string | null;
  revokedAt: string | null;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
  branchId: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Lo que devuelve list_scale_connectors (jsonb) → filas tipadas; lo raro se descarta. */
export function parseConnectors(raw: unknown): ScaleConnector[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).flatMap((c) => {
    const id = str(c.id);
    if (!id) return [];
    const scales = Array.isArray(c.scales)
      ? c.scales.filter(isObj).map((s) => ({ key: str(s.key) ?? "", name: str(s.name) ?? str(s.key) ?? "", online: s.online === true })).filter((s) => s.key)
      : [];
    return [
      {
        id,
        name: str(c.name) ?? "",
        branchId: str(c.branch_id),
        branchName: str(c.branch_name),
        version: str(c.version),
        status: c.status === "revoked" ? "revoked" : "active",
        lastSeenAt: str(c.last_seen_at),
        online: c.online === true,
        scales,
        pairedAt: str(c.paired_at),
        revokedAt: str(c.revoked_at),
      } satisfies ScaleConnector,
    ];
  });
}

export function parsePairingCode(raw: unknown): PairingCode | null {
  if (!isObj(raw)) return null;
  const code = str(raw.code);
  const expiresAt = str(raw.expires_at);
  if (!code || !expiresAt) return null;
  return { code, expiresAt, branchId: str(raw.branch_id) };
}

/** "ABCDEFGH" → "ABCD-EFGH" (más fácil de dictar y de copiar). */
export function formatCode(code: string): string {
  const c = code.replace(/[\s-]/g, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** Segundos que le quedan al código (0 si venció). */
export function secondsLeft(expiresAt: string, now: Date): number {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

export function countdownText(seconds: number): string {
  if (seconds <= 0) return "El código venció. Pedí otro.";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `Vence en ${m}:${String(s).padStart(2, "0")}`;
}

function agoText(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 2) return "hace un momento";
  if (minutes < 60) return `hace ${minutes} minutos`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "hace 1 hora" : `hace ${hours} horas`;
  const days = Math.round(hours / 24);
  return days === 1 ? "hace 1 día" : `hace ${days} días`;
}

/** Estado de una PC para la lista: "En línea", "Sin conexión desde hace 3 horas", "Desvinculada". */
export function connectorStatus(c: ScaleConnector, now: Date): { text: string; tone: "ok" | "warn" | "muted" } {
  if (c.status === "revoked") return { text: "Desvinculada", tone: "muted" };
  if (c.online) return { text: "En línea", tone: "ok" };
  if (!c.lastSeenAt) return { text: "Todavía no se conectó", tone: "warn" };
  return { text: `Sin conexión desde ${agoText(c.lastSeenAt, now)}`, tone: "warn" };
}

/** Una PC nueva que apareció mientras se mostraba el código (para decir "¡Listo!"). */
export function newlyPaired(before: ScaleConnector[], after: ScaleConnector[]): ScaleConnector | null {
  const known = new Map(before.map((c) => [c.id, c.pairedAt]));
  return after.find((c) => c.status === "active" && (!known.has(c.id) || known.get(c.id) !== c.pairedAt)) ?? null;
}

/** Activas primero (por nombre), después las desvinculadas. */
export function sortConnectors(list: ScaleConnector[]): ScaleConnector[] {
  return [...list].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name, "es") : a.status === "active" ? -1 : 1));
}
