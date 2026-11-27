import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { NetScalePort, netLockKeys, netTiming, resetNetAgentForTests, setNetAgentFetchForTests } from "../../inventory/kretz/net-port";
import { fakeNetAgent } from "../../inventory/kretz/test-fake-net-agent";
import { setScaleLocksForTests } from "../../inventory/kretz/scale-lock";

/**
 * C19: dos balanzas por red en el mismo comercio. Con el programa de la PC versión 7 cada una tiene su conexión (id de
 * enlace) y se usan a la vez sin cruzarse los bytes; con la 6 (una conexión) la web las usa de a una, sin cortarse.
 * El programa simulado (test-fake-net-agent.ts) tiene la misma lógica de conexiones que patagonia-print-agent.ps1.
 */

const A = { host: "192.168.1.50", port: 1001 };
const B = { host: "192.168.1.51", port: 1001 };
const devices = { "192.168.1.50:1001": (b: number[]) => [0xaa, ...b], "192.168.1.51:1001": (b: number[]) => [0xbb, ...b] };

async function ask(port: NetScalePort, bytes: number[]): Promise<number[]> {
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
  netTiming.lockWaitMs = 2000;
  resetNetAgentForTests();
  setScaleLocksForTests(undefined);
});
afterEach(() => setNetAgentFetchForTests(null));

describe("dos balanzas por red a la vez (C19)", () => {
  it("programa v7: las dos abiertas a la vez, cada una contesta lo suyo y cerrar una no corta la otra", async () => {
    const agent = fakeNetAgent({ version: 7, devices });
    setNetAgentFetchForTests(agent.fetchImpl);
    const a = new NetScalePort({ ...A });
    const b = new NetScalePort({ ...B });
    await Promise.all([a.open(), b.open()]);
    assert.deepEqual(agent.openTargets().sort(), ["192.168.1.50:1001", "192.168.1.51:1001"]);
    for (let i = 0; i < 5; i++) {
      const [ra, rb] = await Promise.all([ask(a, [i]), ask(b, [100 + i])]);
      assert.deepEqual(ra, [0xaa, i], "A no recibe bytes de B");
      assert.deepEqual(rb, [0xbb, 100 + i], "B no recibe bytes de A");
    }
    assert.ok(agent.calls.some((c) => c.startsWith("/scale/write?link=")), "usa el id de enlace");
    await a.close();
    assert.deepEqual(agent.openTargets(), ["192.168.1.51:1001"]);
    assert.deepEqual(await ask(b, [9]), [0xbb, 9]);
    await b.close();
    assert.deepEqual(agent.openTargets(), []);
  });

  it("programa v6: la segunda espera a que la primera termine (no le corta la conexión) y sin id, como siempre", async () => {
    const agent = fakeNetAgent({ version: 6, devices });
    setNetAgentFetchForTests(agent.fetchImpl);
    const a = new NetScalePort({ ...A });
    const b = new NetScalePort({ ...B });
    await a.open();
    const bOpen = b.open();
    assert.deepEqual(await ask(a, [1]), [0xaa, 1], "A sigue entera mientras B espera");
    await a.close();
    await bOpen;
    assert.deepEqual(await ask(b, [2]), [0xbb, 2]);
    await b.close();
    assert.equal(agent.calls.some((c) => c.includes("link=")), false);
  });

  it("candados: con v7 uno por balanza; con v6 (o sin saber) también el del programa", () => {
    assert.deepEqual(netLockKeys(A, true), ["red:192.168.1.50:1001"]);
    assert.deepEqual(netLockKeys(A, false), ["red:programa", "red:192.168.1.50:1001"]);
    assert.deepEqual(netLockKeys(A, null), ["red:programa", "red:192.168.1.50:1001"]);
  });
});
