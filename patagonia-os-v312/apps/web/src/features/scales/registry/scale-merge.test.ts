import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { duplicateNotice, mergedRedirects, mergeResultText, parseDuplicateGroups } from "./scale-merge";
import { bindingFor, loadBindings, redirectMergedBindings, saveBinding } from "./local-bindings";

/**
 * Migración 225: registros repetidos de la misma balanza (real, producción 26/11: una sucursal con 4 × {"address":20}).
 * El aviso de "Mis balanzas" y la redirección de lo que recuerda cada computadora.
 */

beforeEach(() => installFakeLocalStorage());

const now = new Date("2026-11-27T15:00:00-03:00");
const raw = [
  {
    family: "systel",
    identity: { address: 20 },
    formats_differ: false,
    scales: [
      { scale_key: "s-viejo", name: "Cuora Max 2", active: true, last_seen_at: "2026-11-20T13:00:00-03:00", last_used_at: "2026-11-20T13:00:00-03:00" },
      { scale_key: "s-nuevo", name: "Mostrador", active: true, last_seen_at: "2026-11-27T10:15:00-03:00", last_used_at: "2026-11-27T10:15:00-03:00", weighed_format: "22AAAAPPPPPP" },
      { scale_key: "s-nunca", name: "Cuora Max 3", active: true, last_seen_at: null, last_used_at: null }
    ]
  },
  { family: "kretz", identity: { letter: "C" }, formats_differ: true, scales: [{ scale_key: "k1", name: "A" }, { scale_key: "k2", name: "B" }] },
  // Lo que no tiene forma de grupo se descarta.
  { family: "otra", scales: [{ scale_key: "x" }, { scale_key: "y" }] },
  { family: "systel", scales: [{ scale_key: "solo" }] }
];

describe("aviso: Encontramos N registros que parecen la misma balanza", () => {
  it("lee los grupos, primero la usada más recientemente", () => {
    const groups = parseDuplicateGroups(raw);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].scales.map((s) => s.key), ["s-nuevo", "s-viejo", "s-nunca"]);
    assert.equal(groups[0].scales[0].formats.weighed, "22AAAAPPPPPP");
    assert.deepEqual(parseDuplicateGroups(null), []);
    assert.deepEqual(parseDuplicateGroups({}), []);
  });

  it("dice cuántos son, con nombre y último uso, y propone dejar la usada más recientemente", () => {
    const n = duplicateNotice(parseDuplicateGroups(raw)[0], now);
    assert.equal(n.title, "Encontramos 3 registros que parecen la misma balanza");
    assert.equal(n.suggestedKeep, "s-nuevo");
    assert.equal(n.canMerge, true);
    assert.deepEqual(n.rows.map((r) => `${r.name}: ${r.lastUse}`), ["Mostrador: usada hoy 10:15", "Cuora Max 2: usada el 20/11 13:00", "Cuora Max 3: nunca se conectó"]);
    assert.match(n.help, /Son distintas/);
  });

  it("si imprimen distinto no ofrece unir: pueden ser balanzas distintas", () => {
    const n = duplicateNotice(parseDuplicateGroups(raw)[1], now);
    assert.equal(n.canMerge, false);
    assert.match(n.help, /pueden ser balanzas distintas/);
  });

  it("el resultado de unir en palabras simples", () => {
    assert.deepEqual(mergeResultText({ merged: true, keys: ["a", "b"] }, "Mostrador"), { ok: true, text: 'Listo: los otros 2 registros quedaron unidos a "Mostrador".' });
    assert.equal(mergeResultText({ merged: true, keys: ["a"] }, "Mostrador").text, 'Listo: el otro registro quedó unido a "Mostrador".');
    const no = mergeResultText({ merged: false, reason: "formatos_distintos", detail: [{ scale_key: "t1", name: "Fondo" }, { scale_key: "t2", name: null }] }, "Fondo");
    assert.equal(no.ok, false);
    assert.match(no.text, /"Fondo", "t2" imprimen las etiquetas de forma distinta/);
    assert.match(no.text, /No se cambió nada/);
  });
});

describe("redirección de lo que recuerda esta computadora", () => {
  it("clave unida → la que quedó, siguiendo cadenas y sin bucles", () => {
    assert.deepEqual(
      mergedRedirects([
        { key: "a", mergedInto: "b" },
        { key: "b", mergedInto: "c" },
        { key: "c", mergedInto: null },
        { key: "d" },
        { key: "x", mergedInto: "y" },
        { key: "y", mergedInto: "x" }
      ]),
      // Un ciclo (no debería existir: la base no deja unir a una unida) se ignora.
      { a: "c", b: "c" }
    );
  });

  it("el cable recordado de una clave unida pasa a la que quedó", () => {
    saveBinding("s-viejo", { branchId: "b1", family: "systel", usb: "0403:6001" }, localStorage, new Date("2026-11-20T10:00:00Z"));
    saveBinding("otra", { branchId: "b1", family: "kretz", usb: null }, localStorage);
    saveBinding("s-viejo", { branchId: "b2", family: "systel", usb: "1111:2222" }, localStorage);
    assert.equal(redirectMergedBindings("b1", { "s-viejo": "s-nuevo" }), 1);
    assert.equal(bindingFor("s-viejo", "b1"), null);
    assert.equal(bindingFor("s-nuevo", "b1")?.usb, "0403:6001");
    // Otra sucursal y otras balanzas no se tocan.
    assert.equal(bindingFor("s-viejo", "b2")?.usb, "1111:2222");
    assert.ok(bindingFor("otra", "b1"));
    // Ya redirigido: no hace nada.
    assert.equal(redirectMergedBindings("b1", { "s-viejo": "s-nuevo" }), 0);
  });

  it("si la que quedó ya tenía cable, gana la conexión buena más reciente", () => {
    saveBinding("s-nuevo", { branchId: "b1", family: "systel", usb: "nuevo" }, localStorage, new Date("2026-11-26T10:00:00Z"));
    saveBinding("s-viejo", { branchId: "b1", family: "systel", usb: "viejo" }, localStorage, new Date("2026-11-20T10:00:00Z"));
    saveBinding("s-otro", { branchId: "b1", family: "systel", usb: "otro" }, localStorage, new Date("2026-11-27T10:00:00Z"));
    redirectMergedBindings("b1", { "s-viejo": "s-nuevo" });
    assert.equal(bindingFor("s-nuevo", "b1")?.usb, "nuevo");
    redirectMergedBindings("b1", { "s-otro": "s-nuevo" });
    assert.equal(bindingFor("s-nuevo", "b1")?.usb, "otro");
    assert.deepEqual(Object.keys(loadBindings()).sort(), ["b1|s-nuevo"]);
  });
});
