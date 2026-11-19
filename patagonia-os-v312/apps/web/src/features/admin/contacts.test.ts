import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contactName, contactStatus, daysSinceTouch, kommoContactLink, kommoSyncNotice, matchesContact } from "./contacts";
import type { Lead } from "./sales-pipeline";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const base: Lead = {
  id: "l", businessName: "Sin nombre", contactName: null, phone: "+54 9 11 5514-8199", province: null, city: null, stage: "contacto",
  source: "Instagram (publicidad)", note: null, nextContactOn: null, lostReason: null, companyId: null,
  createdAt: "2026-10-18T12:00:00Z", attempts: 2, lastContactedAt: "2026-10-18T12:00:00Z", repliedAt: null
};

describe("contactos", () => {
  it("estado", () => {
    assert.deepEqual(contactStatus(base), { label: "Sin respuesta (2 mensajes)", tone: "none" });
    assert.equal(contactStatus({ ...base, repliedAt: "2026-10-19T12:00:00Z" }).label, "Contestó");
    assert.equal(contactStatus({ ...base, stage: "perdido", lostReason: "Por ahora no" }).label, "No: Por ahora no");
    assert.equal(contactStatus({ ...base, stage: "perdido", lostReason: "No contestó (4 mensajes)" }).label, "No contestó (4 mensajes)");
    assert.equal(contactStatus({ ...base, stage: "alta" }).label, "Cliente");
  });

  it("días sin hablar", () => {
    assert.equal(daysSinceTouch(base, NOW), 33);
  });

  it("filtros", () => {
    assert.equal(matchesContact(base, "sin_respuesta", "", NOW), true);
    assert.equal(matchesContact(base, "contestaron", "", NOW), false);
    assert.equal(matchesContact(base, "mes", "", NOW), true);
    assert.equal(matchesContact({ ...base, lastContactedAt: "2026-11-10T12:00:00Z" }, "mes", "", NOW), false);
    assert.equal(matchesContact({ ...base, stage: "perdido" }, "no", "", NOW), true);
    assert.equal(matchesContact({ ...base, stage: "alta" }, "clientes", "", NOW), true);
  });

  it("búsqueda por número en cualquier formato, nombre o nota", () => {
    assert.equal(matchesContact(base, "todos", "1155148199", NOW), true);
    assert.equal(matchesContact(base, "todos", "5514-8199", NOW), true);
    assert.equal(matchesContact({ ...base, note: "Demo coordinada martes" }, "todos", "demo", NOW), true);
    assert.equal(matchesContact({ ...base, contactName: "Gustavo" }, "todos", "gustavo", NOW), true);
    assert.equal(matchesContact(base, "todos", "pedro", NOW), false);
  });

  it("nombre para mostrar", () => {
    assert.equal(contactName(base), "Sin nombre");
    assert.equal(contactName({ ...base, contactName: "Gustavo" }), "Gustavo");
  });
});

describe("Kommo en el panel", () => {
  it("dirección del contacto en Kommo", () => {
    assert.equal(kommoContactLink("carnes", 123), "https://carnes.kommo.com/contacts/detail/123");
    assert.equal(kommoContactLink(" Carnes ", 5), "https://carnes.kommo.com/contacts/detail/5");
    assert.equal(kommoContactLink(null, 123), null);
    assert.equal(kommoContactLink("carnes", null), null);
    assert.equal(kommoContactLink("evil.com/x", 1), null);
  });

  it("cartel de la sincronización", () => {
    const now = Date.parse("2026-11-19T15:00:00Z");
    const base = { configured: true, subdomain: "carnes", lastResult: { contacts: 0 } };
    assert.equal(kommoSyncNotice(null, now), null);
    assert.equal(kommoSyncNotice({ ...base, configured: false, lastRunAt: null }, now), null);
    assert.deepEqual(kommoSyncNotice({ ...base, lastRunAt: "2026-11-19T14:57:00Z" }, now), { ok: true, text: "Kommo sincronizado hace 3 minutos." });
    const stale = kommoSyncNotice({ ...base, lastRunAt: "2026-11-19T12:00:00Z" }, now);
    assert.equal(stale?.ok, false);
    assert.match(stale!.text, /desde hace 3 horas/);
    const rejected = kommoSyncNotice({ ...base, lastRunAt: "2026-11-19T14:59:00Z", lastResult: { error: "Kommo rechazó el token (401)" } }, now);
    assert.equal(rejected?.ok, false);
    assert.match(rejected!.text, /rechazó el token/);
    assert.equal(kommoSyncNotice({ ...base, lastRunAt: "2026-11-19T14:59:00Z", lastResult: { skipped: "x" } }, now)?.ok, false);
    assert.equal(kommoSyncNotice({ ...base, lastRunAt: null }, now)?.ok, false);
  });
});
