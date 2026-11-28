import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeByteLink } from "../link/fake-byte-link";
import { WebSerialPortShim } from "./web-serial-shim";
import { ScaleStateStore } from "./scale-state-store";

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const line = { baudRate: 9600, dataBits: 8 as const, stopBits: 2 as const, parity: "none" as const };

async function opened(link: FakeByteLink) {
  await link.open();
  const shim = new WebSerialPortShim({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
  const job = new AbortController();
  let activity = 0;
  shim.attach({ link, signal: job.signal, onActivity: () => (activity += 1) });
  return { shim, job, activity: () => activity };
}

test("shim: fuera de un trabajo no abre (como un puerto tomado)", async () => {
  const shim = new WebSerialPortShim();
  await assert.rejects(shim.open({ baudRate: 9600 }), (e: Error) => e.name === "NetworkError");
});

test("shim: escribe y lee por streams web, y cada byte cuenta como avance", async () => {
  const link = new FakeByteLink({ respond: (w) => `R:${text(w)}` });
  const { shim, activity } = await opened(link);
  await shim.open({ baudRate: 9600 });
  await assert.rejects(shim.open({ baudRate: 9600 }), (e: Error) => e.name === "InvalidStateError");
  const writer = shim.writable!.getWriter();
  await writer.write(Buffer.from("hola", "latin1"));
  writer.releaseLock();
  const reader = shim.readable!.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  assert.equal(text(value!), "R:hola");
  assert.ok(activity() >= 1);
  await shim.close();
  assert.equal(shim.readable, null);
});

test("shim: lo que llega después de soltar el lector queda para la próxima lectura", async () => {
  const link = new FakeByteLink();
  const { shim } = await opened(link);
  await shim.open({ baudRate: 9600 });
  const first = shim.readable!.getReader();
  const pending = first.read();
  first.releaseLock();
  await assert.rejects(pending);
  link.inject("tarde");
  const second = shim.readable!.getReader();
  assert.equal(text((await second.read()).value!), "tarde");
  second.releaseLock();
});

test("shim: cancelar el lector y pedir el stream de nuevo da uno nuevo (como Chrome)", async () => {
  const link = new FakeByteLink();
  const { shim } = await opened(link);
  await shim.open({ baudRate: 9600 });
  const r1 = shim.readable!;
  await r1.getReader().cancel();
  const r2 = shim.readable!;
  assert.notEqual(r1, r2);
  link.inject("x");
  const reader = r2.getReader();
  assert.equal(text((await reader.read()).value!), "x");
});

test("shim: otra velocidad reabre el MISMO puerto; las señales llegan al enlace", async () => {
  const link = new FakeByteLink({ lineSettings: { ...line, baudRate: 115200, stopBits: 1 } });
  const { shim } = await opened(link);
  await shim.open({ baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" });
  assert.deepEqual(link.lineSettings, line);
  assert.equal(link.openCount, 2);
  await shim.setSignals({ dataTerminalReady: true, requestToSend: true });
  assert.deepEqual(link.signals, [{ dataTerminalReady: true, requestToSend: true }]);
  await shim.close();
  // Misma configuración: no se reabre.
  await shim.open({ baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" });
  assert.equal(link.openCount, 2);
});

test("shim: un corte durante el trabajo lo deja perdido y no vuelve a abrir el puerto", async () => {
  const link = new FakeByteLink();
  const { shim } = await opened(link);
  await shim.open({ baudRate: 9600 });
  const reader = shim.readable!.getReader();
  const pending = reader.read();
  link.simulateDisconnect();
  await assert.rejects(pending, (e: Error) => e.name === "NetworkError");
  assert.equal(shim.connected, false);
  assert.ok(shim.lost);
  await shim.close();
  await assert.rejects(shim.open({ baudRate: 9600 }), (e: Error) => e.name === "NetworkError");
  assert.equal(link.openCount, 1);
});

test("shim: el vigía cancela lo pendiente", async () => {
  const link = new FakeByteLink();
  const { shim, job } = await opened(link);
  await shim.open({ baudRate: 9600 });
  const reader = shim.readable!.getReader();
  const pending = reader.read();
  job.abort();
  await assert.rejects(pending);
  await assert.rejects(shim.writable!.getWriter().write(new Uint8Array([1])));
});

test("almacén por balanza: guarda en disco con escritura atómica y lo recupera", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-state-"));
  const file = path.join(dir, "protocols", "aura.json");
  const a = await ScaleStateStore.open("aura", file);
  a.setItem("patagonia-kretz-model", "aura");
  a.setItem("x", "1");
  a.removeItem("x");
  await a.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.items, { "patagonia-kretz-model": "aura" });
  const b = await ScaleStateStore.open("aura", file);
  assert.equal(b.getItem("patagonia-kretz-model"), "aura");
  assert.equal(b.getItem("nada"), null);
  assert.equal(b.length, 1);
});
