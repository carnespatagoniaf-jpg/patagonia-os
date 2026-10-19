/** Balanzas de una sucursal: tipos y lógica pura, sin base (para poder probarla). Ver branch-scales.ts. */

export type ScaleFamily = "systel" | "kretz";

export interface BranchScale {
  key: string;
  name: string;
  family: ScaleFamily;
  brand: string;
  model: string | null;
  identity: Record<string, unknown>;
  active: boolean;
  lastSeenAt: string | null;
  /** Tiene formatos de código guardados: Mostrador lee sus tickets ("artículos + TOTAL"). */
  sellsWithCodes: boolean;
  /** Cómo imprime los códigos (pesables, unitarios, TOTAL), si ya se leyó: sirve para reconocerla. */
  formats?: CodeFormats | null;
}

export interface CodeFormats {
  weighed: string | null;
  unit: string | null;
  total: string | null;
}

export interface ScaleRow {
  scale_key: string;
  name?: string | null;
  family?: string | null;
  brand: string;
  model: string | null;
  identity?: Record<string, unknown> | null;
  active: boolean | null;
  last_seen_at?: string | null;
  weighed_format: string | null;
  unit_format: string | null;
  total_format: string | null;
}

export function familyOfBrand(brand: string): ScaleFamily {
  return /kretz/i.test(brand) ? "kretz" : "systel";
}

export function rowToScale(r: ScaleRow): BranchScale {
  const family = r.family === "kretz" || r.family === "systel" ? r.family : familyOfBrand(r.brand);
  return {
    key: r.scale_key,
    name: (r.name ?? "").trim() || `${family === "kretz" ? "Kretz" : "Systel"}${r.model ? ` ${r.model}` : ""}`,
    family,
    brand: r.brand,
    model: r.model,
    identity: r.identity ?? {},
    active: r.active !== false,
    lastSeenAt: r.last_seen_at ?? null,
    sellsWithCodes: !!(r.weighed_format || r.unit_format || r.total_format),
    formats: r.weighed_format || r.unit_format || r.total_format ? { weighed: r.weighed_format, unit: r.unit_format, total: r.total_format } : null
  };
}

/**
 * ¿Es la misma balanza? Coinciden en TODO lo que las dos saben (número de balanza, letra, equipo) y comparten al
 * menos un dato. Sin datos en común no se puede saber: no es "la misma".
 */
export function sameIdentity(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const common = Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== null && b[k] !== undefined && b[k] !== null);
  return common.length > 0 && common.every((k) => String(a[k]) === String(b[k]));
}

/** La balanza ya registrada que es ESTA (misma marca e identidad), o null si es una nueva. */
export function findRegistered(scales: BranchScale[], family: ScaleFamily, identity: Record<string, unknown>): BranchScale | null {
  const same = scales.filter((s) => s.family === family && sameIdentity(s.identity, identity));
  return same.length === 1 ? same[0] : null;
}

/**
 * Registradas de esa marca SIN identidad (de antes de la 133, ej. la Systel de Los gringos): si es la única de esa
 * marca en la sucursal, la balanza que contestó es esa.
 */
export function legacyCandidate(scales: BranchScale[], family: ScaleFamily): BranchScale | null {
  const ofFamily = scales.filter((s) => s.family === family);
  return ofFamily.length === 1 && Object.keys(ofFamily[0].identity).length === 0 ? ofFamily[0] : null;
}

/** Nombre inicial que no se repita en la sucursal: "Systel Cuora Max", "Systel Cuora Max 2"… */
export function defaultScaleName(label: string, scales: BranchScale[]): string {
  const used = new Set(scales.map((s) => s.name.trim().toLowerCase()));
  if (!used.has(label.toLowerCase())) return label;
  for (let n = 2; n < 100; n++) if (!used.has(`${label} ${n}`.toLowerCase())) return `${label} ${n}`;
  return label;
}

/**
 * Dos balanzas de la misma marca con la MISMA identidad en una sucursal no se pueden distinguir por cable. Pasa con
 * dos Systel iguales de fábrica (las dos con el número 20). Hay que cambiarle el número a una (menú de la balanza).
 */
export function identityClash(scales: BranchScale[], family: ScaleFamily, identity: Record<string, unknown>, exceptKey: string | null): BranchScale | null {
  return scales.find((s) => s.key !== exceptKey && s.family === family && sameIdentity(s.identity, identity)) ?? null;
}

/**
 * ¿La balanza enchufada es la de esta tarjeta? Real, Los gringos: 3 Systel con el mismo número (20) y el mismo cable, una
 * por vez. Lo único que las distingue desde la PC es cómo imprimen los códigos (la vieja "22AA…", la nueva "22BB…").
 * - "otra": imprime distinto que la tarjeta elegida; `same` es la tarjeta que sí coincide (si hay una sola).
 * - "ok": coincide, o no hay con qué comparar (la tarjeta nunca se leyó, o la balanza no informó formatos).
 */
export function checkScaleFormats(target: BranchScale, read: CodeFormats | null, scales: BranchScale[]): { verdict: "ok" } | { verdict: "otra"; same: BranchScale | null } {
  const eq = (a: CodeFormats, b: CodeFormats) => a.weighed === b.weighed && a.unit === b.unit && a.total === b.total;
  if (!read || !target.formats) return { verdict: "ok" };
  if (eq(target.formats, read)) return { verdict: "ok" };
  const same = scales.filter((s) => s.key !== target.key && s.family === target.family && s.formats && eq(s.formats, read));
  return { verdict: "otra", same: same.length === 1 ? same[0] : null };
}

/** Con qué configuración buscar una balanza registrada ("¿Qué balanza tenés?" ya contestado). */
export function choiceForScale(s: Pick<BranchScale, "family" | "model" | "name">): "systel" | "kretz-aura" | "kretz-report" | "kretz-auto" {
  if (s.family === "systel") return "systel";
  const text = `${s.model ?? ""} ${s.name}`;
  if (/aura/i.test(text)) return "kretz-aura";
  if (/report/i.test(text)) return "kretz-report";
  return "kretz-auto";
}

export interface ScaleStatusInput {
  active: boolean;
  sellsWithCodes: boolean;
  /** Última conexión buena EN ESTA computadora (local-bindings), o null si nunca. */
  localOkAt: string | null;
}

/** Estado de una balanza en palabras simples, para la tarjeta de "Mis balanzas". */
export function scaleStatus(s: ScaleStatusInput, now = new Date()): { tone: "ok" | "warn" | "off"; text: string } {
  if (s.sellsWithCodes && !s.active) return { tone: "off", text: "Apagada para vender: Mostrador no lee sus tickets." };
  if (!s.localOkAt) return { tone: "warn", text: "Todavía no se conectó en esta computadora." };
  const at = new Date(s.localOkAt);
  const sameDay = at.toDateString() === now.toDateString();
  const hh = at.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  const when = sameDay ? `hoy ${hh}` : `${at.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })} ${hh}`;
  return { tone: "ok", text: `Lista en esta computadora · última conexión ${when}` };
}
