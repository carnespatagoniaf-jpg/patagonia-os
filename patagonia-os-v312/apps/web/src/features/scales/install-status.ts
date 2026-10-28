/**
 * En qué punto está la instalación de cada balanza, con PRUEBAS, no con suposiciones (etapa 0, 28/10).
 *
 *   1. Balanza reconocida        → contestó y se supo qué modelo es
 *   2. Comunicación              → esta computadora le habla (lectura completa)
 *   3. Productos enviados        → se grabaron en la balanza (o ya estaban iguales)
 *   4. Productos comprobados     → se releyeron de la balanza y son iguales a Patagonia
 *   5. Venta probada             → Mostrador leyó bien una etiqueta impresa DESPUÉS del último envío
 *
 * Nunca se dice "lista para vender" sin el paso 5. Se guarda en esta computadora y, si la base lo tiene (migración 165),
 * en la ficha de la balanza (scale_profiles.install), así otra computadora de la sucursal ve lo mismo.
 * Sin dependencias de Supabase: lógica pura, testeada.
 */

export interface InstallRecord {
  model?: string | null;
  detectedAt?: string | null;
  communicationAt?: string | null;
  sentAt?: string | null;
  sentCount?: number | null;
  verifiedAt?: string | null;
  verifiedCount?: number | null;
  /** Productos que no quedaron bien en el último envío (0 = todos bien). */
  failedCount?: number | null;
  /** Última etiqueta que Mostrador leyó bien en la sucursal. */
  saleTestedAt?: string | null;
  saleTestDetail?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

export type InstallStepId = "reconocida" | "comunicacion" | "enviados" | "comprobados" | "venta";

export interface InstallStep {
  id: InstallStepId;
  label: string;
  done: boolean;
  detail: string;
}

const fmt = (iso: string, now: Date) => {
  const at = new Date(iso);
  const hh = at.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? `hoy ${hh}` : `${at.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })} ${hh}`;
};

const after = (a: string | null | undefined, b: string | null | undefined) => !!a && (!b || new Date(a).getTime() >= new Date(b).getTime());

/** Los 5 pasos, cada uno con lo que lo prueba. */
export function installSteps(r: InstallRecord, now = new Date()): InstallStep[] {
  const verifiedOk = !!r.verifiedAt && (r.failedCount ?? 0) === 0;
  const saleOk = verifiedOk && after(r.saleTestedAt, r.verifiedAt);
  return [
    { id: "reconocida", label: "Balanza reconocida", done: !!r.detectedAt, detail: r.detectedAt ? `${r.model ?? "Balanza"} · ${fmt(r.detectedAt, now)}` : "Todavía no contestó" },
    { id: "comunicacion", label: "Comunicación con la computadora", done: !!r.communicationAt, detail: r.communicationAt ? `Leída completa · ${fmt(r.communicationAt, now)}` : "Falta leerla" },
    {
      id: "enviados",
      label: "Productos en la balanza",
      done: !!r.sentAt,
      detail: r.sentAt ? `${r.sentCount ?? 0} ${r.sentCount === 1 ? "producto" : "productos"} · ${fmt(r.sentAt, now)}` : "Falta pasar los productos"
    },
    {
      id: "comprobados",
      label: "Productos comprobados",
      done: verifiedOk,
      detail: r.verifiedAt
        ? (r.failedCount ?? 0) > 0
          ? `${r.failedCount} no quedaron bien: hay que volver a pasarlos`
          : `${r.verifiedCount ?? 0} releídos de la balanza, iguales a Patagonia · ${fmt(r.verifiedAt, now)}`
        : "Se comprueban al pasarlos"
    },
    {
      id: "venta",
      label: "Venta probada en Mostrador",
      done: saleOk,
      detail: saleOk
        ? `${r.saleTestDetail ?? "Etiqueta leída bien"} · ${fmt(r.saleTestedAt!, now)}`
        : r.saleTestedAt && verifiedOk
          ? "Falta probar con una etiqueta impresa después del último envío"
          : "Pesá algo, imprimí la etiqueta y escaneala en Mostrador"
    }
  ];
}

/** La frase de estado de la tarjeta: lo último comprobado y lo que falta. */
export function installSummary(r: InstallRecord, now = new Date()): { tone: "ok" | "warn" | "bad"; text: string } {
  const steps = installSteps(r, now);
  if (r.lastError && after(r.lastErrorAt, r.verifiedAt) && after(r.lastErrorAt, r.communicationAt)) return { tone: "bad", text: `Último intento con problemas: ${r.lastError}` };
  const next = steps.find((s) => !s.done);
  if (!next) return { tone: "ok", text: `Lista para vender · etiqueta leída en Mostrador ${fmt(r.saleTestedAt!, now)}` };
  const done = steps.filter((s) => s.done).length;
  return { tone: "warn", text: `${done} de 5 pasos · falta: ${next.label.charAt(0).toLowerCase()}${next.label.slice(1)}` };
}

export function mergeInstall(base: InstallRecord | null | undefined, patch: InstallRecord): InstallRecord {
  const out: InstallRecord = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** El más nuevo de dos registros (esta computadora y la ficha central), campo por campo según la fecha de cada paso. */
export function newestInstall(a: InstallRecord | null | undefined, b: InstallRecord | null | undefined): InstallRecord {
  if (!a) return b ?? {};
  if (!b) return a;
  const pick = (at: keyof InstallRecord, keys: (keyof InstallRecord)[]): InstallRecord => {
    const src = after(a[at] as string | null | undefined, b[at] as string | null | undefined) ? a : b;
    return Object.fromEntries(keys.map((k) => [k, src[k] ?? null]));
  };
  return {
    ...pick("detectedAt", ["detectedAt", "model"]),
    ...pick("communicationAt", ["communicationAt"]),
    ...pick("sentAt", ["sentAt", "sentCount"]),
    ...pick("verifiedAt", ["verifiedAt", "verifiedCount", "failedCount"]),
    ...pick("saleTestedAt", ["saleTestedAt", "saleTestDetail"]),
    ...pick("lastErrorAt", ["lastError", "lastErrorAt"])
  };
}

// ── En esta computadora ─────────────────────────────────────────────────────────────────────────────────────────────

const KEY = "patagonia-scale-install";
const SALE_KEY = "patagonia-scale-sale-tested";

function read<T>(key: string): Record<string, T> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function write<T>(key: string, all: Record<string, T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // sin almacenamiento: queda la ficha central
  }
}

export function localInstall(branchId: string, scaleKey: string): InstallRecord | null {
  const r = read<InstallRecord>(KEY)[`${branchId}|${scaleKey}`] ?? null;
  const sale = read<{ at: string; detail: string }>(SALE_KEY)[branchId];
  return r || sale ? mergeInstall(r, sale && after(sale.at, r?.saleTestedAt) ? { saleTestedAt: sale.at, saleTestDetail: sale.detail } : {}) : null;
}

export function saveLocalInstall(branchId: string, scaleKey: string, patch: InstallRecord): InstallRecord {
  const all = read<InstallRecord>(KEY);
  const id = `${branchId}|${scaleKey}`;
  all[id] = mergeInstall(all[id], patch);
  write(KEY, all);
  return all[id];
}

/** Mostrador leyó bien una etiqueta de balanza en esta sucursal (no se sabe de cuál balanza: vale para todas). */
export function markLabelReadLocally(branchId: string, detail: string, now = new Date()): void {
  const all = read<{ at: string; detail: string }>(SALE_KEY);
  all[branchId] = { at: now.toISOString(), detail };
  write(SALE_KEY, all);
}
