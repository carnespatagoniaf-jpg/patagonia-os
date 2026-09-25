import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TEMPLATES,
  buildCustomerRows,
  buildProductRows,
  buildSupplierRows,
  decodeFileBytes,
  mapColumns,
  normalizeHeader,
  parseDelimited,
  parseNumberCell,
  parseUnit,
  summarize
} from "./import-parse";

describe("parseDelimited", () => {
  it("separa por ; (Excel en español) y por coma y por tabulación (pegado desde Excel)", () => {
    assert.deepEqual(parseDelimited("a;b;c\n1;2;3"), [["a", "b", "c"], ["1", "2", "3"]]);
    assert.deepEqual(parseDelimited("a,b,c\r\n1,2,3\r\n"), [["a", "b", "c"], ["1", "2", "3"]]);
    assert.deepEqual(parseDelimited("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  });

  it("respeta comillas, separadores y saltos de línea dentro de un campo", () => {
    assert.deepEqual(parseDelimited('n;t\n"Ñoquis; con ""salsa""";"l1\nl2"'), [["n", "t"], ['Ñoquis; con "salsa"', "l1\nl2"]]);
  });

  it("saca el BOM inicial", () => {
    assert.deepEqual(parseDelimited("﻿a;b\n1;2")[0], ["a", "b"]);
  });
});

describe("decodeFileBytes", () => {
  it("lee UTF-8 y, si no es válido, Windows-1252 (CSV de Excel en español)", () => {
    const utf8 = new TextEncoder().encode("Categoría;Ñandú").buffer as ArrayBuffer;
    assert.equal(decodeFileBytes(utf8), "Categoría;Ñandú");
    const latin1 = new Uint8Array([0x43, 0x61, 0x74, 0x65, 0x67, 0x6f, 0x72, 0xed, 0x61]).buffer as ArrayBuffer; // "Categoría" en 1252
    assert.equal(decodeFileBytes(latin1), "Categoría");
  });
});

describe("parseNumberCell", () => {
  it("interpreta formato argentino en precios y costos", () => {
    assert.equal(parseNumberCell("1.234,56", true).value, 1234.56);
    assert.equal(parseNumberCell("$ 15.000", true).value, 15000);
    assert.equal(parseNumberCell("12000", true).value, 12000);
    assert.equal(parseNumberCell("9500,50", true).value, 9500.5);
    assert.equal(parseNumberCell("1,234.56", true).value, 1234.56);
  });

  it("en stock, el punto es decimal (12.5 kg) y la coma también", () => {
    assert.equal(parseNumberCell("12.5", false).value, 12.5);
    assert.equal(parseNumberCell("0.750", false).value, 0.75);
    assert.equal(parseNumberCell("12,5", false).value, 12.5);
    assert.equal(parseNumberCell("15.000", false).value, 15);
  });

  it("acepta números de Excel, vacíos, y rechaza texto", () => {
    assert.equal(parseNumberCell(25.5, true).value, 25.5);
    assert.deepEqual(parseNumberCell("", true), { value: null, invalid: false });
    assert.deepEqual(parseNumberCell(undefined, true), { value: null, invalid: false });
    assert.equal(parseNumberCell("abc", true).invalid, true);
    assert.equal(parseNumberCell("12kg", false).value, 12);
  });
});

describe("mapColumns y unidades", () => {
  it("reconoce encabezados con sinónimos, tildes y mayúsculas", () => {
    const m = mapColumns("products", ["PLU", "Descripción", "U.M.", "Precio Venta", "Costo", "Stock actual", "Rubro", "Color"]);
    assert.deepEqual(m.columns, { code: 0, name: 1, unit: 2, price: 3, cost: 4, stock: 5, category: 6 });
    assert.deepEqual(m.ignored, ["Color"]);
    assert.deepEqual(m.missingRequired, []);
  });

  it("avisa qué columnas obligatorias faltan", () => {
    assert.deepEqual(mapColumns("products", ["Nombre", "Precio"]).missingRequired, ["code"]);
    assert.deepEqual(mapColumns("suppliers", ["Teléfono"]).missingRequired, ["name"]);
  });

  it("normaliza encabezados y unidades", () => {
    assert.equal(normalizeHeader(" Precio de Venta "), "preciodeventa");
    assert.equal(parseUnit("Kilos"), "kg");
    assert.equal(parseUnit("UN."), "unit");
    assert.equal(parseUnit("caja"), "box");
    assert.equal(parseUnit("litro"), null);
  });
});

describe("buildProductRows", () => {
  const header = ["Código", "Nombre", "Unidad", "Costo", "Precio", "Stock"];
  const map = mapColumns("products", header);

  it("arma filas nuevas, actualizaciones, salteadas y con error", () => {
    const table = [
      header,
      [101, "Asado", "kg", "9.500", "13.800", "25,5"],
      ["102", "Milanesa", "kg", 11000, 15900, ""],
      ["103", "Repetido A", "kg", 1, 2, ""],
      ["103", "Repetido B", "kg", 1, 2, ""],
      ["", "Sin código", "kg", 1, 2, ""],
      ["104", "Mala unidad", "litro", 1, 2, ""],
      ["105", "Costo raro", "kg", "abc", 2, ""],
      [null, null, null, null, null, null]
    ];
    const rows = buildProductRows(table, map, new Set(["102"]), false);
    assert.deepEqual(rows.map((r) => [r.row, r.status]), [[2, "new"], [3, "skip"], [4, "new"], [5, "error"], [6, "error"], [7, "error"], [8, "error"]]);
    assert.deepEqual(rows[0].payload, { row: 2, code: "101", name: "Asado", unit: "kg", cost: 9500, price_retail: 13800, min_stock: 0, category: "", stock: 25.5 });
    assert.match(rows[3].errors[0], /repetido/);
    assert.deepEqual(summarize(rows), { total: 7, created: 2, updated: 0, skipped: 1, errors: 4 });
  });

  it("con 'actualizar existentes' marca update; las coincidencias ignoran mayúsculas", () => {
    const table = [header, ["ABC", "X", "kg", 1, 2, ""]];
    assert.equal(buildProductRows(table, map, new Set(["abc"]), true)[0].status, "update");
  });

  it("avisa (sin bloquear) si falta precio o el precio es menor al costo", () => {
    const table = [header, ["1", "A", "kg", 100, "", ""], ["2", "B", "kg", 100, 50, ""]];
    const rows = buildProductRows(table, map, new Set(), false);
    assert.equal(rows[0].status, "new");
    assert.ok(rows[0].warnings.some((w) => /Sin precio/.test(w)));
    assert.ok(rows[1].warnings.some((w) => /menor al costo/.test(w)));
  });

  it("los códigos numéricos de Excel no arrastran '.0'", () => {
    const rows = buildProductRows([header, [105, "A", "kg", 1, 2, ""], ["12.0", "B", "kg", 1, 2, ""]], map, new Set(), false);
    assert.deepEqual(rows.map((r) => r.payload?.code), ["105", "12"]);
  });
});

describe("proveedores y clientes", () => {
  it("proveedores: nuevos, existentes salteados, repetidos y sin nombre", () => {
    const map = mapColumns("suppliers", ["Proveedor", "Rubro", "Tel"]);
    const rows = buildSupplierRows(
      [["Proveedor", "Rubro", "Tel"], ["Frigorífico Sur", "carne", "11"], ["Cerdo Morón", "cerdo", ""], ["cerdo morón", "", ""], ["", "x", ""]],
      map,
      new Set(["frigorífico sur"])
    );
    assert.deepEqual(rows.map((r) => r.status), ["skip", "new", "error", "error"]);
    assert.deepEqual(rows[1].payload, { row: 3, name: "Cerdo Morón", category: "cerdo", phone: "", notes: "" });
  });

  it("clientes: lee localidad y provincia", () => {
    const map = mapColumns("customers", ["Cliente", "Ciudad", "Provincia"]);
    const [row] = buildCustomerRows([["Cliente", "Ciudad", "Provincia"], ["Rest. Uno", "La Plata", "Buenos Aires"]], map, new Set());
    assert.equal(row.status, "new");
    assert.deepEqual(row.payload, { row: 2, name: "Rest. Uno", phone: "", locality: "La Plata", province: "Buenos Aires", notes: "" });
  });
});

describe("plantillas", () => {
  it("cada plantilla se reconoce a sí misma sin columnas faltantes ni ignoradas", () => {
    for (const kind of ["products", "suppliers", "customers"] as const) {
      const m = mapColumns(kind, TEMPLATES[kind].headers);
      assert.deepEqual(m.missingRequired, [], kind);
      assert.deepEqual(m.ignored, [], kind);
    }
  });

  it("las filas de ejemplo de productos son válidas", () => {
    const t = TEMPLATES.products;
    const rows = buildProductRows([t.headers, ...t.rows], mapColumns("products", t.headers), new Set(), false);
    assert.deepEqual(summarize(rows).errors, 0);
  });
});
