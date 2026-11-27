import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// El chat de ayuda tiene que contar Mostrador como es (regla del dueño): desde el 26/11 el TOTAL de la balanza ya no
// se cobra solo, una etiqueta dudosa pide elegir, existe "Cargando la balanza…" y la calibración puede pedir otra etiqueta.
const guide = readFileSync(new URL("../../../../../supabase/functions/help-chat/index.ts", import.meta.url), "utf8");

describe("GUIDE del chat de ayuda: balanzas en Mostrador", () => {
  it("ya no dice que detallar el TOTAL es opcional", () => {
    assert.doesNotMatch(guide, /Detallar productos[^.]*opcional/);
    assert.doesNotMatch(guide, /Terminar después/);
  });

  it("explica el detalle obligatorio, la elección, la carga y la calibración", () => {
    assert.match(guide, /el TOTAL solo NO se cobra/);
    assert.match(guide, /Ninguna: lo cargo a mano/);
    assert.match(guide, /Cargando la balanza…/);
    assert.match(guide, /una segunda etiqueta/);
  });
});
