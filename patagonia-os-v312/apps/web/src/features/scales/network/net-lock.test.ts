import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { NetScalePort, netTiming, resetNetAgentForTests, setNetAgentFetchForTests } from "../../inventory/kretz/net-port";
import { fakeNetAgent } from "../../inventory/kretz/test-fake-net-agent";
import { acquireScaleLock, setScaleLocksForTests, withScaleLock } from "../../inventory/kretz/scale-lock";
import { fakeLockManager } from "../../inventory/kretz/test-fake-locks";
import { checkNetScale } from "./net-watch";

/**
 * C19 (plan balanzas v2): el vigía de 30 s o una segunda pestaña abrían y cerraban la conexión por red mientras otra
 * pestaña pasaba productos, y el envío se cortaba. Cada `NetScalePort` hace de "otra pestaña": comparten el mismo
 * candado (`navigator.locks` de Node, igual que entre pestañas de Chrome) y el mismo programa de la PC simulado.
 */

const A = { host: "192.168.1.50", port: 1001 };
const echo = (tag: number) => (bytes: number[]) => [tag, ...bytes];

async function writeAndRead(port: NetScalePort, bytes: number[]): Promise<number[]> {
  const w = port.writable!.getWriter();
  await w.write(new Uint8Array(bytes));
  w.releaseLock();
  const r = port.readable!.getReader();
  const got = await r.read();
  r.releaseLock();
  return [...(got.value ?? [])];
}

beforeEach(() => {
  installFakeLocalStorage();
  netTiming.retryMs = 1;
  netTiming.relocateEveryMs = 60000;
  netTiming.lockWaitMs = 200;
  resetNetAgentForTests();
  // Candado en memoria igual al de Chrome: Node 22 (el del CI) no trae navigator.locks.
  setScaleLocksForTests(fakeLockManager());
});
afterEach(() => {
  setNetAgentFetchForTests(null);
  setScaleLocksForTests(undefined);
});

describe("candado de las balanzas por red (C19)", () => {
  it("el vigía no abre ni cierra la conexión si otra pestaña la está usando", async () => {
    const agent = fakeNetAgent({ version: 6, devices: { "192.168.1.50:1001": echo(0xa1) } });
    setNetAgentFetchForTests(agent.fetchImpl);
    const syncing = new NetScalePort({ ...A });
    await syncing.open();
    const before = agent.calls.length;

    const at = await checkNetScale(A, (a) => new NetScalePort(a));
    assert.deepEqual(at, A, "la está usando otra: anda");
    const extra = agent.calls.slice(before);
    assert.equal(extra.filter((c) => c.startsWith("/scale/open") || c.startsWith("/scale/close")).length, 0, extra.join(" "));
    assert.deepEqual(await writeAndRead(syncing, [1, 2]), [0xa1, 1, 2], "el envío sigue");
    await syncing.close();
  });

  it("un puerto que nunca abrió no le cierra la conexión a otro", async () => {
    const agent = fakeNetAgent({ version: 6, devices: { "192.168.1.50:1001": echo(0xa1) } });
    setNetAgentFetchForTests(agent.fetchImpl);
    const syncing = new NetScalePort({ ...A });
    await syncing.open();
    await new NetScalePort({ ...A }).close();
    assert.equal(agent.calls.filter((c) => c.startsWith("/scale/close")).length, 0);
    assert.deepEqual(await writeAndRead(syncing, [7]), [0xa1, 7]);
    await syncing.close();
  });

  it("una segunda pestaña que quiere la misma balanza espera; si no la sueltan, avisa sin cortar a la primera", async () => {
    const agent = fakeNetAgent({ version: 6, devices: { "192.168.1.50:1001": echo(0xa1) } });
    setNetAgentFetchForTests(agent.fetchImpl);
    const first = new NetScalePort({ ...A });
    await first.open();
    const second = new NetScalePort({ ...A });
    await assert.rejects(second.open(), /otra pestaña/);
    assert.deepEqual(await writeAndRead(first, [3]), [0xa1, 3]);
    const waiting = second.open();
    await first.close();
    await waiting;
    assert.deepEqual(await writeAndRead(second, [4]), [0xa1, 4]);
    await second.close();
  });

  it("al cerrar se suelta el candado (y también si no se pudo abrir)", async () => {
    const agent = fakeNetAgent({ version: 6, devices: {} });
    setNetAgentFetchForTests(agent.fetchImpl);
    const p = new NetScalePort({ ...A }, false);
    await assert.rejects(p.open());
    const free = await acquireScaleLock("red:programa", { ifAvailable: true });
    assert.ok(free, "el candado quedó libre");
    free!();
  });

  it("sin navigator.locks (Chrome viejo): como antes, el vigía abre y cierra", async () => {
    setScaleLocksForTests(null);
    const agent = fakeNetAgent({ version: 6, devices: { "192.168.1.50:1001": echo(0xa1) } });
    setNetAgentFetchForTests(agent.fetchImpl);
    assert.deepEqual(await checkNetScale(A, (a) => new NetScalePort(a)), A);
    assert.equal(agent.calls.filter((c) => c.startsWith("/scale/open")).length, 1);
    assert.equal(agent.calls.filter((c) => c.startsWith("/scale/close")).length, 1);
    assert.equal(await withScaleLock("x", async () => 5), 5);
  });

  it("withScaleLock: de a uno por clave, y suelta aunque falle", async () => {
    const order: string[] = [];
    const slow = withScaleLock("k", async () => {
      order.push("a-in");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-out");
    });
    const fast = withScaleLock("k", async () => {
      order.push("b");
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["a-in", "a-out", "b"]);
    await assert.rejects(withScaleLock("k", async () => { throw new Error("x"); }));
    await assert.rejects(
      (async () => {
        const hold = await acquireScaleLock("k");
        try {
          await withScaleLock("k", async () => 1, { ifAvailable: true });
        } finally {
          hold!();
        }
      })(),
      /otra pestaña/
    );
  });
});
