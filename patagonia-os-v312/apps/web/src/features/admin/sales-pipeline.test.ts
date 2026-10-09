import { test } from "node:test";
import assert from "node:assert/strict";
import { companyFollowUp, companyStage, followUpsForToday, funnelCounts, leadFollowUp, whatsappLink, type CompanyUsage, type Lead, type PipelineCompany } from "./sales-pipeline";

const NOW = Date.parse("2026-10-09T15:00:00Z");
const TODAY = "2026-10-09";
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

function usage(partial: Partial<CompanyUsage> = {}): CompanyUsage {
  return {
    productCount: 0, saleCount: 0, salesLast7d: 0, firstSaleAt: null, lastSaleAt: null, closedShiftCount: 0, purchaseCount: 0,
    lastSignInAt: null, salesNote: null, salesContactedAt: null, salesLostReason: null, ...partial
  };
}

function company(partial: Partial<PipelineCompany> = {}): PipelineCompany {
  return {
    id: "c1", name: "Carnicería Don Pepe", active: true, createdAt: daysAgo(3), ownerFullName: "Pepe Gómez", contactPhone: "11 5555 5555",
    trialEndsAt: daysAhead(4), paidUntil: null, usage: usage(), ...partial
  };
}

test("etapa según el uso real", () => {
  assert.equal(companyStage(company(), TODAY), "sin_arrancar");
  assert.equal(companyStage(company({ usage: usage({ productCount: 40 }) }), TODAY), "cargando");
  assert.equal(companyStage(company({ usage: usage({ productCount: 40, saleCount: 3 }) }), TODAY), "usando");
  assert.equal(companyStage(company({ paidUntil: "2026-11-09" }), TODAY), "pago");
  assert.equal(companyStage(company({ active: false, paidUntil: "2026-11-09" }), TODAY), "perdido");
  assert.equal(companyStage(company({ usage: usage({ salesLostReason: "Caro" }) }), TODAY), "perdido");
  // Abono vencido: vuelve a contar como uso (y "Deben" se ve en la pestaña Clientes).
  assert.equal(companyStage(company({ paidUntil: "2026-10-01", usage: usage({ productCount: 5, saleCount: 9 }) }), TODAY), "usando");
});

test("no cargó productos: ofrecer cargarle la lista", () => {
  const f = companyFollowUp(company(), TODAY, NOW);
  assert.equal(f?.kind, "no_products");
  assert.match(f!.message, /^¡Hola Pepe!/);
  assert.match(f!.message, /lista de precios/);
});

test("alta de hoy todavía no aparece", () => {
  assert.equal(companyFollowUp(company({ createdAt: daysAgo(0) }), TODAY, NOW), null);
});

test("cargó pero no vendió", () => {
  assert.equal(companyFollowUp(company({ usage: usage({ productCount: 30 }) }), TODAY, NOW)?.kind, "no_sales");
});

test("vende y le quedan 2 días: ofrecer plan antes que cualquier otra cosa", () => {
  const f = companyFollowUp(company({ trialEndsAt: daysAhead(2), usage: usage({ productCount: 30, saleCount: 12 }) }), TODAY, NOW);
  assert.equal(f?.kind, "trial_ending");
  assert.match(f!.reason, /12 ventas/);
});

test("vende y le queda bastante prueba: nada que hacer", () => {
  assert.equal(companyFollowUp(company({ usage: usage({ productCount: 30, saleCount: 12 }) }), TODAY, NOW), null);
});

test("prueba vencida sin pago", () => {
  assert.equal(companyFollowUp(company({ trialEndsAt: daysAgo(1) }), TODAY, NOW)?.kind, "trial_expired");
});

test("ya le escribí hace menos de 2 días: no aparece", () => {
  assert.equal(companyFollowUp(company({ usage: usage({ salesContactedAt: daysAgo(1) }) }), TODAY, NOW), null);
  assert.equal(companyFollowUp(company({ usage: usage({ salesContactedAt: daysAgo(2) }) }), TODAY, NOW)?.kind, "no_products");
});

test("perdido o desactivado: no aparece", () => {
  assert.equal(companyFollowUp(company({ usage: usage({ salesLostReason: "Usa otro sistema" }) }), TODAY, NOW), null);
  assert.equal(companyFollowUp(company({ active: false }), TODAY, NOW), null);
});

test("cliente que paga: aviso de vencimiento y de que dejó de usarlo", () => {
  assert.equal(companyFollowUp(company({ paidUntil: "2026-10-11", usage: usage({ productCount: 5, saleCount: 50, lastSaleAt: daysAgo(0) }) }), TODAY, NOW)?.kind, "payment_due");
  assert.equal(companyFollowUp(company({ paidUntil: "2026-11-11", usage: usage({ productCount: 5, saleCount: 50, lastSaleAt: daysAgo(9) }) }), TODAY, NOW)?.kind, "paid_idle");
  assert.equal(companyFollowUp(company({ paidUntil: "2026-11-11", usage: usage({ productCount: 5, saleCount: 50, lastSaleAt: daysAgo(1) }) }), TODAY, NOW), null);
});

const lead: Lead = {
  id: "l1", businessName: "Carnicería La Esquina", contactName: "Ana", phone: "2944 15 123456", province: null, city: null,
  stage: "demo", source: "Instagram", note: null, nextContactOn: "2026-10-08", lostReason: null, companyId: null, createdAt: daysAgo(5)
};

test("interesado con seguimiento vencido", () => {
  const f = leadFollowUp(lead, TODAY);
  assert.equal(f?.kind, "lead_due");
  assert.match(f!.reason, /hace 1 día/);
  assert.equal(leadFollowUp({ ...lead, nextContactOn: "2026-10-10" }, TODAY), null);
  assert.equal(leadFollowUp({ ...lead, stage: "alta" }, TODAY), null);
});

test("lista de hoy ordenada por urgencia", () => {
  const list = followUpsForToday(
    [company({ id: "a" }), company({ id: "b", name: "B", trialEndsAt: daysAhead(1), usage: usage({ productCount: 3, saleCount: 2 }) })],
    [lead],
    TODAY,
    NOW
  );
  assert.deepEqual(list.map((f) => f.kind), ["trial_ending", "no_products", "lead_due"]);
});

test("link de WhatsApp con el número argentino bien armado", () => {
  assert.equal(whatsappLink("11 5555 5555", "hola"), "https://wa.me/5491155555555?text=hola");
  assert.equal(whatsappLink("011 15 5555-5555", "x"), "https://wa.me/5491155555555?text=x");
  assert.equal(whatsappLink("2944 15 123456", "x"), "https://wa.me/5492944123456?text=x");
  assert.equal(whatsappLink("+54 9 11 5555 5555", "x"), "https://wa.me/5491155555555?text=x");
  assert.equal(whatsappLink("+54 11 5555 5555", "x"), "https://wa.me/5491155555555?text=x");
  assert.equal(whatsappLink(null, "x"), null);
});

test("embudo de conversión", () => {
  const counts = funnelCounts([
    company(),
    company({ usage: usage({ productCount: 4 }) }),
    company({ usage: usage({ productCount: 4, saleCount: 3 }), paidUntil: "2026-11-01" })
  ]);
  assert.deepEqual(counts, { altas: 3, cargaron: 2, vendieron: 1, pagaron: 1 });
});
