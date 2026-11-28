import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AURA_22_CONFIG, KRETZ_PLU5_WEIGHT_CONFIG } from "../sale/scan-resolve";
import { REPORT_PESOS_SCALE_CONFIG } from "./engine/adapters/kretz";
import {
  activeLabelProfiles,
  allocatablePrefixes,
  kretzOwnPrefix,
  LEGACY_LIST_1070,
  labelSpecProblem,
  prefixesOverlap,
  specFromKretz1070,
  specFromToday,
  specPrefixes,
  specToScaleConfig,
  specWithOwnPrefix,
  systelSpec,
  systelTicketCodes,
  type LabelSpec,
  type LegacyList
} from "./label-spec";

const sql = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const testSql = (name: string) => readFileSync(new URL(`../../../../../tests/sql/${name}`, import.meta.url), "utf8");
const AURA_ITEM = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };

describe("Perfil de etiqueta: las 4 listas por cliente como dato", () => {
  it("cada lista lee EXACTAMENTE con el formato que hoy le deja a la sucursal", () => {
    assert.deepEqual(specToScaleConfig(specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: null, list: "report_peso" })), AURA_ITEM);
    assert.deepEqual(specToScaleConfig(specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: null, list: "report_pesos" })), REPORT_PESOS_SCALE_CONFIG);
    assert.deepEqual(specToScaleConfig(specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: null, list: "report_plu5" })), KRETZ_PLU5_WEIGHT_CONFIG);
    // La Aura con inicio 22: 2-3-7 en centavos con su inicio propio (lo que hacía la marca auraPrefix22).
    assert.deepEqual(specToScaleConfig(specFromToday({ family: "kretz", model: "Kretz Aura", branchConfig: null, list: "aura_22" })), { ...AURA_22_CONFIG, ownPrefix: "22" });
  });

  it("los perfiles de la migración 223 son los mismos que arma label-spec.ts", () => {
    const text = sql("223_scale_label_spec_data.sql");
    for (const list of Object.keys(LEGACY_LIST_1070) as LegacyList[]) {
      const m = new RegExp(`\\('${list}', '(\\{.*?\\})'::jsonb\\)`).exec(text);
      assert.ok(m, `falta ${list} en la 223`);
      assert.deepEqual(JSON.parse(m![1]), specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: null, list }), list);
    }
  });

  it("el resto: el formato de la sucursal y lo que se manda hoy (iguales a tests/sql/223)", () => {
    const text = testSql("223_scale_label_spec_data.sql");
    const literal = (key: string) => JSON.parse(new RegExp(`scale_key = '${key}'\\) <> '(\\{.*?\\})'::jsonb`).exec(text)![1]) as LabelSpec;
    assert.deepEqual(literal("kretz-x"), specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" } }));
    assert.deepEqual(literal("systel-x"), specFromToday({ family: "systel", model: "Systel Cuora Max", branchConfig: { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" }, totalFormat: "22AAIIIIIIII" }));
    assert.deepEqual(literal("aura-y"), specFromToday({ family: "kretz", model: "Kretz Aura", branchConfig: null }));
    assert.deepEqual(literal("kretz-cp"), specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: null, list: "report_peso" }));
  });

  it("perfil desde la sucursal: la lectura es la del formato guardado, sin cambiar nada", () => {
    const c = { prefixLength: 2, pluLength: 4, weightLength: 6, weightDivisor: 1000, totalLength: 13, payloadType: "weight" as const };
    assert.deepEqual(specToScaleConfig(specFromToday({ family: "systel", model: null, branchConfig: c })), c);
    const pesos = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" as const };
    const s = specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: pesos });
    assert.equal(s.value, "amount_pesos");
    assert.equal(s.writer, null, "la Report decide el 1070 por la conexión, como hoy");
    assert.deepEqual(specToScaleConfig(s), pesos);
  });
});

describe("Perfil de etiqueta: 1070 e inicio propio", () => {
  it("lee los 1070 que manda Patagonia y rechaza los que no sabe leer", () => {
    assert.deepEqual(specPrefixes(specFromKretz1070("2002005")!), ["20"]);
    assert.equal(specFromKretz1070("2202205")!.sumCode, 998);
    assert.equal(specFromKretz1070("2112005")!.weighedValue, "weight_g");
    assert.equal(specFromKretz1070("2112001")!.unitValue, "amount_pesos");
    assert.equal(specFromKretz1070("2101205"), null, "21 con importe y 20 con peso: no está probado");
    assert.equal(specFromKretz1070("2102105"), null);
    assert.equal(specFromKretz1070("abc"), null);
  });

  it("Kretz con inicio propio: 2-3-7 en centavos con 1070 PP0PP05 (igual que la 222)", () => {
    const s = specWithOwnPrefix("kretz", "25");
    assert.equal(s.writer?.kind === "kretz1070" && s.writer.code, "2502505");
    assert.equal(kretzOwnPrefix(s), "25");
    assert.equal(specToScaleConfig(s).ownPrefix, "25");
    assert.equal(labelSpecProblem(s), null);
    const text = testSql("222_scale_label_spec.sql");
    const lit = /scale_label_spec_with_prefix\('kretz', '22', null\) <> '(\{.*?\})'::jsonb/.exec(text)!;
    assert.deepEqual(JSON.parse(lit[1]), specWithOwnPrefix("kretz", "22"));
  });

  it("Systel: la de siempre (20/21 + TOTAL reservado) o inicio propio para pesables y unitarios", () => {
    const text = testSql("222_scale_label_spec.sql");
    const lit = (p: string) => JSON.parse(new RegExp(`scale_label_spec_with_prefix\\('systel', '${p}', '22AAIIIIIIII'\\) <> '(\\{.*?\\})'::jsonb`).exec(text)![1]);
    assert.deepEqual(lit("20"), systelSpec("22AAIIIIIIII", "20"));
    assert.deepEqual(lit("23"), specWithOwnPrefix("systel", "23", "22AAIIIIIIII"));
    assert.deepEqual(systelTicketCodes(specWithOwnPrefix("systel", "23")), { weighed: "23PPPPCCCCCC", unit: "23PPPPCCCCCC" });
    assert.deepEqual(systelTicketCodes(null), { weighed: "20PPPPCCCCCC", unit: "21PPPPCCCCCC" });
    assert.equal(specToScaleConfig(specWithOwnPrefix("systel", "23")).unitPrefix, "23");
    assert.equal(specToScaleConfig(systelSpec(null)).unitPrefix, undefined);
  });

  it("inicios asignables: la Systel nunca recibe el 22 (su TOTAL)", () => {
    assert.ok(!allocatablePrefixes("systel").includes("22"));
    assert.equal(allocatablePrefixes("kretz")[0], "23");
    assert.equal(allocatablePrefixes("kretz").at(-1), "22", "el 22 (TOTAL de la Cuora) solo si no queda otro");
    assert.ok(prefixesOverlap("2", "22") && prefixesOverlap("20", "20") && !prefixesOverlap("20", "22"));
  });

  it("valida la forma (igual que scale_label_spec_problem)", () => {
    const ok = specWithOwnPrefix("kretz", "22");
    assert.equal(labelSpecProblem({ ...ok, v: 2 }), "versión desconocida");
    assert.equal(labelSpecProblem({ ...ok, prefixes: { weighed: "30", unit: null, total: null } }), "inicio weighed inválido");
    assert.equal(labelSpecProblem({ ...ok, layout: { ...ok.layout, code: 5 } }), "las cifras no entran en el largo");
    assert.equal(labelSpecProblem({ ...ok, writer: { kind: "kretz1070", code: "9999999" } }), "1070 inválido");
  });
});

describe("Perfiles vigentes de la sucursal", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  it("el actual de cada balanza activa + los anteriores que no vencieron", () => {
    const rows = [
      { scale_key: "a", name: "A", status: "active", label_spec: specWithOwnPrefix("kretz", "22"), label_spec_history: [{ spec: specFromKretz1070("2002005"), valid_until: "2026-12-01T00:00:00Z" }, { spec: specFromKretz1070("2112005"), valid_until: "2026-11-20T00:00:00Z" }] },
      { scale_key: "b", name: "B", status: "inactive", label_spec: specFromKretz1070("2002005"), label_spec_history: [] },
      { scale_key: "c", name: "C", status: "active", label_spec: { v: 9 }, label_spec_history: null }
    ];
    const ps = activeLabelProfiles(rows, now);
    assert.deepEqual(ps.map((p) => [p.scaleKey, p.validUntil]), [["a", null], ["a", "2026-12-01T00:00:00Z"]]);
  });
});
