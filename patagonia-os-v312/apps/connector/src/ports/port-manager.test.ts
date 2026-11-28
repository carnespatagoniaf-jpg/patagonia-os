import test from "node:test";
import assert from "node:assert/strict";
import { PortManager, serialResource, tcpResource } from "./port-manager";
import { FakeByteLink } from "../link/fake-byte-link";
import { isLinkError } from "../link/link-error";

test("claves normalizadas", () => {
  assert.equal(serialResource("com3"), "serial:COM3");
  assert.equal(serialResource("\\\\.\\COM10"), "serial:COM10");
  assert.equal(tcpResource("192.168.0.50", 1001), "tcp:192.168.0.50:1001");
});

test("un puerto tiene un solo dueño: el segundo recibe un error claro", async () => {
  const pm = new PortManager();
  const key = serialResource("COM3");
  const lease = await pm.open(key, "Balanza Mostrador", () => new FakeByteLink());
  await assert.rejects(
    pm.open(key, "Otra", () => new FakeByteLink()),
    (e) => isLinkError(e, "in_use_here") && /Balanza Mostrador/.test(e.message) && /COM3/.test(e.message),
  );
  assert.equal(pm.ownerOf(key), "Balanza Mostrador");
  await lease.release();
  await lease.release(); // idempotente
  assert.equal(pm.isTaken(key), false);
  const again = await pm.open(key, "Otra", () => new FakeByteLink());
  assert.equal(again.owner, "Otra");
});

test("liberar cierra el enlace", async () => {
  const pm = new PortManager();
  const link = new FakeByteLink();
  const lease = await pm.open(tcpResource("192.168.0.9", 1001), "x", () => link);
  assert.equal(link.isOpen, true);
  await lease.release();
  assert.equal(link.isOpen, false);
});

test("'lo tiene otro programa' se distingue de 'no existe' y deja el puerto libre", async () => {
  const pm = new PortManager();
  const key = serialResource("COM3");
  const busy = new FakeByteLink();
  busy.nextOpenError = new Error("Opening COM3: Access denied");
  await assert.rejects(pm.open(key, "a", () => busy), (e) => isLinkError(e, "busy_other_program") && /otro programa/.test(e.message));
  assert.equal(pm.isTaken(key), false);

  const missing = new FakeByteLink();
  missing.nextOpenError = new Error("Opening COM3: File not found");
  await assert.rejects(pm.open(key, "a", () => missing), (e) => isLinkError(e, "not_found") && /no existe/.test(e.message));
  assert.equal(pm.isTaken(key), false);
});

test("si crear el enlace tira, el puerto queda libre", async () => {
  const pm = new PortManager();
  const key = serialResource("COM5");
  await assert.rejects(pm.open(key, "a", () => {
    throw new Error("constructor roto");
  }));
  assert.equal(pm.isTaken(key), false);
});

test("mientras abre, el puerto ya está reservado (dos pedidos simultáneos)", async () => {
  const pm = new PortManager();
  const key = serialResource("COM6");
  const [a, b] = await Promise.allSettled([
    pm.open(key, "uno", () => new FakeByteLink()),
    pm.open(key, "dos", () => new FakeByteLink()),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal(pm.list().length, 1);
  await pm.releaseAll();
  assert.equal(pm.list().length, 0);
});

test("un release viejo no libera una reserva nueva del mismo puerto", async () => {
  const pm = new PortManager();
  const key = serialResource("COM7");
  const first = await pm.open(key, "uno", () => new FakeByteLink());
  await first.release();
  const second = await pm.open(key, "dos", () => new FakeByteLink());
  await first.release();
  assert.equal(pm.ownerOf(key), "dos");
  await second.release();
});
