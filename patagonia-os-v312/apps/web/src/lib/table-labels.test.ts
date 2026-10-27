import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { columnTitles } from "./table-labels";

describe("títulos de columna para las tablas como tarjetas", () => {
  it("repite el título en las columnas que abarca un colSpan", () => {
    assert.deepEqual(
      columnTitles([{ text: "Producto", span: 1 }, { text: "Precio", span: 2 }, { text: "", span: 1 }]),
      ["Producto", "Precio", "Precio", ""]
    );
  });
});
