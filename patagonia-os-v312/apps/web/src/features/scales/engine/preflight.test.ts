import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODEL_LIMITS, systelLimits } from "./capabilities";
import { labelMaxCodeFromFormat, preflightProducts, scaleName } from "./preflight";
import type { EngineProduct } from "./types";

const P = (code: string, name: string, priceRetail: number, unit = "kg", active = true): EngineProduct => ({ id: `id-${code}-${name}`, code, name, unit, priceRetail, active });

describe("revisión antes de mandar productos (etapa 1)", () => {
  const report = MODEL_LIMITS["kretz-report-lt"]!;

  it("manda exacto lo que se puede y explica cada uno que no (catálogo como el de M2)", () => {
    const r = preflightProducts(
      [
        P("2", "Matambre novillo gorina", 13700),
        P("151", "Salchicha viena xKG", 6000),
        P("7798474990011", "Aceite Sol 900cc", 2400, "unit"),
        P("1510", "Código largo", 6000),
        P("50", "Con centavos", 4599.5),
        P("51", "Sin precio", 0),
        P("SIN", "Sin número", 100),
        P("60", "Repetido A", 100),
        P("60", "Repetido B", 100),
        P("70", "Inactivo", 100, "kg", false)
      ],
      report
    );
    assert.deepEqual(r.ready.map((p) => p.code), ["2", "151"]);
    const why = Object.fromEntries(r.problems.map((p) => [p.name, p.reason]));
    assert.match(why["Aceite Sol 900cc"], /código de barras de fábrica/);
    assert.match(why["Código largo"], /más de 3 cifras y la etiqueta lleva 3/);
    assert.match(why["Con centavos"], /centavos/);
    assert.match(why["Sin precio"], /no tiene precio/);
    assert.match(why["Sin número"], /no es un número/);
    assert.match(why["Repetido A"], /2 productos con el código 60/);
    assert.equal(why["Inactivo"], undefined, "los inactivos ni se revisan");
  });

  it("avisa cómo queda el nombre si no entra (Aura: 16 letras)", () => {
    const r = preflightProducts([P("6", "Milanesa de berenjena", 6100)], MODEL_LIMITS["kretz-aura"]!);
    assert.equal(r.ready.length, 1);
    assert.match(r.warnings[0].reason, /"MILANESA DE BERE"/);
    assert.equal(scaleName("Ñoquis", 16), "NOQUIS");
  });

  it("precio más alto de lo que entra: no se manda", () => {
    const r = preflightProducts([P("9", "Caro", 1_500_000)], report);
    assert.match(r.problems[0].reason, /más alto de lo que entra/);
  });

  it("Systel: los límites salen de lo que informó la balanza (Los gringos: 20PPPPCCCCCC, sin centavos)", () => {
    const limits = systelLimits({ maxPlu: 9999, maxCode: 99997 }, 0, ["20PPPPCCCCCC", "21PPPPCCCCCC"]);
    assert.equal(limits.labelMaxCode, 9999);
    assert.equal(limits.priceDecimals, 0);
    const r = preflightProducts([P("13", "Pechuga", 9200), P("12345", "Largo", 100), P("14", "Centavos", 100.5)], limits);
    assert.deepEqual(r.ready.map((p) => p.code), ["13"]);
    // Con 2 decimales los centavos van.
    const cents = preflightProducts([P("14", "Centavos", 100.5)], systelLimits({ maxPlu: 9999, maxCode: 99997 }, 2, []));
    assert.equal(cents.ready.length, 1);
    assert.equal(labelMaxCodeFromFormat("22BBIIIIIIII"), null);
  });
});
