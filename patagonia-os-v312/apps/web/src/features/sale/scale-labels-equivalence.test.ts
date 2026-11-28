import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { specFromToday, type LegacyList, type ScaleFamilyName, type ScaleLabelProfile } from "../scales/label-spec";
import { readLabel, readLabelByProfiles, type RegressionBank } from "./scale-labels-regression-run";

/**
 * EQUIVALENCIA (plan balanzas v2 §3.3, obligatoria antes de encender 'balanzas_v2'): el banco de regresión de etiquetas
 * reales se lee DOS veces, con el lector de hoy (formato de la sucursal + listas por cliente) y con el lector por
 * perfiles alimentado con lo que cargaría la migración 223 (fixtures/perfiles-223.json). Tienen que dar IDÉNTICO.
 * Una diferencia solo se acepta si pasa a "ambigua" y está justificada acá abajo, una por una (hoy: ninguna).
 */
const DIFERENCIAS_ACEPTADAS: Record<string, string> = {};

interface Balanza223 {
  familia: ScaleFamilyName;
  modelo: string;
  lista?: LegacyList;
  total?: string;
}

const bank = JSON.parse(readFileSync(new URL("./fixtures/etiquetas-reales.json", import.meta.url), "utf8")) as RegressionBank;
const perfiles = JSON.parse(readFileSync(new URL("./fixtures/perfiles-223.json", import.meta.url), "utf8")) as { contextos: Record<string, Balanza223[]> };

function profilesFor(contexto: string): ScaleLabelProfile[] | null {
  const ctx = bank.contextos[contexto];
  if (ctx.lector !== "sucursal") return null;
  const balanzas = perfiles.contextos[contexto];
  assert.ok(balanzas, `faltan las balanzas de ${contexto} en perfiles-223.json`);
  const { auraPrefix22: _x, ...branchConfig } = ctx.formato;
  return balanzas.map((b, i) => ({
    scaleKey: `${b.familia}-${i}`,
    name: b.modelo,
    spec: specFromToday({ family: b.familia, model: b.modelo, branchConfig, list: b.lista ?? null, totalFormat: b.total ?? null }),
    validUntil: null
  }));
}

describe("Equivalencia: lector de hoy vs lector por perfiles (lo que cargaría la 223)", () => {
  it("las 81 lecturas reales dan IDÉNTICO", () => {
    const cambios: string[] = [];
    let porPerfiles = 0;
    for (const e of bank.etiquetas) {
      const ctx = bank.contextos[e.contexto];
      const hoy = readLabel(e.codigo, ctx);
      const profiles = profilesFor(e.contexto);
      if (profiles) porPerfiles++;
      const nuevo = profiles ? readLabelByProfiles(e.codigo, ctx, profiles) : readLabel(e.codigo, ctx);
      const k = `${e.codigo}@${e.contexto}`;
      if (nuevo.resultado === hoy.resultado && nuevo.mensaje === hoy.mensaje) continue;
      if (DIFERENCIAS_ACEPTADAS[k] && nuevo.resultado === "AMBIGUO") continue;
      cambios.push(`${e.cliente} · ${k}\n    hoy:    ${hoy.resultado} ${hoy.mensaje.slice(0, 120)}\n    perfil: ${nuevo.resultado} ${nuevo.mensaje.slice(0, 120)}`);
    }
    assert.equal(cambios.length, 0, `Distinto en ${cambios.length} de ${bank.etiquetas.length}:\n  ${cambios.join("\n  ")}`);
    assert.equal(bank.etiquetas.length, 81);
    // La mayoría pasa de verdad por el lector nuevo (las demás son Systel por perfil o piloto, que no cambian).
    assert.ok(porPerfiles >= 60, `solo ${porPerfiles} pasaron por el lector por perfiles`);
  });

  it("cada contexto 'sucursal' tiene sus balanzas en perfiles-223.json", () => {
    for (const [k, c] of Object.entries(bank.contextos)) if (c.lector === "sucursal") assert.ok(perfiles.contextos[k], k);
  });
});
