import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODE39,
  addDays,
  code39Bars,
  daysToExpire,
  isPackageCode,
  normalizePackageCode,
  packagePrice,
  parseQuantities,
  saleScanProblem,
  shipScanProblem,
  totalsByProduct,
  type PlantaPackage
} from "./planta-logic";

const pkg = (over: Partial<PlantaPackage> = {}): PlantaPackage => ({
  id: "1", number: 1, code: "PQ00000001", productId: "vacio", originBranchId: "planta", branchId: "planta",
  carcassBatchId: null, quantity: 1.2, packedOn: "2026-11-03", expiresOn: null, status: "en_planta",
  transferId: null, posSaleId: null, soldAt: null, voidReason: null, ...over
});

test("código de paquete: PQ + 8 dígitos, tolera minúsculas, espacios y los * de la pistola", () => {
  assert.equal(isPackageCode("PQ00000123"), true);
  assert.equal(isPackageCode(" pq00000123 "), true);
  assert.equal(isPackageCode("*PQ00000123*"), true);
  assert.equal(normalizePackageCode("*pq00000123*"), "PQ00000123");
  assert.equal(isPackageCode("PQ123"), false);
  assert.equal(isPackageCode("2000100012345"), false);
  assert.equal(isPackageCode("10"), false);
});

test("pesos al envasar: uno por paquete, con coma o punto, y avisa lo que no entiende", () => {
  assert.deepEqual(parseQuantities("1,2\n0.850  1;2,5"), { quantities: [1.2, 0.85, 1, 2.5], invalid: [] });
  assert.deepEqual(parseQuantities("1,2 abc -3 0"), { quantities: [1.2], invalid: ["abc", "-3", "0"] });
  assert.deepEqual(parseQuantities("   "), { quantities: [], invalid: [] });
});

test("totales por producto para el envío", () => {
  const t = totalsByProduct([{ productId: "a", quantity: 1.2 }, { productId: "a", quantity: 0.85 }, { productId: "b", quantity: 6 }]);
  assert.deepEqual(t.get("a"), { count: 2, quantity: 2.05 });
  assert.deepEqual(t.get("b"), { count: 1, quantity: 6 });
});

test("vencimiento", () => {
  assert.equal(addDays("2026-11-28", 5), "2026-12-03");
  assert.equal(daysToExpire("2026-11-10", "2026-11-03"), 7);
  assert.equal(daysToExpire("2026-11-01", "2026-11-03"), -2);
  assert.equal(daysToExpire(null, "2026-11-03"), null);
  assert.equal(packagePrice(0.85, 14000), 11900);
});

test("escanear para un envío", () => {
  assert.equal(shipScanProblem("PQ00000001", [], pkg(), "planta"), null);
  assert.match(shipScanProblem("PQ00000001", ["PQ00000001"], pkg(), "planta") ?? "", /ya está en la lista/);
  assert.match(shipScanProblem("PQ00000009", [], undefined, "planta") ?? "", /no existe/);
  assert.match(shipScanProblem("PQ00000001", [], pkg({ status: "vendido" }), "planta") ?? "", /vendido/);
  assert.match(shipScanProblem("PQ00000001", [], pkg({ branchId: "otra" }), "planta") ?? "", /no se puede mandar/);
});

test("escanear para cobrar", () => {
  assert.equal(saleScanProblem({ code: "PQ00000001", status: "en_local" }), null);
  assert.equal(saleScanProblem({ code: "PQ00000001", status: "en_viaje" }), null);
  assert.match(saleScanProblem({ code: "PQ00000001", status: "vendido" }) ?? "", /ya se cobró/);
  assert.match(saleScanProblem({ code: "PQ00000001", status: "anulado" }) ?? "", /anulado/);
  assert.match(saleScanProblem(undefined) ?? "", /no está en el sistema/);
});

test("Code 39: cada carácter tiene 9 elementos y exactamente 3 anchos", () => {
  for (const [ch, pattern] of Object.entries(CODE39)) {
    assert.equal(pattern.length, 9, ch);
    assert.equal([...pattern].filter((c) => c === "w").length, 3, ch);
  }
  assert.equal(new Set(Object.values(CODE39)).size, Object.keys(CODE39).length);
  const { bars, width } = code39Bars("PQ00000001");
  // 12 caracteres (con los dos *): 5 barras cada uno, 15 módulos cada uno + 11 espacios entre caracteres.
  assert.equal(bars.length, 60);
  assert.equal(width, 12 * 15 + 11);
  assert.throws(() => code39Bars("AB"));
});
