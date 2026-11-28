/**
 * Versiones de Scale Connect en la pestaña Balanzas del panel de plataforma (migraciones 229 y 231). Lógica pura,
 * sin Supabase, testeada en scale-connect-versions.test.ts:
 *   - mergeVersionStats: junta las versiones publicadas (list_scale_connect_releases) con lo que tiene cada PC
 *     (admin_scale_connect_versions): instaladas, en línea, fallidas y vueltas atrás por versión, y las versiones
 *     instaladas que no están publicadas (las viejas).
 *   - nextRolloutSteps / parseRolloutPercent: el "Subir porcentaje" (0 → 10 → 50 → 100, o un número).
 *   - stopReleaseMessage / promoteReleaseMessage / rolloutMessage / channelMessage: los textos de las confirmaciones.
 *   - promoteBlocker: por qué una versión piloto no se puede pasar a estable (o null si se puede).
 */

export type ReleaseChannel = "pilot" | "stable";

export interface ScaleConnectRelease {
  id: string;
  version: string;
  channel: ReleaseChannel;
  rolloutPercent: number;
  active: boolean;
  publishedAt: string;
  updatedAt: string | null;
  minVersion: string | null;
  /** De list_scale_connect_releases (229): PC activas con esa versión y que volvieron atrás de ella. */
  installed: number;
  rolledBack: number;
}

/** Una fila de admin_scale_connect_versions (231). */
export interface InstalledVersionStat {
  version: string;
  installed: number;
  online: number;
  failed: number;
  rolledBack: number;
}

export interface ReleaseRow extends ScaleConnectRelease {
  online: number;
  failed: number;
  /** Ya hay una fila estable de esta misma versión (no se ofrece "Pasar a estable"). */
  hasStable: boolean;
}

export interface VersionStats {
  releases: ReleaseRow[];
  /** Versiones que tienen las PC pero no están publicadas (instaladas antes del actualizador, o despublicadas). */
  unpublished: InstalledVersionStat[];
  totalPcs: number;
  /** Sin la migración 231 los conteos salen solo de la 229 (sin "en línea" ni "fallaron"). */
  detailed: boolean;
}

export const CHANNEL_LABEL: Record<ReleaseChannel, string> = { pilot: "Piloto", stable: "Estable" };

/** "0.10.2" → [0, 10, 2] (el sufijo "-beta" no cuenta, como scale_connect_version_key). */
export function versionKey(version: string): number[] {
  return version.split("-")[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function mergeVersionStats(releases: ScaleConnectRelease[], installed: InstalledVersionStat[] | null): VersionStats {
  const byVersion = new Map((installed ?? []).map((s) => [s.version, s]));
  const stableVersions = new Set(releases.filter((r) => r.channel === "stable").map((r) => r.version));
  const rows: ReleaseRow[] = releases
    .map((r) => {
      const s = byVersion.get(r.version);
      return {
        ...r,
        installed: s ? s.installed : r.installed,
        rolledBack: s ? s.rolledBack : r.rolledBack,
        online: s?.online ?? 0,
        failed: s?.failed ?? 0,
        hasStable: stableVersions.has(r.version)
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version) || (a.channel === "stable" ? -1 : 1));
  const published = new Set(releases.map((r) => r.version));
  const unpublished = (installed ?? []).filter((s) => !published.has(s.version) && s.installed > 0).sort((a, b) => compareVersions(b.version, a.version));
  const totalPcs = installed
    ? installed.reduce((n, s) => n + s.installed, 0)
    : [...new Map(releases.map((r) => [r.version, r.installed])).values()].reduce((n, x) => n + x, 0);
  return { releases: rows, unpublished, totalPcs, detailed: installed !== null };
}

/** Los escalones de "Subir porcentaje" que quedan por encima del actual. */
export function nextRolloutSteps(current: number): number[] {
  return [10, 50, 100].filter((p) => p > current);
}

/** El número escrito ("25", "25 %", " 50%") → 0..100 entero, o null si no es válido. */
export function parseRolloutPercent(text: string): number | null {
  const t = text.trim().replace(/\s*%$/, "");
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

const pcs = (n: number) => (n === 1 ? "1 PC" : `${n} PC`);

export function stopReleaseMessage(r: Pick<ReleaseRow, "version" | "channel" | "installed">): string {
  return (
    `La v${r.version} (${CHANNEL_LABEL[r.channel].toLowerCase()}) deja de ofrecerse al instante. ` +
    `Las PC que ya la tienen (${pcs(r.installed)}) se quedan con esa versión: no vuelven atrás solas. ` +
    `Las demás dejan de recibirla y siguen con la que tienen.`
  );
}

export function rolloutMessage(r: Pick<ReleaseRow, "version" | "channel" | "rolloutPercent">, next: number): string {
  const who = r.channel === "pilot" ? "de los clientes en piloto" : "de todas las PC";
  if (next === 100) return `La v${r.version} se va a ofrecer al 100 % ${who}. Cada PC la baja en su próxima revisión.`;
  if (next < r.rolloutPercent) return `La v${r.version} baja de ${r.rolloutPercent} % a ${next} % ${who}. Las PC que ya la instalaron se quedan con ella.`;
  return `La v${r.version} pasa de ${r.rolloutPercent} % a ${next} % ${who}. Las PC que ya la tenían ofrecida la siguen teniendo.`;
}

export function promoteReleaseMessage(r: Pick<ReleaseRow, "version">): string {
  return (
    `Se publica la v${r.version} en el canal estable con el mismo instalador firmado, al 0 %: ` +
    `todavía no le llega a nadie. Después subí el porcentaje. La versión piloto sigue como está.`
  );
}

/** null = se puede pasar a estable. El manifiesto tiene que estar firmado para "general" (lo exige la 229). */
export function promoteBlocker(r: Pick<ReleaseRow, "channel" | "hasStable" | "active">, manifestChannel?: string | null): string | null {
  if (r.channel !== "pilot") return "Ya es estable.";
  if (r.hasStable) return "Esta versión ya está publicada en estable.";
  if (!r.active) return "Está frenada: no se pasa a estable una versión frenada.";
  if (manifestChannel !== undefined && manifestChannel !== "general") {
    return "El instalador está firmado solo para piloto. Para estable hay que firmarlo de nuevo como general en el CI.";
  }
  return null;
}

export function channelMessage(companyName: string, next: ReleaseChannel): string {
  return next === "pilot"
    ? `${companyName} pasa a piloto: sus PC reciben también las versiones piloto (además de las estables).`
    : `${companyName} pasa a estable: sus PC dejan de recibir versiones piloto. Las que ya instalaron una piloto se quedan con ella hasta que salga una estable más nueva.`;
}

export function releaseStateText(r: Pick<ReleaseRow, "active" | "rolloutPercent">): string {
  if (!r.active) return "Frenada";
  if (r.rolloutPercent === 0) return "Activa, a nadie todavía";
  return `Activa al ${r.rolloutPercent} %`;
}

// ------------------------------------------------------------------------------------------------ mapeo de la base

type Raw = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function mapRelease(r: Raw): ScaleConnectRelease {
  return {
    id: String(r.id ?? ""),
    version: String(r.version ?? ""),
    channel: r.channel === "stable" ? "stable" : "pilot",
    rolloutPercent: num(r.rollout_percent),
    active: r.active === true,
    publishedAt: String(r.published_at ?? ""),
    updatedAt: str(r.updated_at),
    minVersion: str(r.min_version),
    installed: num(r.installed),
    rolledBack: num(r.rolled_back)
  };
}

export function mapInstalled(r: Raw): InstalledVersionStat {
  return { version: String(r.version ?? ""), installed: num(r.installed), online: num(r.online), failed: num(r.failed), rolledBack: num(r.rolled_back) };
}
