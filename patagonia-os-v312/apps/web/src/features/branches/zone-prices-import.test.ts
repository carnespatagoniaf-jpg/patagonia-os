import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunk, readZonePrices, zonePricesSheet, type ImportBranch, type ImportProduct, type ImportZone } from "./zone-prices-import";

const products: ImportProduct[] = [
  { id: "p1", code: "10", name: "Asado" },
  { id: "p2", code: "20", name: "Vacío", listPrices: { z1: { price: 9000, manual: true } } },
  { id: "p3", code: "30", name: "Matambre" }
];
const branches: ImportBranch[] = [
  { id: "b1", name: "Trejo", zoneId: null },
  { id: "b2", name: "27 de abril", zoneId: "z1" },
  { id: "b3", name: "Risco", zoneId: "z2" },
  { id: "b4", name: "Cañada", zoneId: "z2" }
];
const zones: ImportZone[] = [
  { id: "z1", name: "Zona 27" },
  { id: "z2", name: "Zona Norte" }
];

describe("readZonePrices", () => {
  it("una columna por local: sin zona = zona nueva, con zona propia = esa zona", () => {
    const r = readZonePrices(
      [
        ["Código", "Producto", "Trejo", "27 de Abril"],
        [10, "Asado", "12.500", 13000],
        ["20", "Vacío", "", "9000"]
      ],
      products,
      branches,
      zones
    );
    assert.equal(r.rows, 2);
    assert.deepEqual(r.columns.map((c) => c.target), [
      { kind: "new-zone", branchId: "b1", label: "Trejo" },
      { kind: "zone", zoneId: "z1", label: "27 de abril", branchName: "27 de abril" }
    ]);
    assert.deepEqual([...r.columns[0].prices], [["p1", 12500]]);
    assert.deepEqual([...r.columns[1].prices], [["p1", 13000], ["p2", 9000]]);
    // Vacío ya estaba a mano en 9000: no cuenta como cambio.
    assert.equal(r.columns[1].changed, 1);
    assert.equal(r.errors.length, 0);
  });

  it("local en zona compartida no se toca; por el nombre de la zona sí", () => {
    const r = readZonePrices([["Codigo", "Risco", "Zona Norte"], ["30", 100, 200]], products, branches, zones);
    assert.deepEqual(r.shared, [{ header: "Risco", zoneName: "Zona Norte" }]);
    assert.equal(r.columns.length, 1);
    assert.deepEqual([...r.columns[0].prices], [["p3", 200]]);
  });

  it("encabezados con 'Precio', título arriba, y búsqueda por nombre sin código", () => {
    const r = readZonePrices(
      [
        ["Lista de precios noviembre"],
        ["Producto", "Precio Trejo"],
        ["vacio", "$ 15.000,50"],
        ["Bondiola", 1]
      ],
      products,
      branches,
      zones
    );
    assert.deepEqual([...r.columns[0].prices], [["p2", 15000.5]]);
    assert.deepEqual(r.unknown, [{ row: 4, text: "Bondiola" }]);
  });

  it("avisa celdas que no son precio y columnas que no son un local", () => {
    const r = readZonePrices([["Código", "Trejo", "Costo", "Sucursal X"], ["10", "abc", 5, 1], ["20", 0, 5, 1]], products, branches, zones);
    assert.deepEqual(r.ignored, ["Sucursal X"]);
    assert.equal(r.errors.length, 2);
    assert.equal(r.columns[0].prices.size, 0);
  });

  it("sin columna de local: error claro", () => {
    assert.throws(() => readZonePrices([["Código", "Precio"], ["10", 1]], products, branches, zones), /Ninguna columna tiene el nombre de un local/);
    assert.throws(() => readZonePrices([["a", "b"], ["10", 1]], products, branches, zones), /No encontré la columna/);
  });
});

describe("zonePricesSheet", () => {
  it("una columna por local con el precio de hoy", () => {
    const sheet = zonePricesSheet([{ ...products[1], priceRetail: 8000 }], branches.slice(0, 2));
    assert.deepEqual(sheet, [
      ["Código", "Producto", "General", "Trejo", "27 de abril"],
      ["20", "Vacío", 8000, 8000, 9000]
    ]);
  });

  it("la planilla bajada se vuelve a leer igual", () => {
    const sheet = zonePricesSheet(products.map((p) => ({ ...p, priceRetail: 100 })), branches.slice(0, 2));
    const r = readZonePrices(sheet, products, branches, zones);
    assert.equal(r.rows, 3);
    assert.equal(r.columns.length, 2);
    assert.deepEqual(r.ignored, []);
  });
});

describe("chunk", () => {
  it("parte de a N", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
});
