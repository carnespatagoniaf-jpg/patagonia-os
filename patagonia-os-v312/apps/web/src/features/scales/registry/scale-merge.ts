import { lastUseText, type ScaleFamily } from "./scale-identity";

/**
 * Registros repetidos de la misma balanza (migración 225). Lógica pura, sin base, para poder probarla.
 *
 * Hasta la etapa 1, "Agregar balanza" registraba siempre otra fila aunque fuera la misma balanza (en producción, una
 * sucursal llegó a tener 4 registros {"address":20}). La base agrupa los que tienen la misma marca e identidad
 * (list_duplicate_scale_candidates); acá se arma el aviso de "Mis balanzas" y se redirige lo que cada computadora
 * recuerda de una clave que se unió a otra.
 */

export interface DuplicateScale {
  key: string;
  name: string;
  model: string | null;
  active: boolean;
  /** Lo más nuevo entre su última conexión y su último envío. */
  lastUsedAt: string | null;
  formats: { weighed: string | null; unit: string | null; total: string | null };
}

export interface DuplicateGroup {
  family: ScaleFamily;
  identity: Record<string, unknown>;
  /** Imprimen los códigos distinto: pueden ser balanzas físicas distintas (la base no las une). */
  formatsDiffer: boolean;
  /** Primero la usada más recientemente. */
  scales: DuplicateScale[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Lo que devuelve list_duplicate_scale_candidates, validado (lo que no tiene forma de grupo se descarta). */
export function parseDuplicateGroups(raw: unknown): DuplicateGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: DuplicateGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    const family = r.family === "kretz" || r.family === "systel" ? r.family : null;
    const scales = Array.isArray(r.scales) ? r.scales : [];
    if (!family || scales.length < 2) continue;
    const parsed: DuplicateScale[] = [];
    for (const s of scales) {
      const x = (s ?? {}) as Record<string, unknown>;
      const key = str(x.scale_key);
      if (!key) continue;
      parsed.push({
        key,
        name: str(x.name) ?? key,
        model: str(x.model),
        active: x.active !== false,
        lastUsedAt: str(x.last_used_at) ?? str(x.last_seen_at),
        formats: { weighed: str(x.weighed_format), unit: str(x.unit_format), total: str(x.total_format) }
      });
    }
    if (parsed.length < 2) continue;
    parsed.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
    out.push({ family, identity: (r.identity && typeof r.identity === "object" ? r.identity : {}) as Record<string, unknown>, formatsDiffer: r.formats_differ === true, scales: parsed });
  }
  return out;
}

export interface DuplicateNotice {
  title: string;
  rows: { key: string; name: string; lastUse: string }[];
  /** La que se propone dejar: la usada más recientemente. */
  suggestedKeep: string;
  /** false = imprimen distinto: no se ofrece unir. */
  canMerge: boolean;
  help: string;
}

/** El aviso de "Mis balanzas" para un grupo. */
export function duplicateNotice(group: DuplicateGroup, now = new Date()): DuplicateNotice {
  const n = group.scales.length;
  return {
    title: `Encontramos ${n} registros que parecen la misma balanza`,
    rows: group.scales.map((s) => ({ key: s.key, name: s.name, lastUse: lastUseText(s.lastUsedAt, now) })),
    suggestedKeep: group.scales[0].key,
    canMerge: !group.formatsDiffer,
    help: group.formatsDiffer
      ? "Imprimen las etiquetas de forma distinta, así que pueden ser balanzas distintas. Si lo son, tocá \"Son distintas\" y no te preguntamos más."
      : "Si es la misma balanza, elegí con qué nombre queda y tocá \"Unir\": no se pierde nada (productos reconocidos, ventas y envíos pasan a esa). Si son balanzas distintas, tocá \"Son distintas\" y no te preguntamos más."
  };
}

/** Qué pasó al unir, en palabras simples. `raw` = lo que devolvió merge_branch_scales. */
export function mergeResultText(raw: unknown, keepName: string): { ok: boolean; text: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.merged === true) {
    const keys = Array.isArray(r.keys) ? r.keys.length : 0;
    return { ok: true, text: `Listo: ${keys === 1 ? "el otro registro quedó unido" : `los otros ${keys} registros quedaron unidos`} a "${keepName}".` };
  }
  if (r.reason === "formatos_distintos") {
    const detail = Array.isArray(r.detail) ? (r.detail as Record<string, unknown>[]) : [];
    const names = detail.map((d) => `"${str(d.name) ?? str(d.scale_key) ?? "?"}"`).join(", ");
    return { ok: false, text: `No se unieron: ${names || "esos registros"} imprimen las etiquetas de forma distinta, así que pueden ser balanzas distintas. No se cambió nada.` };
  }
  return { ok: false, text: "No se pudieron unir. No se cambió nada." };
}

/**
 * Clave unida → clave que quedó, siguiendo cadenas (A → B → C da A → C). `rows` = las balanzas de la sucursal con su
 * merged_into (las que no se unieron no aparecen).
 */
export function mergedRedirects(rows: { key: string; mergedInto?: string | null }[]): Record<string, string> {
  const next = new Map(rows.filter((r) => r.mergedInto && r.mergedInto !== r.key).map((r) => [r.key, r.mergedInto as string]));
  const out: Record<string, string> = {};
  for (const key of next.keys()) {
    let to = next.get(key)!;
    const seen = new Set([key]);
    while (next.has(to) && !seen.has(to)) {
      seen.add(to);
      to = next.get(to)!;
    }
    if (to !== key) out[key] = to;
  }
  return out;
}
