import assert from "node:assert/strict";
import { describe, it } from "node:test";
// La lógica pura de la Edge Function kommo-sync se prueba desde acá (el repo no corre tests de Deno).
import {
  contactsCursor,
  eventContact,
  eventsCursor,
  mainContactOfLead,
  newEvents,
  type KommoEvent
} from "../../../../../supabase/functions/kommo-sync/sync";

const ev = (id: string, created_at: number, entity_type = "contact", entity_id = 1): KommoEvent => ({
  id,
  type: "incoming_chat_message",
  entity_id,
  entity_type,
  created_at
});

describe("sincronización de Kommo", () => {
  it("no repite eventos del mismo segundo y los ordena del más viejo", () => {
    const got = newEvents([ev("c", 105), ev("a", 100), ev("b", 100), ev("z", 90)], 100, ["a"]);
    assert.deepEqual(got.map((e) => e.id), ["b", "c"]);
  });

  it("el cursor queda en el último segundo con sus ids", () => {
    assert.deepEqual(eventsCursor([ev("b", 100), ev("c", 105), ev("d", 105)], 100, ["a"]), { since: 105, seen: ["c", "d"] });
    // Todo en el mismo segundo del cursor: se suman a los ya vistos.
    assert.deepEqual(eventsCursor([ev("b", 100)], 100, ["a"]), { since: 100, seen: ["a", "b"] });
    // Sin eventos no cambia.
    assert.deepEqual(eventsCursor([], 100, ["a"]), { since: 100, seen: ["a"] });
  });

  it("cursor de contactos", () => {
    assert.equal(contactsCursor([{ id: 1, created_at: 120 }, { id: 2, created_at: 110 }], 100), 120);
    assert.equal(contactsCursor([], 100), 100);
  });

  it("contacto de un evento", () => {
    assert.deepEqual(eventContact(ev("a", 1, "contact", 7)), { contactId: 7 });
    assert.deepEqual(eventContact(ev("a", 1, "lead", 9)), { leadId: 9 });
    assert.equal(eventContact(ev("a", 1, "company", 9)), null);
    assert.equal(eventContact(ev("a", 1, "contact", 0)), null);
  });

  it("contacto principal de un lead", () => {
    assert.equal(mainContactOfLead({ _embedded: { contacts: [{ id: 3, is_main: false }, { id: 4, is_main: true }] } }), 4);
    assert.equal(mainContactOfLead({ _embedded: { contacts: [{ id: 3 }] } }), 3);
    assert.equal(mainContactOfLead({ _embedded: { contacts: [] } }), null);
    assert.equal(mainContactOfLead(null), null);
  });
});
