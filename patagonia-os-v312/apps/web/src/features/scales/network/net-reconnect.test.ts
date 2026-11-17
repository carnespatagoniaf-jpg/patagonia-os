import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { knownNetAddresses, moveNetAddress, NetScalePort, netTiming, relocationCandidate, rememberNetAddress, setNetAgentFetchForTests } from "../../inventory/kretz/net-port";
import { checkNetScale } from "./net-watch";

/**
 * Reconexión sola por red: la balanza se apagó, se movió el cable o el router le cambió la dirección. Lo simulado es
 * el programa de la PC (sus respuestas HTTP); el código de Patagonia es el real.
 */

const OLD = { host: "192.168.0.50", port: 1001 };
const NEW = { host: "192.168.0.77", port: 1001 };

/** Programa de la PC simulado: en qué direcciones atiende una balanza, y qué devuelve la búsqueda. */
function fakeAgent(state: { alive: Set<string>; found: { ip: string; port: number }[]; failOpens?: number }) {
  const log: string[] = [];
  setNetAgentFetchForTests(async (url) => {
    const u = new URL(url);
    log.push(u.pathname + (u.search ? u.search : ""));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/scale/open") {
      const key = `${u.searchParams.get("host")}:${u.searchParams.get("port")}`;
      if (state.failOpens && state.failOpens > 0) {
        state.failOpens--;
        return json({ ok: false, error: "no contesta" });
      }
      return json(state.alive.has(key) ? { ok: true } : { ok: false, error: "no contesta" });
    }
    if (u.pathname === "/scale/close") return json({ ok: true });
    if (u.pathname === "/scale/find") return json({ ok: true, scales: state.found, local: [], wired: [] });
    return json({ ok: false });
  });
  return log;
}

describe("reconexión sola por cable de red", () => {
  beforeEach(() => {
    installFakeLocalStorage();
    netTiming.retryMs = 1;
    netTiming.relocateEveryMs = 0;
  });
  after(() => {
    setNetAgentFetchForTests(null);
  });

  it("la balanza se estaba prendiendo: reintenta y conecta sin buscar", async () => {
    const log = fakeAgent({ alive: new Set(["192.168.0.50:1001"]), found: [], failOpens: 2 });
    const port = new NetScalePort({ ...OLD });
    await port.open();
    assert.ok(port.readable);
    assert.equal(log.filter((l) => l.startsWith("/scale/open")).length, 3);
    assert.equal(log.some((l) => l.startsWith("/scale/find")), false);
    await port.close();
  });

  it("le cambió la IP: la busca por su marca (puerto) y la recuerda con la nueva", async () => {
    localStorage.setItem("patagonia-scale-bindings", JSON.stringify({ "suc|balanza-1": { usb: "red:192.168.0.50:1001", family: "kretz" } }));
    localStorage.setItem("patagonia-my-scale", JSON.stringify({ usb: "red:192.168.0.50:1001", family: "kretz" }));
    rememberNetAddress(OLD);
    const log = fakeAgent({ alive: new Set(["192.168.0.77:1001"]), found: [{ ip: "192.168.0.77", port: 1001 }] });
    const port = new NetScalePort({ ...OLD });
    await port.open();
    assert.deepEqual(port.net, NEW);
    assert.ok(log.some((l) => l.startsWith("/scale/find") && l.includes("ports=1001")));
    assert.deepEqual(knownNetAddresses()[0], NEW);
    assert.equal(knownNetAddresses().some((a) => a.host === OLD.host), false);
    assert.equal(JSON.parse(localStorage.getItem("patagonia-scale-bindings")!)["suc|balanza-1"].usb, "red:192.168.0.77:1001");
    assert.equal(JSON.parse(localStorage.getItem("patagonia-my-scale")!).usb, "red:192.168.0.77:1001");
    await port.close();
  });

  it("apagada (no está en ningún lado): avisa que no contesta, no inventa otra", async () => {
    fakeAgent({ alive: new Set(), found: [] });
    const port = new NetScalePort({ ...OLD });
    await assert.rejects(() => port.open());
    assert.deepEqual(port.net, OLD);
  });

  it("dos balanzas nuevas de la misma marca: no adivina cuál es", () => {
    assert.equal(relocationCandidate(OLD, [NEW, { host: "192.168.0.78", port: 1001 }], [OLD]), null);
  });

  it("la única nueva ya es otra balanza conocida de esta PC: no la toma", () => {
    assert.equal(relocationCandidate(OLD, [NEW], [OLD, NEW]), null);
  });

  it("otra marca (Systel) en la red no cuenta para una Kretz", () => {
    assert.equal(relocationCandidate(OLD, [{ host: "192.168.0.77", port: 10001 }], [OLD]), null);
  });

  it("sigue en su dirección: no se mueve", () => {
    assert.equal(relocationCandidate(OLD, [OLD, NEW], [OLD]), null);
  });

  it("la dirección escrita a mano solo se prueba tal cual (sin reintentos ni búsqueda)", async () => {
    const log = fakeAgent({ alive: new Set(), found: [{ ip: "192.168.0.77", port: 1001 }] });
    const port = new NetScalePort({ ...OLD }, false);
    await assert.rejects(() => port.open());
    assert.equal(log.filter((l) => l.startsWith("/scale/open")).length, 1);
    assert.equal(log.some((l) => l.startsWith("/scale/find")), false);
  });

  it("moveNetAddress sin nada guardado no rompe", () => {
    moveNetAddress(OLD, NEW);
    assert.deepEqual(knownNetAddresses(), [NEW]);
  });

  it("revisión de fondo de Mis balanzas: contesta, cambió de dirección, o no contesta", async () => {
    fakeAgent({ alive: new Set(["192.168.0.50:1001"]), found: [] });
    assert.deepEqual(await checkNetScale(OLD, (a) => new NetScalePort({ ...a })), OLD);
    fakeAgent({ alive: new Set(["192.168.0.77:1001"]), found: [{ ip: "192.168.0.77", port: 1001 }] });
    assert.deepEqual(await checkNetScale(OLD, (a) => new NetScalePort({ ...a })), NEW);
    fakeAgent({ alive: new Set(), found: [] });
    assert.equal(await checkNetScale(OLD, (a) => new NetScalePort({ ...a })), null);
  });
});
