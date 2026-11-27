import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../scales/test-fake-storage";
import { DEFAULT_SCALE_CONFIG } from "./scale-barcode";
import { CARNES_PATAGONIA_CONFIG } from "./scale-real-labels";
import { cachedScaleConfig, initialScaleConfigState, isScaleConfigUnknown, SCALE_CONFIG_UNKNOWN, scaleConfigLoaded, scaleConfigOnError } from "./scale-config-cache";
import { resolveScan } from "./scan-resolve";
import type { Product } from "@patagonia/domain";

describe("formato de etiquetas cuando falla la carga (auditoría 28/10)", () => {
  beforeEach(() => installFakeLocalStorage());

  it("sin nada guardado, no se leen etiquetas (antes: formato de fábrica, que lee otro producto)", () => {
    const s = scaleConfigOnError("b1");
    assert.equal(s.unknown, true);
    // Etiqueta real 1-6-5 de Carnes Patagonia: con el de fábrica leía el producto 12 en vez del 123.
    const products = [{ id: "a", code: "12", name: "Otro", unit: "kg", priceRetail: 1000, active: true }] as unknown as Product[];
    assert.equal(resolveScan("2000123012346", products, DEFAULT_SCALE_CONFIG).type, "label", "el de fábrica la lee como el producto 12");
    assert.equal(resolveScan("2000123012346", products, s.config).type, "search");
  });

  it("con internet guarda el formato; sin internet usa el último guardado", () => {
    scaleConfigLoaded("b1", CARNES_PATAGONIA_CONFIG);
    assert.deepEqual(scaleConfigOnError("b1"), { config: CARNES_PATAGONIA_CONFIG, calibrated: true, unknown: false });
    assert.equal(cachedScaleConfig("b2"), null, "es por sucursal");
  });

  it("una sucursal sin calibrar sigue con el formato de fábrica, también sin internet", () => {
    scaleConfigLoaded("b1", null);
    assert.deepEqual(scaleConfigOnError("b1"), { config: DEFAULT_SCALE_CONFIG, calibrated: false, unknown: false });
  });
});

describe("C5: al abrir Mostrador o Clientes el formato arranca DESCONOCIDO, no el de fábrica", () => {
  beforeEach(() => installFakeLocalStorage());

  it("PC nueva o navegador borrado: cargando, no se leen etiquetas hasta que llega la base", () => {
    const s = initialScaleConfigState("b1");
    assert.equal(s.status, "loading");
    assert.equal(s.config.totalLength, SCALE_CONFIG_UNKNOWN.totalLength);
    assert.equal(isScaleConfigUnknown(s.config), true);
  });

  it("con la copia de esta PC arranca con esa copia (sirve sin conexión)", () => {
    scaleConfigLoaded("b1", CARNES_PATAGONIA_CONFIG);
    const s = initialScaleConfigState("b1");
    assert.equal(s.status, "ready");
    assert.deepEqual(s.config, CARNES_PATAGONIA_CONFIG);
    assert.equal(s.calibrated, true);
  });

  it("sin sucursal todavía: cargando", () => {
    assert.equal(initialScaleConfigState(null).status, "loading");
  });
});
