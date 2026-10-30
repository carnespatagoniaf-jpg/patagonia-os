import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../../scales/test-fake-storage";
import { kretzChecksum } from "./kretz-frame";
import { isLocalNetworkHost, knownNetAddresses, netKey, netPortFor, parseNetKey, rememberNetAddress, sameSubnet, setNetAgentFetchForTests, testNetScale, type LocalAddress } from "./net-port";

/**
 * [SIMULADO] Kretz Report por CABLE DE RED (real Oliem minimarket 29/10: Report LT RPL NP30P2CAR con el cable de red
 * directo a la PC, sin Bluetooth). El código de Patagonia es el REAL (búsqueda, lectura 5005, alta 2005, relectura);
 * lo simulado es el programa de la PC (sus respuestas HTTP, las mismas que dio el programa real en esta PC contra
 * una balanza simulada por TCP) y la balanza, que contesta en pedazos como puede pasar por TCP.
 */

const SCALE = { host: "192.168.1.50", port: 1001 };
const PC: LocalAddress[] = [
  { name: "Ethernet", kind: "Ethernet", ip: "192.168.1.10", mask: "255.255.255.0" },
  { name: "Wi-Fi", kind: "Wireless80211", ip: "10.0.0.7", mask: "255.255.255.0" }
];

/** La Report: guarda los registros de 135 caracteres (2005) y los devuelve con 5005, como la de report-sync-e2e. */
class FakeNetReport {
  records = new Map<number, string>();
  writes: number[] = [];
  out: number[] = [];
  handle(frame: number[]) {
    if (frame[0] !== 0x02) return;
    const text = String.fromCharCode(...frame.slice(1, frame.length - 3));
    const command = text.slice(3, 7);
    const data = text.slice(7);
    const reply = (code: string, payload = "") => {
      const body = [0x07, ...Array.from("C0100" + code + payload, (c) => c.charCodeAt(0))];
      this.out.push(...body, ...kretzChecksum(body), 0x04);
    };
    if (command === "0001") reply("01");
    else if (command === "2005") {
      const plu = Number(data.slice(0, 6));
      this.writes.push(plu);
      this.records.set(plu, data);
      reply("01");
    } else if (command === "5005") {
      const next = [...this.records.keys()].filter((k) => k > Number(data)).sort((a, b) => a - b)[0];
      if (next === undefined) reply("02");
      else reply("01", this.records.get(next)!);
    } else if (command === "1070") reply("01");
    else reply("02");
  }
}

/** El programa de la PC simulado (mismas rutas y respuestas que patagonia-print-agent.ps1 v4). */
function fakeAgent(scale: FakeNetReport, opts: { running?: boolean; version?: number } = {}) {
  let open = false;
  let pending: number[] = [];
  const calls: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (opts.running === false) throw new TypeError("Failed to fetch");
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === "/ping") return json(200, { ok: true, version: opts.version ?? 4 });
    if (u.pathname === "/scale/find") return json(200, { ok: true, found: [SCALE.host], local: PC });
    if (u.pathname === "/scale/open") {
      if (u.searchParams.get("host") !== SCALE.host || Number(u.searchParams.get("port")) !== SCALE.port) {
        return json(502, { ok: false, error: `La balanza no contesta en ${u.searchParams.get("host")} (puerto ${u.searchParams.get("port")}).`, local: PC });
      }
      open = true;
      return json(200, { ok: true });
    }
    if (u.pathname === "/scale/close") {
      open = false;
      return json(200, { ok: true });
    }
    if (!open) return json(409, { ok: false, error: "La conexion con la balanza no esta abierta.", closed: true });
    if (u.pathname === "/scale/write") {
      const bytes = [...new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer())];
      pending.push(...bytes);
      while (pending.includes(0x04)) {
        const end = pending.indexOf(0x04);
        scale.handle(pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
      }
      return json(200, { ok: true, bytes: bytes.length });
    }
    if (u.pathname === "/scale/read") {
      // Por TCP la respuesta puede llegar partida: se entrega de a 9 bytes como mucho.
      if (!scale.out.length) await new Promise((r) => setTimeout(r, 20));
      const chunk = scale.out.splice(0, 9);
      return json(200, { ok: true, data: Buffer.from(chunk).toString("base64"), closed: false });
    }
    return json(404, { ok: false });
  };
  return { fetchImpl, calls };
}

// Chrome con Web Serial pero sin ningún puerto autorizado (la PC de Oliem: ningún cable de balanza).
const serial = Object.assign(new EventTarget(), { getPorts: async () => [], requestPort: async () => { throw new Error("no"); } });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

beforeEach(() => installFakeLocalStorage());
after(() => setNetAgentFetchForTests(null));

describe("Kretz Report por cable de red: direcciones", () => {
  it("solo direcciones de la red local (nunca internet)", () => {
    for (const ip of ["192.168.1.50", "10.0.0.2", "172.16.5.4", "172.31.0.1", "169.254.10.20"]) assert.equal(isLocalNetworkHost(ip), true, ip);
    for (const ip of ["8.8.8.8", "172.32.0.1", "127.0.0.1", "192.168.1", "192.168.1.300", "balanza.local", ""]) assert.equal(isLocalNetworkHost(ip), false, ip);
  });

  it("misma red que alguna placa de la PC", () => {
    assert.equal(sameSubnet("192.168.1.50", PC), true);
    assert.equal(sameSubnet("192.168.0.50", PC), false);
    assert.equal(sameSubnet("10.0.0.99", PC), true);
  });

  it("clave del 'cable' y direcciones recordadas en esta computadora", () => {
    assert.equal(netKey(SCALE), "red:192.168.1.50:1001");
    assert.deepEqual(parseNetKey("red:192.168.1.50:1001"), SCALE);
    assert.equal(parseNetKey("1a86:7523"), null);
    rememberNetAddress(SCALE);
    rememberNetAddress({ host: "192.168.1.51", port: 1001 });
    rememberNetAddress(SCALE);
    assert.deepEqual(knownNetAddresses().map(netKey), ["red:192.168.1.50:1001", "red:192.168.1.51:1001"]);
    assert.equal(netPortFor(SCALE), netPortFor({ ...SCALE }), "el mismo objeto para la misma dirección");
  });

  it("sin el programa en la PC / dirección equivocada: lo dice, y propone una IP de la misma red", async () => {
    const scale = new FakeNetReport();
    setNetAgentFetchForTests(fakeAgent(scale, { running: false }).fetchImpl);
    const off = await testNetScale(SCALE);
    assert.equal(off.ok, false);
    assert.equal(!off.ok && off.kind, "sin_programa");

    setNetAgentFetchForTests(fakeAgent(scale).fetchImpl);
    const wrong = await testNetScale({ host: "192.168.0.99", port: 1001 });
    assert.equal(wrong.ok, false);
    assert.equal(!wrong.ok && wrong.kind, "sin_conexion");
    const { unreachableMessage } = await import("../../scales/NetworkScaleSetup");
    const text = unreachableMessage("192.168.0.99", 1001, (!wrong.ok && wrong.local) || []);
    assert.match(text, /no está en la misma red/);
    assert.match(text, /192\.168\.1\.200/, "IP sugerida en la red de la placa Ethernet");
    assert.match(unreachableMessage("192.168.1.77", 1001, PC), /no contesta en 192\.168\.1\.77/);

    assert.deepEqual(await testNetScale(SCALE), { ok: true });
  });
});

describe("[SIMULADO] Kretz Report por cable de red: conectar, pasar productos y comprobar", () => {
  type P = { id: string; code: string; name: string; unit: string; priceRetail: number };
  const products: P[] = [
    { id: "a", code: "1", name: "Vacío", unit: "kg", priceRetail: 18990 },
    { id: "b", code: "2", name: "Matambre", unit: "kg", priceRetail: 15500 },
    { id: "c", code: "3", name: "Chorizo", unit: "unit", priceRetail: 1200 }
  ];

  async function connect(target: { key: string } | null) {
    const { connectBranchScale } = await import("../../scales/engine/connect-branch");
    const { pickNetworkScaleNext, serialApi } = await import("../../scales/engine/engine");
    const { makeKretzAdapter, KRETZ_IO } = await import("../../scales/engine/adapters/kretz");
    if (!target) pickNetworkScaleNext(SCALE);
    const serial = serialApi();
    assert.ok(serial, "sin Web Serial igual hay 'cable' por red");
    return connectBranchScale(
      { branchId: "b1", products, online: false },
      () => {},
      {
        target: target ? ({ key: target.key, name: "Report", family: "kretz", brand: "kretz", model: "Kretz Report LT", identity: {}, active: true, lastSeenAt: null, sellsWithCodes: true } as never) : null,
        known: [],
        pick: !target
      },
      {
        adapters: [makeKretzAdapter({ ...KRETZ_IO, configureReportBarcode: undefined }, () => null, "report-lt")],
        serial,
        binding: target ? () => ({ branchId: "b1", family: "kretz", usb: netKey(SCALE), snapshot: {}, lastOkAt: "" }) : undefined,
        restore: () => {}
      }
    );
  }

  it("agregar: la balanza se encuentra por la red, recibe los 3 productos con el precio de Stock y se releen iguales", async () => {
    const scale = new FakeNetReport();
    const agent = fakeAgent(scale);
    setNetAgentFetchForTests(agent.fetchImpl);
    rememberNetAddress(SCALE);
    const r = await connect(null);
    assert.equal(r.family, "kretz");
    assert.equal(r.usb, "red:192.168.1.50:1001", "el 'cable' queda recordado por su dirección");
    assert.equal(r.session.model, "kretz-report-lt");
    const prep = await r.session.prepare(() => {});
    assert.equal(prep.writes, 3);
    const out = await r.session.sync(prep, () => {});
    assert.equal(out.ok, true, out.message);
    assert.equal(out.verified, 3);
    assert.deepEqual(scale.writes.sort(), [1, 2, 3]);
    assert.equal(Number(scale.records.get(1)!.slice(6 + 3 + 3 + 26 + 26 + 5 + 1 + 7, 6 + 3 + 3 + 26 + 26 + 5 + 1 + 7 + 6)), 18990, "precio de Stock, sin cambios");
    assert.ok(agent.calls.includes("/scale/open"));
    await r.session.close();
  });

  it("la próxima vez (PASAR PRODUCTOS): la encuentra sola por su dirección, sin elegir nada, y ya está igual", async () => {
    const scale = new FakeNetReport();
    setNetAgentFetchForTests(fakeAgent(scale).fetchImpl);
    rememberNetAddress(SCALE);
    const first = await connect(null);
    await first.session.sync(await first.session.prepare(() => {}), () => {});
    const again = await connect({ key: "k1" });
    assert.equal(again.usb, netKey(SCALE));
    const prep = await again.session.prepare(() => {});
    assert.equal(prep.writes, 0, "nada para mandar: ya está igual");
  });
});
