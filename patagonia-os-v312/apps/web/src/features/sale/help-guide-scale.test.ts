import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// El chat de ayuda tiene que contar Mostrador como es (regla del dueño). Sin balanzas_v2 el TOTAL de la balanza se cobra
// como siempre, con "Detallar productos" opcional (dueño 28/11: "a los clientes que estan ya funcionando no le toques
// nada"); con balanzas_v2 no se cobra solo. Una etiqueta dudosa pide elegir, existe "Cargando la balanza…" y la
// calibración puede pedir otra etiqueta.
const guide = readFileSync(new URL("../../../../../supabase/functions/help-chat/index.ts", import.meta.url), "utf8");

describe("GUIDE del chat de ayuda: balanzas en Mostrador", () => {
  it("cuenta el TOTAL como funciona sin balanzas_v2 (detalle opcional) y con balanzas_v2 (obligatorio)", () => {
    assert.match(guide, /"Detallar productos \(descuenta stock\)", que es opcional/);
    assert.match(guide, /versión nueva de balanzas[^)]*el TOTAL solo NO se cobra/);
  });

  it("explica el detalle obligatorio, la elección, la carga y la calibración", () => {
    assert.match(guide, /Ninguna: lo cargo a mano/);
    assert.match(guide, /Cargando la balanza…/);
    assert.match(guide, /una segunda etiqueta/);
  });
});
