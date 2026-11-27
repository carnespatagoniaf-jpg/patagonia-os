import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validEan13 } from "./scan-resolve";
import { readLabel, type RegressionBank } from "./scale-labels-regression-run";

/**
 * BANCO DE REGRESIÓN DE ETIQUETAS (plan balanzas v2, etapa 0).
 *
 * Cada etiqueta real de balanza que aparece en el repo (pruebas, fixtures y commits), con lo mínimo de su sucursal y
 * lo que Mostrador hace HOY con ella. Es una FOTO: si un cambio mueve cualquier resultado, falla y muestra la tabla
 * "antes → ahora". No se cambia un esperado para que pase: si el cambio es a propósito, se cambia en el mismo PR y se
 * explica (sobre todo si toca kilos o importe que se cobran).
 *
 * Datos: fixtures/etiquetas-reales.json (formato explicado en su "_leeme"). Lectura: scale-labels-regression-run.ts.
 *
 * Lecturas que hoy parecen mal y se dejan tal cual (también marcadas con "sospechoso" en el JSON):
 */
const SOSPECHOSAS: Record<string, true> = {
  // SOSPECHOSO: TripleS con la sucursal sin configurar (fábrica 1-5-5): 0,175 kg entra como 0,017 kg sin ningún aviso.
  "2001230001759@triples-fabrica": true,
  // SOSPECHOSO: El Dorado con el formato de fábrica: el importe $99.934 se lee como 99,934 kg (solo frena la pregunta de > 31 kg).
  "2000019993407@el-dorado-fabrica": true,
  // SOSPECHOSO: El Dorado con el formato viejo guardado en la PC: igual, $99.934 como 99,934 kg (solo frena la pregunta).
  "2010060999341@el-dorado-systel-viejo": true,
  // SOSPECHOSO: El Dorado por perfiles: se cobra 5,555 kg × $17.990 = $99.934,45, no el importe impreso $99.934.
  "2010060999341@el-dorado-perfil": true
};

const bank = JSON.parse(readFileSync(new URL("./fixtures/etiquetas-reales.json", import.meta.url), "utf8")) as RegressionBank;
const key = (e: { codigo: string; contexto: string }) => `${e.codigo}@${e.contexto}`;

describe("Banco de regresión de etiquetas reales (cómo lee Mostrador hoy)", () => {
  it("el banco está completo y bien armado", () => {
    assert.ok(bank.etiquetas.length >= 80, `hay ${bank.etiquetas.length} lecturas`);
    const clientes = new Set(bank.etiquetas.map((e) => e.cliente));
    for (const c of ["El Abastero", "Oliem", "Lauda", "Carplat", "Los gringos", "El Dorado", "Quesar", "Giuseppe", "Mercado de la Cruz", "Pollo y mar", "TripleS", "Carnes Patagonia"]) {
      assert.ok(clientes.has(c), `falta ${c}`);
    }
    const keys = bank.etiquetas.map(key);
    assert.equal(new Set(keys).size, keys.length, "misma etiqueta con el mismo contexto repetida");
    for (const e of bank.etiquetas) {
      const ctx = bank.contextos[e.contexto];
      assert.ok(ctx, `${e.codigo}: contexto ${e.contexto} inexistente`);
      assert.equal(ctx.cliente, e.cliente, `${e.codigo}: el cliente no es el del contexto`);
      assert.ok(e.evidencia === "real" || e.evidencia === "prueba", `${e.codigo}: evidencia`);
      // Lo que imprime una balanza siempre tiene el verificador bien (salvo el código en blanco "0 000000 000000").
      if (e.evidencia === "real" && !/^0+$/.test(e.codigo)) assert.ok(validEan13(e.codigo), `${e.codigo}: verificador EAN-13`);
    }
  });

  it("las marcadas SOSPECHOSO en esta prueba son las mismas que en el JSON", () => {
    const enJson = bank.etiquetas.filter((e) => e.sospechoso).map(key).sort();
    assert.deepEqual(enJson, Object.keys(SOSPECHOSAS).sort());
  });

  it("cada etiqueta se lee EXACTAMENTE como hoy", () => {
    const cambios: string[] = [];
    for (const e of bank.etiquetas) {
      const r = readLabel(e.codigo, bank.contextos[e.contexto]);
      if (r.resultado !== e.esperado) cambios.push(`${e.cliente} · ${e.codigo} (${e.contexto})${e.papel ? ` · papel: ${e.papel}` : ""}\n    antes: ${e.esperado}\n    ahora: ${r.resultado}${r.mensaje ? ` — ${r.mensaje.slice(0, 160)}` : ""}`);
      else if (e.mensaje && !r.mensaje.includes(e.mensaje)) cambios.push(`${e.cliente} · ${e.codigo} (${e.contexto})\n    el aviso ya no dice "${e.mensaje}": ${r.mensaje.slice(0, 160)}`);
    }
    assert.equal(cambios.length, 0, `Cambió la lectura de ${cambios.length} etiqueta(s) real(es):\n  ${cambios.join("\n  ")}`);
  });
});
