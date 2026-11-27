/**
 * Centro de diagnóstico de balanzas (panel de plataforma, migración 230). Lógica pura, sin Supabase, testeada en
 * scale-center.test.ts:
 *   - classifyScaleCause: de la etapa + el mensaje de un reporte (o el motivo de un producto fallado) a una CAUSA
 *     con su posible solución en una línea.
 *   - scaleTrafficLight: el semáforo verde / amarillo / rojo con el motivo principal. MISMAS reglas que
 *     admin_scale_overview() en supabase/migrations/230_admin_scale_center.sql: si cambia una, cambiar la otra.
 *   - redactSensitive: vuelve a limpiar el registro técnico en la web (la base ya lo limpia; esto es por las dudas).
 *   - parseReportLog: qué guardó el cliente (etapa, mensaje, técnico, cable, pasos), del JSON de MyScale o del texto viejo.
 */

// ------------------------------------------------------------------------------------------------ causas

export type ScaleCauseKey =
  | "sin_puerto"
  | "otro_programa"
  | "modelo_no_comprobado"
  | "rechazo_productos"
  | "red_no_aparece"
  | "no_contesta"
  | "otro";

export interface ScaleCause {
  key: ScaleCauseKey;
  label: string;
  solution: string;
}

export const SCALE_CAUSES: Record<ScaleCauseKey, ScaleCause> = {
  sin_puerto: {
    key: "sin_puerto",
    label: "No eligió el puerto",
    solution: "Instalar Scale Connect (elige el puerto solo) o volver a tocar Conectar y elegir la que dice USB."
  },
  otro_programa: {
    key: "otro_programa",
    label: "Otro programa tiene la balanza",
    solution: "Cerrar iTegra/Qendra u otra ventana de Chrome/Edge y probar de nuevo."
  },
  modelo_no_comprobado: {
    key: "modelo_no_comprobado",
    label: "Modelo no comprobado",
    solution: "Coordinar una prueba con la balanza real antes de habilitar el envío de productos."
  },
  rechazo_productos: {
    key: "rechazo_productos",
    label: "Rechazo de productos (código 21/E5…)",
    solution: "Ver el motivo de cada producto (departamento, largo del código, nombre), corregirlo en Stock y reenviar."
  },
  red_no_aparece: {
    key: "red_no_aparece",
    label: "La balanza de red no aparece",
    solution: "Revisar IP / cable de red (lucecita verde) y que la PC esté en la misma red que la balanza."
  },
  no_contesta: {
    key: "no_contesta",
    label: "La balanza no contesta",
    solution: "Revisar cable USB/adaptador, que la balanza esté prendida y en modo Datos (no en peso)."
  },
  otro: {
    key: "otro",
    label: "Otro",
    solution: "Leer el registro técnico."
  }
};

/** Orden de las reglas: la primera que coincide gana (por ejemplo "frenado… respuesta 21" es rechazo, no "no contesta"). */
const CAUSE_RULES: Array<{ key: ScaleCauseKey; test: (stage: string, text: string) => boolean }> = [
  { key: "sin_puerto", test: (_s, t) => /no elegiste|no conoce el cable|elegir el cable|NotFoundError|No port selected|no se eligi[oó]/i.test(t) },
  { key: "otro_programa", test: (_s, t) => /otro programa|qendra|itegra|jdatagate|Failed to open|Access denied|acceso denegado|otra pesta[nñ]a|already open|InvalidStateError/i.test(t) },
  { key: "modelo_no_comprobado", test: (_s, t) => /no est[aá] comprobado|modelo no comprobado|sin comprobar|todav[ií]a no est[aá] comprobad/i.test(t) },
  {
    key: "rechazo_productos",
    test: (_s, t) => /respuesta\s*2\d\b|c[oó]digo\s*2\d\b|\bE5\b|rechaz|no qued(?:ó|o|aron) bien|formato_sucursal_protegido|perfil_etiqueta_protegido/i.test(t)
  },
  {
    key: "red_no_aparece",
    test: (s, t) => /^red\b/i.test(s) || /ninguna balanza en la red|cable de red|no contesta en \d{1,3}(?:\.\d{1,3}){3}|ECONNREFUSED|EHOSTUNREACH|configuraci[oó]n de red/i.test(t)
  },
  { key: "no_contesta", test: (_s, t) => /no contest|no respond|sin respuesta|timeout|tiempo de espera|no pudimos conectar|\bE3\b|equipo ocupado/i.test(t) }
];

/** La causa de un error a partir de su etapa y su texto (mensaje + técnico + nota). */
export function classifyScaleCause(input: { stage?: string | null; message?: string | null; technical?: string | null; note?: string | null }): ScaleCause {
  const stage = (input.stage ?? "").trim();
  const text = [stage, input.message, input.technical, input.note].filter(Boolean).join(" · ");
  for (const rule of CAUSE_RULES) if (rule.test(stage, text)) return SCALE_CAUSES[rule.key];
  return SCALE_CAUSES.otro;
}

export interface CauseGroup<T> {
  cause: ScaleCause;
  items: T[];
  open: number;
}

/** Agrupa reportes por causa: primero las que tienen reportes sin resolver, después las más frecuentes. */
export function groupByCause<T extends { resolvedAt: string | null }>(items: T[], causeOf: (item: T) => ScaleCause): CauseGroup<T>[] {
  const map = new Map<ScaleCauseKey, CauseGroup<T>>();
  for (const item of items) {
    const cause = causeOf(item);
    const group = map.get(cause.key) ?? { cause, items: [], open: 0 };
    group.items.push(item);
    if (!item.resolvedAt) group.open += 1;
    map.set(cause.key, group);
  }
  return [...map.values()].sort((a, b) => b.open - a.open || b.items.length - a.items.length || a.cause.label.localeCompare(b.cause.label));
}

// ------------------------------------------------------------------------------------------------ semáforo

export type Light = "verde" | "amarillo" | "rojo";

/** Lo que el semáforo necesita de cada fila de admin_scale_overview(). */
export interface LightInput {
  lastJobStatus: string | null;
  lastJobConfirmed: number | null;
  lastJobRequested: number | null;
  jobsFailed7d: number;
  jobsStuck: number;
  connectorsActive: number;
  connectorsStale: number;
  connectorVersionMin: string | null;
  connectorVersionMax: string | null;
  reportsOpen: number;
  duplicateGroups: number;
}

/** Semáforo con el motivo principal. Mismas reglas y mismo orden que la migración 230. */
export function scaleTrafficLight(r: LightInput): { light: Light; reason: string } {
  if (r.lastJobStatus === "failed") return { light: "rojo", reason: "Falló el último envío a la balanza" };
  if (r.jobsStuck > 0) return { light: "rojo", reason: "Hay envíos esperando una PC que no los toma" };
  if (r.connectorsActive > 0 && r.connectorsStale === r.connectorsActive) return { light: "rojo", reason: "Ninguna PC con Scale Connect se conectó en el último día" };
  if (r.reportsOpen >= 3) return { light: "rojo", reason: `${r.reportsOpen} reportes sin resolver` };
  if (r.reportsOpen > 0) return { light: "amarillo", reason: r.reportsOpen === 1 ? "Hay un reporte sin resolver" : `Hay ${r.reportsOpen} reportes sin resolver` };
  if (r.lastJobStatus === "partial") return { light: "amarillo", reason: `El último envío quedó a medias (${r.lastJobConfirmed ?? 0} de ${r.lastJobRequested ?? 0} confirmados)` };
  if (r.jobsFailed7d > 0) return { light: "amarillo", reason: r.jobsFailed7d === 1 ? "Un envío fallado en los últimos 7 días" : `${r.jobsFailed7d} envíos fallados en los últimos 7 días` };
  if (r.connectorsStale > 0) {
    return { light: "amarillo", reason: r.connectorsStale === 1 ? "Una PC con Scale Connect no se conecta hace más de un día" : `${r.connectorsStale} PC con Scale Connect no se conectan hace más de un día` };
  }
  if (r.duplicateGroups > 0) return { light: "amarillo", reason: "Hay balanzas registradas repetidas" };
  if (r.connectorVersionMin !== r.connectorVersionMax) return { light: "amarillo", reason: "Las PC tienen versiones distintas de Scale Connect" };
  return { light: "verde", reason: "Sin problemas" };
}

export const LIGHT_RANK: Record<Light, number> = { rojo: 0, amarillo: 1, verde: 2 };

// ------------------------------------------------------------------------------------------------ lista

export interface OverviewFilterRow {
  companyName: string;
  branchName: string | null;
  plan: string | null;
  light: Light;
}

/** Filtro de la lista: "con problemas" (amarillo o rojo) y buscador por cliente, sucursal o plan (sin tildes). */
export function filterOverview<T extends OverviewFilterRow>(rows: T[], opts: { onlyProblems: boolean; query: string }): T[] {
  const q = fold(opts.query.trim());
  return rows
    .filter((r) => !opts.onlyProblems || r.light !== "verde")
    .filter((r) => !q || fold(`${r.companyName} ${r.branchName ?? ""} ${r.plan ?? ""}`).includes(q))
    .sort((a, b) => LIGHT_RANK[a.light] - LIGHT_RANK[b.light] || a.companyName.localeCompare(b.companyName, "es") || (a.branchName ?? "").localeCompare(b.branchName ?? "", "es"));
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** {kretz: 2, systel: 1} → "2 Kretz · 1 Systel". */
export function describeBrands(byBrand: Record<string, number>): string {
  const parts = Object.entries(byBrand)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([brand, n]) => `${n} ${brand.charAt(0).toUpperCase()}${brand.slice(1)}`);
  return parts.length ? parts.join(" · ") : "Sin balanzas activas";
}

/** "hace 5 min", "hace 3 h", "hace 2 días", o "nunca". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "nunca";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "hace 1 día" : `hace ${d} días`;
}

// ------------------------------------------------------------------------------------------------ limpieza

const SENSITIVE_JSON_KEYS =
  "password|passwd|contrase(?:ñ|n)a|secret|secreto|secret_hash|code_hash|token|access_token|refresh_token|api_?key|apikey|authorization|service_role(?:_key)?|credential|credencial|cookie|email|mail|correo|tel|telefono|teléfono|phone|celular|whatsapp|cuit|dni|importe|monto|saldo|amount|total_venta|ticket_total|cobrado|pagado|venta|ventas";

const REDACTIONS: Array<[RegExp, string]> = [
  // 1. JSON "clave": valor sensible → "[oculto]" (el JSON sigue siendo válido).
  [new RegExp(`("(?:${SENSITIVE_JSON_KEYS})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?[0-9][0-9.eE+-]*|true|false)`, "gi"), '$1"[oculto]"'],
  // 2. Texto suelto.
  [/\b(password|passwd|contrase(?:ñ|n)a|secret|secreto|token|access_token|refresh_token|api_?key|apikey|service_role_key)(\s*[=:]\s*)(?!\[)[^\s"',;&}\]]+/gi, "$1$2[oculto]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [oculto]"],
  // 3. JWT y credencial de Scale Connect.
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]"],
  [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[A-Za-z0-9_-]{16,}/g, "[credencial]"],
  // 4. Tokens largos al azar.
  [/\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}/g, "[token]"],
  // 5. Emails.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // 6. Teléfonos.
  [/\+54[ -]?9?[ -]?[0-9]{2,4}[ -]?[0-9]{3,4}[ -]?[0-9]{4}(?![0-9])/g, "[teléfono]"],
  [/(^|[^0-9.:/-])\(?0?(?:11|2[0-9]{2,3}|3[0-9]{2,3})\)?[ -]?(?:15[ -]?)?[0-9]{3,4}-[0-9]{4}(?![0-9])/g, "$1[teléfono]"],
  // 7. CUIT.
  [/\b(?:20|23|24|27|30|33|34)-[0-9]{8}-[0-9]\b/g, "[cuit]"],
  // 8. Importes.
  [/\$ ?-?[0-9][0-9.,]*/g, "$ [importe]"]
];

/** Saca credenciales, tokens, emails, teléfonos, CUIT e importes. Mismas reglas que admin_scale_redact (SQL). */
export function redactSensitive(text: string | null | undefined): string {
  let out = text ?? "";
  for (const [re, by] of REDACTIONS) out = out.replace(re, by);
  return out;
}

// ------------------------------------------------------------------------------------------------ registro

export interface ParsedReportLog {
  isJson: boolean;
  stage: string | null;
  message: string | null;
  technical: string | null;
  cable: string | null;
  steps: string[];
  version: string | null;
  /** El registro limpio y legible (JSON con sangría, o el texto tal cual). */
  pretty: string;
}

const asText = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : typeof v === "string" ? v : JSON.stringify(v));

/** Lee el registro que mandó "Enviar a soporte": el JSON de MyScale (etapa, mensaje, técnico, cable, pasos) o texto viejo. */
export function parseReportLog(raw: string | null | undefined): ParsedReportLog {
  const clean = redactSensitive(raw);
  let data: unknown = null;
  if (/^\s*[{[]/.test(clean)) {
    try {
      data = JSON.parse(clean);
    } catch {
      data = null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { isJson: false, stage: null, message: null, technical: null, cable: null, steps: [], version: null, pretty: clean };
  }
  const d = data as Record<string, unknown>;
  const steps = Array.isArray(d.pasos)
    ? d.pasos.map((p) => {
        if (p && typeof p === "object") {
          const s = p as { label?: unknown; ok?: unknown; detail?: unknown };
          if (typeof s.label === "string") return `${s.ok === false ? "✗" : s.ok === true ? "✓" : "·"} ${s.label}${typeof s.detail === "string" && s.detail ? `: ${s.detail}` : ""}`;
        }
        return asText(p) ?? "";
      }).filter(Boolean)
    : [];
  return {
    isJson: true,
    stage: asText(d.etapa),
    message: asText(d.mensaje),
    technical: asText(d.tecnico),
    cable: asText(d.cable),
    steps,
    version: asText(d.version),
    pretty: JSON.stringify(d, null, 2)
  };
}
