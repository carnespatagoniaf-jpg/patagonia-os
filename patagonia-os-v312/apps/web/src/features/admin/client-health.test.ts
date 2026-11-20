import { test } from "node:test";
import assert from "node:assert/strict";
import { clientHealth, healthMessage, previousWeeklyAverage, upsellCandidates } from "./client-health";
import type { CompanyUsage } from "./sales-pipeline";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function usage(over: Partial<CompanyUsage>): CompanyUsage {
  return {
    productCount: 100, saleCount: 0, salesLast7d: 0, firstSaleAt: null, lastSaleAt: null, closedShiftCount: 0, purchaseCount: 0,
    lastSignInAt: ago(0), salesNote: null, salesContactedAt: null, salesLostReason: null, ...over
  };
}

test("un cliente que vende todos los días está bien", () => {
  const h = clientHealth({ createdAt: ago(100), owes: false, usage: usage({ firstSaleAt: ago(90), lastSaleAt: ago(0), saleCount: 3900, salesLast7d: 300 }) }, NOW);
  assert.equal(h.level, "ok");
  assert.deepEqual(h.reasons, []);
});

test("vende mucho menos que su promedio: en riesgo; algo menos: mirar", () => {
  // 91 días vendiendo, 12 semanas antes de esta con 3600 ventas = 300 por semana.
  const base = { firstSaleAt: ago(91), lastSaleAt: ago(1), saleCount: 3600 };
  assert.equal(previousWeeklyAverage(usage({ ...base, saleCount: 3640, salesLast7d: 40 }), NOW), 300);
  const risk = clientHealth({ createdAt: ago(100), owes: false, usage: usage({ ...base, saleCount: 3640, salesLast7d: 40 }) }, NOW);
  assert.equal(risk.level, "risk");
  assert.match(risk.reasons[0], /Vende menos: 40 ventas esta semana, antes unas 300/);
  assert.equal(risk.salesChangePct, -87);
  const warn = clientHealth({ createdAt: ago(100), owes: false, usage: usage({ ...base, saleCount: 3720, salesLast7d: 120 }) }, NOW);
  assert.equal(warn.level, "warn");
});

test("días sin vender, sin productos y sin estrenar", () => {
  assert.equal(clientHealth({ createdAt: ago(60), owes: false, usage: usage({ firstSaleAt: ago(50), lastSaleAt: ago(9), saleCount: 500 }) }, NOW).level, "warn");
  assert.equal(clientHealth({ createdAt: ago(60), owes: false, usage: usage({ firstSaleAt: ago(50), lastSaleAt: ago(15), saleCount: 500 }) }, NOW).level, "risk");
  assert.equal(clientHealth({ createdAt: ago(1), owes: false, usage: usage({ productCount: 0 }) }, NOW).level, "warn");
  assert.equal(clientHealth({ createdAt: ago(5), owes: false, usage: usage({ productCount: 0 }) }, NOW).reasons[0], "No cargó productos");
  assert.equal(clientHealth({ createdAt: ago(10), owes: false, usage: usage({}) }, NOW).level, "risk");
});

test("deber el abono suma, pero solo no lo pone en rojo", () => {
  const h = clientHealth({ createdAt: ago(100), owes: true, usage: usage({ firstSaleAt: ago(90), lastSaleAt: ago(0), saleCount: 3900, salesLast7d: 300 }) }, NOW);
  assert.equal(h.level, "warn");
  assert.deepEqual(h.reasons, ["Debe el abono"]);
});

test("sin datos de uso no inventa nada", () => {
  assert.equal(clientHealth({ createdAt: ago(100), owes: false }, NOW).level, "ok");
});

test("a quién venderle más: por pantallas y por locales, no por topes de usuarios", () => {
  const list = upsellCandidates([
    { id: "a", name: "A", plan: "basico", activeBranches: 1, lastPaymentAmount: 20000, autoCharged: false },
    { id: "b", name: "B", plan: "estandar", activeBranches: 1, lastPaymentAmount: 39000, autoCharged: false, usage: usage({ salesLast7d: 400 }) },
    { id: "c", name: "C", plan: "full", activeBranches: 2, lastPaymentAmount: 39000, autoCharged: false },
    { id: "d", name: "D", plan: "empresa", activeBranches: 3, lastPaymentAmount: 117000, autoCharged: false },
    { id: "e", name: "E", plan: "estandar", activeBranches: 1, lastPaymentAmount: 39000, autoCharged: false, usage: usage({ salesLast7d: 20 }) }
  ]);
  assert.deepEqual(list.map((u) => [u.companyId, u.offer]), [
    ["a", "Pasarlo a Estándar"],
    ["b", "Ofrecerle Full"],
    ["c", "Ofrecerle Empresa"],
    ["c", "Revisar el abono"]
  ]);
  assert.match(list[3].reason, /serían \$78\.000/);
});

test("mensaje de WhatsApp según lo que pasa", () => {
  const h = clientHealth({ createdAt: ago(10), owes: false, usage: usage({ productCount: 0 }) }, NOW);
  assert.match(healthMessage("Patagonia System", "La Vaquita", "Marcos Pérez", h), /^¡Hola Marcos! Soy de Patagonia System\. Vi que todavía no cargaste/);
  const owes = clientHealth({ createdAt: ago(100), owes: true, usage: usage({ firstSaleAt: ago(90), lastSaleAt: ago(0), saleCount: 3900, salesLast7d: 300 }) }, NOW);
  assert.match(healthMessage("Patagonia System", "La Vaquita", null, owes), /^¡Hola! Soy de Patagonia System\. Te escribo por el abono de La Vaquita/);
});
