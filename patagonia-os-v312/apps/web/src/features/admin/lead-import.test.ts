import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseContacts, phoneKey } from "./lead-import";
import { leadAttemptMessage, leadFollowUp, type Lead } from "./sales-pipeline";

describe("cargar interesados", () => {
  it("mismo celular en distintos formatos", () => {
    for (const p of ["+54 9 11 5555-1234", "011 15 5555 1234", "5491155551234", "11 5555-1234"]) assert.equal(phoneKey(p), "1155551234", p);
    assert.equal(phoneKey("2944 15 551234"), "2944551234");
    assert.equal(phoneKey("123"), null);
  });

  it("líneas pegadas, sin repetidos", () => {
    const text = "Juan Pérez 11 5555-1234\n+54 9 294 455-1234 - Carnicería Don Julio\n011 15 5555 1234\nhola sin número\n341 333 3333";
    assert.deepEqual(parseContacts(text), [
      { name: "Juan Pérez", phone: "11 5555-1234" },
      { name: "Carnicería Don Julio", phone: "+54 9 294 455-1234" },
      { name: null, phone: "341 333 3333" }
    ]);
  });

  it("archivo de contactos del celular (.vcf)", () => {
    const vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ana Torres\r\nTEL;TYPE=CELL:+54 9 341 333-3333\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Sin tel\r\nEND:VCARD\r\n";
    assert.deepEqual(parseContacts(vcf), [{ name: "Ana Torres", phone: "+54 9 341 333-3333" }]);
  });

  it("mensajes 1 a 4 y despedida", () => {
    assert.match(leadAttemptMessage(1, "Juan Pérez"), /^¡Hola Juan! 👋/);
    assert.match(leadAttemptMessage(1, "Sin nombre"), /^¡Hola! 👋/);
    assert.match(leadAttemptMessage(1, "Carnicería Don Julio"), /^¡Hola! 👋/);
    assert.match(leadAttemptMessage(3, null), /Respondeme 1/);
    assert.match(leadAttemptMessage(9, null), /No te quiero llenar de mensajes/);
  });

  it("seguimiento según intentos", () => {
    const lead: Lead = {
      id: "l", businessName: "Juan", contactName: "Juan", phone: "11 5555-1234", province: null, city: null, stage: "contacto",
      source: "Instagram (publicidad)", note: null, nextContactOn: "2026-10-18", lostReason: null, companyId: null,
      createdAt: "2026-10-18T10:00:00Z", attempts: 1, repliedAt: null
    };
    const f = leadFollowUp(lead, "2026-10-18")!;
    assert.equal(f.title, "Interesado sin respuesta: mensaje 2 de 4");
    assert.match(f.message, /te lo muestre en 10 minutos/);
    assert.equal(leadFollowUp({ ...lead, repliedAt: "2026-10-17T10:00:00Z" }, "2026-10-18")!.title, "Contestó: seguí la charla");
  });
});
