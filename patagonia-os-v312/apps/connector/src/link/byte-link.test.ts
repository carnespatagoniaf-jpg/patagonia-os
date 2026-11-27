import test from "node:test";
import assert from "node:assert/strict";
import { FakeByteLink } from "./fake-byte-link";
import { LinkError, classifyOpenError, isLinkError } from "./link-error";

const bytes = (s: string) => Buffer.from(s, "latin1");
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

test("read espera hasta que se cumple 'until' y consume el búfer", async () => {
  const link = new FakeByteLink({ respond: () => "\x07AB" });
  await link.open();
  const reading = link.read({ timeoutMs: 500, until: (b) => b.includes(0x04) });
  await link.write(bytes("0001"));
  setTimeout(() => link.inject("CD\x04"), 10);
  assert.equal(text(await reading), "\x07ABCD\x04");
  assert.equal(link.discardInput(), 0);
});

test("read sin 'until' devuelve apenas llega un byte", async () => {
  const link = new FakeByteLink();
  await link.open();
  setTimeout(() => link.inject("X"), 5);
  assert.equal(text(await link.read({ timeoutMs: 500 })), "X");
});

test("read con tiempo vencido da 'timeout' y deja los bytes para descartar", async () => {
  const link = new FakeByteLink();
  await link.open();
  link.inject("parcial");
  await assert.rejects(link.read({ timeoutMs: 20, until: (b) => b.length > 100 }), (e) => isLinkError(e, "timeout"));
  assert.equal(link.discardInput(), 7);
});

test("una desconexión rechaza la lectura en curso con 'closed' y avisa una sola vez", async () => {
  const link = new FakeByteLink();
  await link.open();
  const events: LinkError[] = [];
  link.onDisconnect((e) => events.push(e));
  const reading = link.read({ timeoutMs: 1000 });
  link.simulateDisconnect();
  link.simulateDisconnect();
  await assert.rejects(reading, (e) => isLinkError(e, "closed"));
  assert.equal(events.length, 1);
  assert.equal(link.isOpen, false);
  await assert.rejects(link.write(bytes("x")), (e) => isLinkError(e, "closed"));
});

test("cerrar a pedido no dispara onDisconnect", async () => {
  const link = new FakeByteLink();
  await link.open();
  let fired = 0;
  link.onDisconnect(() => (fired += 1));
  const reading = link.read({ timeoutMs: 1000 });
  await link.close();
  await assert.rejects(reading, (e) => isLinkError(e, "closed"));
  assert.equal(fired, 0);
  await link.close(); // dos veces no rompe
});

test("una lectura se puede cancelar con AbortSignal", async () => {
  const link = new FakeByteLink();
  await link.open();
  const ctrl = new AbortController();
  const reading = link.read({ timeoutMs: 1000, signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(reading, (e) => isLinkError(e, "aborted"));
});

test("no se permiten dos lecturas a la vez", async () => {
  const link = new FakeByteLink();
  await link.open();
  const first = link.read({ timeoutMs: 50 });
  await assert.rejects(link.read({ timeoutMs: 50 }), (e) => isLinkError(e, "io"));
  await assert.rejects(first, (e) => isLinkError(e, "timeout"));
});

test("un oyente de desconexión que falla no afecta a los demás", async () => {
  const link = new FakeByteLink();
  await link.open();
  let ok = false;
  link.onDisconnect(() => {
    throw new Error("oyente roto");
  });
  link.onDisconnect(() => (ok = true));
  link.simulateDisconnect();
  assert.equal(ok, true);
});

test("se puede volver a abrir después de una desconexión", async () => {
  const link = new FakeByteLink({ respond: () => "OK" });
  await link.open();
  link.simulateDisconnect();
  await link.open();
  await link.write(bytes("?"));
  assert.equal(text(await link.read({ timeoutMs: 200 })), "OK");
  assert.equal(link.openCount, 2);
});

test("classifyOpenError: acceso denegado de Windows = lo tiene otro programa", () => {
  const e = classifyOpenError(new Error("Opening COM3: Access denied"), "el puerto COM3");
  assert.equal(e.code, "busy_other_program");
  assert.match(e.message, /otro programa/);
});

test("classifyOpenError: archivo no encontrado = no existe", () => {
  assert.equal(classifyOpenError(new Error("Opening COM9: File not found"), "COM9").code, "not_found");
  assert.equal(classifyOpenError(Object.assign(new Error("x"), { code: "ENOENT" }), "COM9").code, "not_found");
});

test("classifyOpenError: errores de red", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 192.168.0.5:1001"), { code: "ECONNREFUSED" });
  assert.equal(classifyOpenError(refused, "x").code, "refused");
  const unreach = Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" });
  assert.equal(classifyOpenError(unreach, "x").code, "unreachable");
  assert.equal(classifyOpenError(new Error("algo raro"), "x").code, "io");
  const already = new LinkError("in_use_here", "ya");
  assert.equal(classifyOpenError(already, "x"), already);
});
