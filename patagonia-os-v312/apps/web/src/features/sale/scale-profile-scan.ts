import type { Product } from "@patagonia/domain";
import { readKey, specToScaleConfig, type ScaleLabelProfile } from "../scales/label-spec";
import type { ScaleConfig } from "./scale-barcode";
import { labelWeightProblem, resolveScan, validEan13, type ScanChoice, type ScanResolution } from "./scan-resolve";

/**
 * LECTOR POR BALANZA (plan balanzas v2 §4.2, interruptor 'balanzas_v2'): Mostrador le pregunta a CADA balanza activa
 * de la sucursal (y a los perfiles anteriores todavía vigentes) si la etiqueta es suya.
 *
 * 1. Una balanza "reconoce" el código si tiene el largo de su perfil, el verificador EAN-13 cierra y empieza con uno de
 *    sus inicios. Si varias lo reconocen, mandan las del inicio más largo ("22" le gana a "2").
 * 2. Cada perfil que lo reconoce lo lee con su formato (la misma lectura de scan-resolve.ts que hoy).
 * 3. Regla de oro: si todas leen lo mismo, eso; si hay UNA lectura cobrable, esa; con dos o más cobrables distintas,
 *    "ambigua" (no se agrega nada, la cajera elige); sin ninguna cobrable, el aviso del primer perfil (el actual).
 * 4. Si ninguna balanza lo reconoce, se lee con el formato de la sucursal (respaldo para códigos que no son de balanza,
 *    tickets "0000…", y sucursales sin balanzas registradas).
 *
 * Puro (scale-profile-scan.test.ts y la equivalencia del banco de regresión).
 */

/** Cuántas cifras del inicio coinciden (0 = el perfil no reconoce el código). */
export function claimLength(profile: ScaleLabelProfile, raw: string): number {
  const s = profile.spec;
  if (!/^\d+$/.test(raw) || raw.length !== s.layout.length) return 0;
  if (raw.length === 13 && !validEan13(raw)) return 0;
  let best = 0;
  for (const p of [s.prefixes.weighed, s.prefixes.unit, s.prefixes.total]) {
    if (p && raw.startsWith(p) && p.length > best) best = p.length;
  }
  return best;
}

/**
 * Los perfiles que reconocen el código, el actual antes que los anteriores. El inicio más largo decide entre BALANZAS
 * ("22" le gana a "2"); dentro de una balanza que lo reconoce cuentan todos sus perfiles vigentes (una etiqueta vieja
 * con el formato anterior de esa misma balanza se sigue leyendo 7 días, con la regla de ambigüedad).
 */
export function claimingProfiles(profiles: ScaleLabelProfile[], raw: string): ScaleLabelProfile[] {
  const byScale = new Map<string, number>();
  const scored = profiles.map((p) => ({ p, n: claimLength(p, raw) })).filter((x) => x.n > 0);
  for (const x of scored) byScale.set(x.p.scaleKey, Math.max(byScale.get(x.p.scaleKey) ?? 0, x.n));
  if (byScale.size === 0) return [];
  const best = Math.max(...byScale.values());
  return scored.filter((x) => byScale.get(x.p.scaleKey) === best).map((x) => x.p);
}

const SAME_KG = 0.0005;

function cobrables(r: ScanResolution): ScanChoice[] {
  const ok = (c: ScanChoice) => c.type === "ticket_total" || labelWeightProblem(c.product.unit, c.quantity) === null;
  if (r.type === "label" || r.type === "ticket_total") return ok(r) ? [r] : [];
  if (r.type === "ambiguous") return r.options.filter(ok);
  return [];
}

function sameChoice(a: ScanChoice, b: ScanChoice): boolean {
  if (a.type === "ticket_total" || b.type === "ticket_total") return a.type === "ticket_total" && b.type === "ticket_total" && Math.abs(a.amount - b.amount) < 0.005;
  return a.product.id === b.product.id && Math.abs(a.quantity - b.quantity) < SAME_KG && (a.amount ?? null) === (b.amount ?? null);
}

/** El formato de la sucursal sin las marcas que agregaban las listas por cliente (el perfil las reemplaza). */
export function plainBranchConfig(config: ScaleConfig): ScaleConfig {
  const { auraPrefix22: _a, ownPrefix: _o, unitPrefix: _u, ...plain } = config;
  return plain;
}

export function resolveScanByProfiles(rawInput: string, products: Product[], profiles: ScaleLabelProfile[], branchConfig: ScaleConfig): ScanResolution {
  const raw = rawInput.trim();
  const claiming = claimingProfiles(profiles, raw);
  if (claiming.length === 0) return resolveScan(raw, products, plainBranchConfig(branchConfig));
  // Dos perfiles con el mismo formato leen lo mismo: se lee una vez.
  const seen = new Set<string>();
  const configs: ScaleConfig[] = [];
  for (const p of claiming) {
    const k = readKey(p.spec);
    if (seen.has(k)) continue;
    seen.add(k);
    configs.push(specToScaleConfig(p.spec));
  }
  const results = configs.map((c) => resolveScan(raw, products, c));
  if (results.length === 1) return results[0];
  if (results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))) return results[0];
  const choices: ScanChoice[] = [];
  for (const c of results.flatMap(cobrables)) if (!choices.some((x) => sameChoice(x, c))) choices.push(c);
  if (choices.length === 0) return results[0];
  if (choices.length === 1) return choices[0];
  return { type: "ambiguous", options: choices, note: "La etiqueta la pueden haber impreso dos balanzas de este local (o una con su formato anterior). Mirá el papel y elegí." };
}
