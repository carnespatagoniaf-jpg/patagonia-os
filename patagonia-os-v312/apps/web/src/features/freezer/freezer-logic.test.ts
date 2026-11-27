import { test } from "node:test";
import assert from "node:assert/strict";
import { daysStored, daysText, freezerTicket, matchFreezerScan, sameCodeStored, storedForSale, summarizeFreezer, type FreezerPackage } from "./freezer-logic";

const now = new Date("2026-11-26T15:00:00-03:00");
const pkg = (id: string, productId: string, quantity: number, code: string | null, storedAt: string, status: FreezerPackage["status"] = "guardado"): FreezerPackage => ({
  id, productId, quantity, code, status, storedAt, outAt: null, outReason: null, posSaleId: null
});
const products = [
  { id: "mat", name: "Matambre", unit: "kg" as const },
  { id: "pec", name: "Peceto", unit: "kg" as const },
  { id: "ham", name: "Hamburguesa x4", unit: "unit" as const }
];

test("días en el freezer", () => {
  assert.equal(daysStored("2026-11-26T08:00:00-03:00", now), 0);
  assert.equal(daysStored("2026-11-25T08:00:00-03:00", now), 1);
  assert.equal(daysStored("2026-08-01T08:00:00-03:00", now), 117);
  assert.equal(daysText(0), "hoy");
  assert.equal(daysText(1), "ayer");
  assert.equal(daysText(40), "hace 40 días");
});

test("resumen: por producto, el de la bolsa más vieja primero, sin lo vendido ni lo sacado", () => {
  const s = summarizeFreezer([
    pkg("1", "mat", 1.85, "2101210018509", "2026-10-17T10:00:00-03:00"),
    pkg("2", "mat", 1.85, "2101210018509", "2026-11-20T10:00:00-03:00"),
    pkg("3", "pec", 1.2, "2100350012005", "2026-08-01T10:00:00-03:00"),
    pkg("4", "ham", 2, null, "2026-11-26T09:00:00-03:00"),
    pkg("5", "mat", 3, "x", "2026-01-01T10:00:00-03:00", "vendido"),
    pkg("6", "pec", 3, "y", "2026-01-01T10:00:00-03:00", "sacado")
  ], products, now);
  assert.deepEqual(s.rows.map((r) => [r.name, r.count, r.quantity, r.oldestDays]), [
    ["Peceto", 1, 1.2, 117],
    ["Matambre", 2, 3.7, 40],
    ["Hamburguesa x4", 1, 2, 0]
  ]);
  assert.equal(s.packages, 4);
  assert.equal(s.kg, 4.9); // las hamburguesas por unidad no suman kilos
  assert.equal(s.old, 1);
});

test("Mostrador: cada escaneo de la misma etiqueta es otra bolsa, hasta que no quedan", () => {
  const stored = storedForSale([
    pkg("2", "mat", 1.85, "2101210018509", "2026-11-20T10:00:00-03:00"),
    pkg("1", "mat", 1.85, "2101210018509", "2026-10-17T10:00:00-03:00"),
    pkg("4", "ham", 2, null, "2026-11-26T09:00:00-03:00"),
    pkg("5", "mat", 3, "vendida", "2026-01-01T10:00:00-03:00", "vendido")
  ]);
  assert.equal(stored.length, 2); // la cargada a mano y la vendida no se reconocen
  assert.deepEqual(matchFreezerScan(" 2101210018509 ", stored, 0), { code: "2101210018509", productId: "mat", quantity: 1.85 });
  assert.ok(matchFreezerScan("2101210018509", stored, 1));
  assert.equal(matchFreezerScan("2101210018509", stored, 2), null);
  assert.equal(matchFreezerScan("vendida", stored, 0), null);
  assert.equal(matchFreezerScan("", stored, 0), null);
});

test("marca de la venta y bolsas iguales ya guardadas", () => {
  assert.equal(freezerTicket("2101210018509"), "FRZ-2101210018509");
  const list = [pkg("1", "mat", 1.85, "A", "2026-10-17T10:00:00-03:00"), pkg("2", "mat", 1.85, "A", "2026-10-18T10:00:00-03:00", "vendido")];
  assert.equal(sameCodeStored("A", list), 1);
  assert.equal(sameCodeStored("", list), 0);
});
