import assert from "node:assert/strict";
import { describe, it } from "node:test";
// La lógica pura de la Edge Function kommo-webhook se prueba desde acá (el repo no corre tests de Deno).
import {
  kommoLeadEvents,
  kommoSubdomain,
  parseKommoForm,
  phoneFromApiContact,
  sameKey
} from "../../../../../supabase/functions/kommo-webhook/kommo";

function form(pairs: [string, string][]) {
  return new URLSearchParams(pairs).toString();
}

describe("webhook de Kommo", () => {
  it("contacto nuevo con teléfono en los campos", () => {
    const body = form([
      ["contacts[add][0][id]", "123"],
      ["contacts[add][0][name]", "Juan Pérez"],
      ["contacts[add][0][custom_fields][0][id]", "55"],
      ["contacts[add][0][custom_fields][0][name]", "Teléfono"],
      ["contacts[add][0][custom_fields][0][code]", "PHONE"],
      ["contacts[add][0][custom_fields][0][values][0][value]", "+54 9 299 444-1111"],
      ["contacts[add][0][custom_fields][0][values][0][enum]", "77"],
      ["account[subdomain]", "carnes"]
    ]);
    const payload = parseKommoForm(body);
    assert.equal(kommoSubdomain(payload), "carnes");
    assert.deepEqual(kommoLeadEvents(payload), [
      { contactId: 123, name: "Juan Pérez", phone: "+54 9 299 444-1111", incoming: false, text: null }
    ]);
  });

  it("mensaje que llega cuenta como 'escribió'; el que sale se ignora", () => {
    const body = form([
      ["message[add][0][id]", "m1"],
      ["message[add][0][contact_id]", "456"],
      ["message[add][0][type]", "incoming"],
      ["message[add][0][text]", "Hola, cuánto sale?"],
      ["message[add][0][author][name]", "Ana"],
      ["message[add][1][contact_id]", "456"],
      ["message[add][1][type]", "outgoing"],
      ["message[add][1][text]", "Hola Ana"]
    ]);
    assert.deepEqual(kommoLeadEvents(parseKommoForm(body)), [
      { contactId: 456, name: "Ana", phone: null, incoming: true, text: "Hola, cuánto sale?" }
    ]);
  });

  it("empresas y avisos sin id no generan nada", () => {
    const body = form([
      ["contacts[add][0][id]", "9"],
      ["contacts[add][0][type]", "company"],
      ["message[add][0][type]", "incoming"],
      ["leads[add][0][id]", "1"]
    ]);
    assert.deepEqual(kommoLeadEvents(parseKommoForm(body)), []);
  });

  it("teléfono de un contacto leído por la API", () => {
    assert.equal(
      phoneFromApiContact({
        id: 1,
        name: "X",
        custom_fields_values: [
          { field_code: "EMAIL", values: [{ value: "a@b.c" }] },
          { field_code: "PHONE", values: [{ value: " +5491155551234 " }] }
        ]
      }),
      "+5491155551234"
    );
    assert.equal(phoneFromApiContact({ custom_fields_values: null }), null);
  });

  it("clave de la URL", () => {
    assert.equal(sameKey("abc", "abc"), true);
    assert.equal(sameKey("abc", "abd"), false);
    assert.equal(sameKey("", ""), false);
  });
});
