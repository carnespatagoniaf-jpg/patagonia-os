import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moneyToInput, onCostOrMargin, onPrice, parseMargin, productWithCode } from "./product-pricing";
import { parseAmount } from "../../lib/money";

const empty = { cost: "", margin: "", priceRetail: "" };

describe("margen → precio de venta", () => {
  it("compra a $6.000 y quiere 35%: el precio sale solo ($8.100)", () => {
    const a = onCostOrMargin(empty, "cost", "6.000");
    const b = onCostOrMargin(a, "margin", "35");
    assert.equal(b.priceRetail, "8100");
  });

  it("primero el margen y después el costo, también", () => {
    const a = onCostOrMargin(empty, "margin", "35");
    const b = onCostOrMargin(a, "cost", "6000");
    assert.equal(b.priceRetail, "8100");
  });

  it("acepta '35%' y decimales con coma o punto", () => {
    assert.equal(parseMargin("35%"), 35);
    assert.equal(parseMargin("35,5"), 35.5);
    assert.equal(parseMargin("35.5"), 35.5);
    assert.ok(Number.isNaN(parseMargin("")));
    assert.equal(onCostOrMargin({ ...empty, cost: "6000" }, "margin", "35%").priceRetail, "8100");
  });

  it("el precio con centavos queda escrito con coma (parseAmount lo lee bien)", () => {
    const r = onCostOrMargin({ ...empty, cost: "1000" }, "margin", "33,333");
    assert.equal(r.priceRetail, "1333,33");
    assert.equal(parseAmount(r.priceRetail), 1333.33);
  });

  it("escribir el costo sin margen NO pisa el precio ya escrito: muestra el margen", () => {
    const r = onCostOrMargin({ ...empty, priceRetail: "8100" }, "cost", "6000");
    assert.equal(r.priceRetail, "8100");
    assert.equal(r.margin, "35");
  });

  it("cambiar el costo con margen cargado recalcula el precio (inflación)", () => {
    const r = onCostOrMargin({ cost: "6000", margin: "35", priceRetail: "8100" }, "cost", "7000");
    assert.equal(r.priceRetail, "9450");
  });

  it("borrar el margen no toca el precio", () => {
    const r = onCostOrMargin({ cost: "6000", margin: "35", priceRetail: "8100" }, "margin", "");
    assert.equal(r.priceRetail, "8100");
  });
});

describe("precio → margen", () => {
  it("costo 6000, venta 8100 → 35", () => {
    assert.equal(onPrice({ ...empty, cost: "6000" }, "8.100").margin, "35");
  });
  it("sin costo no inventa margen", () => {
    assert.equal(onPrice(empty, "8100").margin, "");
  });
});

describe("ficha guardada → editar", () => {
  it("un costo con centavos no se multiplica por 100 al editar", () => {
    assert.equal(parseAmount(moneyToInput(17804.35)), 17804.35);
    assert.equal(parseAmount(moneyToInput(6000)), 6000);
  });
});

describe("código de barras repetido", () => {
  const products = [
    { id: "1", code: "7790001000012" },
    { id: "2", code: "101" }
  ];
  it("encuentra el producto que ya tiene ese código", () => {
    assert.equal(productWithCode(products, " 7790001000012 ")?.id, "1");
  });
  it("no se avisa a sí mismo al editar", () => {
    assert.equal(productWithCode(products, "101", "2"), undefined);
  });
  it("vacío no coincide con nada", () => {
    assert.equal(productWithCode(products, ""), undefined);
  });
});
