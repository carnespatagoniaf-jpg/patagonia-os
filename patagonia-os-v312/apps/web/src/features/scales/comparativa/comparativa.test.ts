import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { ESCENARIOS, correrEscenario, type Cargador } from "./escenarios";

/**
 * Parte "nuevo" de la prueba comparativa de balanzas (docs/COMPARATIVA_BALANZAS.md): cada caso real de un cliente tiene
 * que dar el resultado correcto con el código de esta rama. Si un cambio vuelve a romper uno, falla acá.
 *
 * HALLAZGOS_ABIERTOS: casos que el sistema nuevo TODAVÍA hace mal (están en el informe). Corren igual, marcados "todo"
 * (no frenan el test). Cuando se arreglen, se sacan de acá y pasan a ser obligatorios.
 */
const HALLAZGOS_ABIERTOS: Record<string, string> = {
  E15: "Sucursal sin formato guardado: la etiqueta Systel de TripleS se sigue leyendo con el formato de fábrica (0,017 kg)"
};

const base = new URL("../../", import.meta.url);
const archivo = (ruta: string) => new URL(`${ruta}.ts`, base);
const nuevo: Cargador = {
  version: "nuevo",
  tiene: (ruta) => existsSync(archivo(ruta)),
  importar: (ruta) => import(archivo(ruta).href)
};

describe("Comparativa de balanzas: el sistema nuevo resuelve cada caso real", () => {
  for (const e of ESCENARIOS) {
    const abierto = HALLAZGOS_ABIERTOS[e.id];
    it(`${e.id} ${e.titulo} (${e.cliente}, ${e.fecha})`, abierto ? { todo: abierto } : {}, async () => {
      const r = await correrEscenario(e, nuevo);
      assert.ok(r.correcto, `Esperado: ${e.esperado}\nObservado: ${r.resultado}`);
    });
  }

  it("cada escenario tiene cliente, fecha, qué pasó, entrada, resultado esperado y fuente", () => {
    assert.ok(ESCENARIOS.length >= 15);
    assert.equal(new Set(ESCENARIOS.map((e) => e.id)).size, ESCENARIOS.length);
    for (const e of ESCENARIOS) for (const k of ["cliente", "fecha", "quePaso", "entrada", "esperado", "fuente"] as const) assert.ok(e[k].trim(), `${e.id}: falta ${k}`);
  });
});
