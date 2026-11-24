import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mpFailedChargeMessage, mpProblem, mpStatusLabel, suggestCompany, suggestMatch, toArDate, type MpSubscription } from "./mercadopago";

const base: MpSubscription = {
  id: "s1", companyId: null, companyName: null, status: "authorized", reason: "Patagonia OS", payerName: null, payerEmail: null,
  amount: 39000, dateCreated: null, nextPaymentDate: null, lastChargeDate: "2026-10-09T13:00:00Z", lastChargeStatus: "processed",
  lastPaymentStatus: "approved", lastPaymentStatusDetail: "accredited", lastRetryAttempt: 0, approvedCount: 2, syncedAt: null
};

const companies = [
  { id: "a", name: "Don Julio", ownerFullName: "Julio Pérez", ownerEmail: "Julio@mail.com" },
  { id: "b", name: "La Vaca", ownerFullName: "María Gómez", ownerEmail: "maria@mail.com" },
  { id: "c", name: "El Toro", ownerFullName: "Julio Gómez", ownerEmail: null }
];

describe("mercado pago", () => {
  it("estado", () => {
    assert.equal(mpStatusLabel("authorized"), "Activa");
    assert.equal(mpStatusLabel(null), "Desconocida");
  });
  it("problemas de cobro", () => {
    assert.equal(mpProblem(base), null);
    assert.equal(mpProblem({ ...base, lastChargeStatus: "recycling", lastPaymentStatus: "rejected", lastRetryAttempt: 2 }), "No pasó el cobro del 09/10/2026 (Mercado Pago lo reintenta, intento 2)");
    assert.equal(mpProblem({ ...base, status: "cancelled" }), "Canceló la suscripción");
    assert.equal(mpProblem({ ...base, lastPaymentStatus: "rejected", lastChargeStatus: "processed" }), "No pasó el cobro del 09/10/2026");
  });
  it("fecha en hora argentina", () => {
    assert.equal(toArDate("2026-10-10T02:00:00Z"), "2026-10-09");
  });
  it("propone el cliente por email o por nombre", () => {
    assert.equal(suggestCompany({ payerEmail: "julio@MAIL.com", payerName: null }, companies), "a");
    assert.equal(suggestCompany({ payerEmail: null, payerName: "MARIA GOMEZ" }, companies), "b");
    assert.equal(suggestCompany({ payerEmail: null, payerName: "Julio" }, companies), null);
    assert.equal(suggestCompany({ payerEmail: "otro@mail.com", payerName: "Pedro Ruiz" }, companies), null);
  });
  it("mensaje de cobro fallido", () => {
    assert.match(mpFailedChargeMessage("Don Julio", "Julio Pérez"), /^¡Hola Julio! .*suscripción de Don Julio/);
  });
  it("propone por nombre del negocio, nombre desordenado o mail parecido", () => {
    const list = [
      ...companies,
      { id: "d", name: "Pollo y Mar", ownerFullName: "Roberto Sosa", ownerEmail: "rsosa@mail.com" },
      { id: "e", name: "Carnicería La Esperanza", ownerFullName: "Ana Ruiz", ownerEmail: null },
      { id: "f", name: "AJOVA SAS", ownerFullName: "Jorge Vaca", ownerEmail: null },
      { id: "g", name: "Mi Carnicería", ownerFullName: "Brian Benítez", ownerEmail: "brianbenitez@gmail.com" }
    ];
    assert.deepEqual(suggestMatch({ payerEmail: null, payerName: "Pollo y mar" }, list), { companyId: "d", why: "nombre del negocio" });
    assert.equal(suggestCompany({ payerEmail: null, payerName: "La Esperanza" }, list), "e");
    assert.equal(suggestCompany({ payerEmail: null, payerName: "AJOVA SOCIEDAD POR ACIONES SIM" }, list), "f");
    // Segundo nombre de más y otro mail: igual reconoce al dueño.
    assert.deepEqual(suggestMatch({ payerEmail: "otro@hotmail.com", payerName: "Brian Gaston Benitez" }, list), { companyId: "g", why: "mismo nombre del dueño" });
    assert.deepEqual(suggestMatch({ payerEmail: "brianbenitez@hotmail.com", payerName: null }, list), { companyId: "g", why: "mail parecido al del dueño" });
    // "Carnicería" sola no alcanza: hay muchas.
    assert.equal(suggestCompany({ payerEmail: null, payerName: "Carniceria" }, list), null);
    // Dos clientes posibles: no propone ninguno.
    assert.equal(suggestCompany({ payerEmail: null, payerName: "Gomez" }, list), null);
  });
});
