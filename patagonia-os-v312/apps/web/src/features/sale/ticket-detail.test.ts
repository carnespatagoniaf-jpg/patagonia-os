import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTicketDetail, quantityFor } from "./ticket-detail";

// Ticket REAL de Pollo y mar (Kretz Aura, 15/10/2026 08:56): Milanesas de pol 0,190 kg a $11.600 = $2.204;
// Pechuga deshues. 0,195 kg a $13.100 = $2.554; 02 ART. TOTAL = $4.758 (código 2099804758000).
const MILA = { id: "mila", name: "MILANESAS DE POLLO", unit: "kg", priceRetail: 11600 };
const PECHU = { id: "pechu", name: "PECHUGA DESHUESADA", unit: "kg", priceRetail: 13100 };
const HUEVOS = { id: "huevos", name: "MAPLE DE HUEVOS", unit: "unit", priceRetail: 6500 };

describe("[PURO, ticket REAL] detalle de un ticket de total de la balanza", () => {
  it("los kilos salen del importe y el precio de Patagonia, al gramo", () => {
    assert.equal(quantityFor(MILA, 2204), 0.19);
    assert.equal(quantityFor(PECHU, 2554), 0.195);
    assert.equal(quantityFor(HUEVOS, 13000), 2);
    assert.equal(quantityFor(HUEVOS, 7000), null, "por unidad tiene que dar entero");
    assert.equal(quantityFor({ ...MILA, priceRetail: 0 }, 2204), null);
  });

  it("el ticket de Sonia: dos productos que suman exacto $4.758 → se cargan", () => {
    const r = checkTicketDetail(4758, [{ product: MILA, amount: 2204 }, { product: PECHU, amount: 2554 }]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.rows.map((x) => [x.product.id, x.quantity, x.amount]), [["mila", 0.19, 2204], ["pechu", 0.195, 2554]]);
  });

  it("si falta un producto o sobra plata, no deja cargar y dice cuánto", () => {
    const falta = checkTicketDetail(4758, [{ product: MILA, amount: 2204 }]);
    assert.equal(falta.ok, false);
    assert.equal(!falta.ok && falta.missing, 2554);
    const sobra = checkTicketDetail(4758, [{ product: MILA, amount: 2204 }, { product: PECHU, amount: 2600 }]);
    assert.equal(!sobra.ok && sobra.missing, -46);
    assert.match(!sobra.ok ? sobra.reason : "", /Te pasaste/);
  });

  it("línea sin producto, sin importe o producto sin precio → no deja cargar", () => {
    assert.equal(checkTicketDetail(100, [{ product: null, amount: 100 }]).ok, false);
    assert.equal(checkTicketDetail(100, [{ product: MILA, amount: 0 }]).ok, false);
    const sinPrecio = checkTicketDetail(100, [{ product: { ...MILA, priceRetail: 0 }, amount: 100 }]);
    assert.match(!sinPrecio.ok ? sinPrecio.reason : "", /no tiene precio/);
    assert.equal(checkTicketDetail(100, []).ok, false);
  });

  it("centavos: no se equivoca con decimales", () => {
    assert.equal(checkTicketDetail(2314.3, [{ product: MILA, amount: 1160.1 }, { product: PECHU, amount: 1154.2 }]).ok, true);
  });
});
