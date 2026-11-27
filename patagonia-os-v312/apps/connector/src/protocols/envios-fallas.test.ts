// [SIMULADO] Inyección de fallas POR EL CONECTOR: el mismo motor de la web corriendo en el servicio de Windows
// (ScaleProtocolHost → trabajador → enlace de bytes), contra balanzas simuladas que fallan en la operación k, para toda
// k del envío limpio. Se exige lo mismo que en la web (apps/web/src/features/scales/engine/envios-fallas.test.ts):
// - nunca "ok" si un producto pedido no quedó exacto en la balanza;
// - cada producto que el conector informa "confirmado" (y anota en el diario) está exacto en la balanza;
// - los productos del cliente que no son de Patagonia quedan intactos.
// Fallas: error, "hecho" sin grabar, relectura distinta (rápidas) en TODA k; sin respuesta y corte (el cable se
// desconecta) también en toda k, en paralelo (cada una espera el tiempo de respuesta del protocolo).

import test from "node:test";
import assert from "node:assert/strict";
import { serialResource, tcpResource } from "../ports/port-manager";
import { TcpByteLink } from "../link/tcp-byte-link";
import type { FakeByteLink } from "../link/fake-byte-link";
import { kretzChecksum } from "../../../web/src/features/inventory/kretz/kretz-frame";
import { parseAuraPlu } from "../../../web/src/features/inventory/kretz/aura-plu";
import { fakeReadRecord } from "../../../web/src/features/inventory/systel/systel-fake";
import { parsePluAs } from "../../../web/src/features/inventory/systel/systel-plu";
import { FaultySystelLink, type Fault, type FaultKind } from "../../../web/src/features/scales/engine/test-scale-sims";
import { FakeCuora, FakeReportDevice, RealAuraDevice, auraLink, cuoraLink, startReportServer, CH340, FTDI } from "./testing/simulators";
import { catalog, testScale, type Product, type TestScale } from "./testing/harness";
import type { SendResult } from "./scale-jobs";

type Bytes = Uint8Array | number[];
interface ByteDevice {
  receive(chunk: Bytes): number[];
}

/** Kretz a nivel de bytes con una falla en la trama k (delante de FakeReportDevice o RealAuraDevice). */
class FaultyKretzBytes implements ByteDevice {
  readonly ops: string[] = [];
  fault: Fault | null = null;
  onCut: (() => void) | null = null;
  private buffer: number[] = [];
  private cut = false;

  constructor(
    private readonly inner: ByteDevice,
    private readonly letter: string,
    private readonly priceAt: number,
  ) {}

  private reply(code: string, data = ""): number[] {
    const body = [0x07, ...Array.from(`${this.letter}0100${code}${data}`, (c) => c.charCodeAt(0))];
    return [...body, ...kretzChecksum(body), 0x04];
  }

  receive(chunk: Bytes): number[] {
    this.buffer.push(...chunk);
    const out: number[] = [];
    for (;;) {
      const start = this.buffer.indexOf(0x02);
      if (start < 0) {
        this.buffer = [];
        break;
      }
      if (start > 0) this.buffer.splice(0, start);
      const end = this.buffer.indexOf(0x04);
      if (end < 0) break;
      const frame = this.buffer.splice(0, end + 1);
      out.push(...this.handle(frame));
    }
    return out;
  }

  private handle(frame: number[]): number[] {
    const command = String.fromCharCode(...frame.slice(4, 8));
    const index = this.ops.length;
    this.ops.push(command);
    const f = this.fault && (this.fault.kind === "corte" ? index >= this.fault.at : index === this.fault.at) ? this.fault : null;
    if (this.cut || f?.kind === "corte") {
      if (!this.cut) setTimeout(() => this.onCut?.(), 0);
      this.cut = true;
      return [];
    }
    if (f?.kind === "sin_respuesta") return [];
    if (f?.kind === "error") return this.reply("10");
    if (f?.kind === "ack_sin_grabar" && (command === "2005" || command === "1070")) return this.reply("01");
    const r = this.inner.receive(frame);
    if (f?.kind === "respuesta_perdida") return [];
    if (f?.kind === "relectura_distinta" && command === "5005" && r.length > 20) {
      const text = String.fromCharCode(...r);
      const code = text.slice(6, 8);
      const data = text.slice(8, text.length - 3);
      if (code === "01" && data.length > this.priceAt + 6) {
        const i = this.priceAt + 5;
        const bumped = data.slice(0, i) + String((Number(data[i]) + 1) % 10) + data.slice(i + 1);
        const body = [0x07, ...Array.from(text.slice(1, 6) + code + bumped, (c) => c.charCodeAt(0))];
        return [...body, ...kretzChecksum(body), 0x04];
      }
    }
    return r;
  }
}

type Kind = "report" | "aura" | "cuora";
const FAST: FaultKind[] = ["error", "ack_sin_grabar", "relectura_distinta"];
const SLOW: FaultKind[] = ["sin_respuesta", "respuesta_perdida", "corte"];

interface Rig {
  scale: TestScale;
  products: Product[];
  ops: () => number;
  correct: (p: Product) => boolean;
  foreign: () => string;
  stop: () => Promise<void>;
}

function reportRecord(plu: number, name: string): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return [pad(plu, 6), "001", "001", name.padEnd(26), "".padEnd(26), pad(plu, 5), "P", pad(0, 7), pad(8000, 6), pad(0, 6), pad(2, 6), pad(0, 6), pad(0, 6), pad(0, 5), pad(0, 5), "01", pad(0, 4), pad(0, 4), pad(1000, 4), pad(0, 4)].join("");
}

async function rig(kind: Kind, fault: Fault | null): Promise<Rig> {
  if (kind === "report") {
    const device = new FakeReportDevice();
    device.records.set(900, reportRecord(900, "QUESO RALLADO"));
    const faulty = new FaultyKretzBytes(device, "C", 77);
    faulty.fault = fault;
    const server = await startReportServer(faulty as unknown as FakeReportDevice);
    faulty.onCut = () => {
      for (const s of server.sockets) s.destroy();
    };
    const scale = await testScale({
      device: { id: "report", name: "Report", transport: { type: "tcp", host: "127.0.0.1", port: server.port } },
      resource: tcpResource("127.0.0.1", server.port),
      createLink: () => new TcpByteLink({ host: "127.0.0.1", port: server.port }),
    });
    const products = catalog(4, 1, 26);
    return {
      scale,
      products,
      ops: () => faulty.ops.length,
      correct: (p) => {
        const r = device.records.get(Number(p.code));
        return !!r && r.slice(12, 38).trimEnd() === p.name && r.slice(69, 70) === (p.unit === "kg" ? "P" : "N") && Number(r.slice(77, 83)) === p.priceRetail;
      },
      foreign: () => device.records.get(900) ?? "",
      stop: async () => {
        await scale.worker.stop();
        await server.close();
      },
    };
  }
  if (kind === "aura") {
    const device = new RealAuraDevice();
    const faulty = new FaultyKretzBytes(device, "H", 29);
    faulty.fault = fault;
    const link = auraLink(device);
    link.respond = (written: Uint8Array, l: FakeByteLink) => {
      const out = faulty.receive(written);
      return out.length && l ? Uint8Array.from(out) : null;
    };
    faulty.onCut = () => link.simulateDisconnect("cable desenchufado");
    const scale = await testScale({ device: { id: "aura", name: "Aura", transport: { type: "serial", ...CH340 } }, resource: serialResource("COM5"), createLink: () => link });
    const products = catalog(4, 101);
    const original = device.records.filter((r) => Number(r.slice(0, 6)) < 100).join("|");
    return {
      scale,
      products,
      ops: () => faulty.ops.length,
      correct: (p) => {
        const rec = device.records.find((x) => Number(x.slice(0, 6)) === Number(p.code));
        const parsed = rec ? parseAuraPlu(rec) : null;
        return !!parsed && parsed.name.trim() === p.name.toUpperCase() && parsed.type === (p.unit === "kg" ? "D" : "C") && Number(parsed.priceRaw) === p.priceRetail;
      },
      foreign: () => (device.records.filter((r) => Number(r.slice(0, 6)) < 100).join("|") === original ? "igual" : "cambió"),
      stop: () => scale.worker.stop(),
    };
  }
  const cuora = new FakeCuora("max60", { address: 1, protocol: "0060" });
  cuora.plus.set(900, fakeReadRecord("max60", { number: 900, name: "MODELO KILO", price: 100, code: 900, type: "P" }));
  cuora.plus.set(901, fakeReadRecord("max60", { number: 901, name: "MODELO UNIDAD", price: 50, code: 901, type: "U" }));
  const faulty = new FaultySystelLink(cuora);
  faulty.fault = fault;
  const link = cuoraLink(faulty as unknown as FakeCuora);
  let cut = false;
  const scale = await testScale({ device: { id: "cuora", name: "Cuora", transport: { type: "serial", ...FTDI } }, resource: serialResource("COM7"), createLink: () => link });
  const exchange = faulty.exchange.bind(faulty);
  faulty.exchange = async (frame: Uint8Array) => {
    const r = await exchange(frame);
    if (!cut && fault?.kind === "corte" && faulty.ops.length > fault.at) {
      cut = true;
      setTimeout(() => link.simulateDisconnect("cable desenchufado"), 0);
    }
    return r;
  };
  const products = catalog(4, 1, 18);
  const before = `${cuora.plus.get(900)}|${cuora.plus.get(901)}`;
  return {
    scale,
    products,
    ops: () => faulty.ops.length,
    correct: (p) => {
      const raw = cuora.plus.get(Number(p.code));
      const plu = raw ? parsePluAs("max60", raw, Number(p.code)) : null;
      return !!plu && plu.name.trim() === p.name && plu.prices[0] === p.priceRetail && plu.saleType === (p.unit === "kg" ? "P" : "U");
    },
    foreign: () => (`${cuora.plus.get(900)}|${cuora.plus.get(901)}` === before ? "igual" : "cambió"),
    stop: () => scale.worker.stop(),
  };
}

async function runCase(kind: Kind, fault: Fault | null, jobId: string): Promise<{ violations: string[]; ops: number; ok: boolean }> {
  const r = await rig(kind, fault);
  const foreignBefore = r.foreign();
  const v: string[] = [];
  let ok = false;
  try {
    const o = await r.scale.host.send({ branchId: "b1", products: r.products }, jobId);
    const journaled = (r.scale.journal.get(jobId)?.steps ?? []).map((s) => s.key).filter((k) => k.startsWith("producto:")).map((k) => k.slice(9));
    for (const code of journaled) {
      const p = r.products.find((x) => String(Number(x.code)) === code);
      if (p && !r.correct(p)) v.push(`el diario anotó ${code} como confirmado y no está bien en la balanza`);
    }
    if (o.status === "done") {
      const res = (o as { result: SendResult }).result;
      ok = res.ok;
      if (res.ok) for (const p of r.products) if (!r.correct(p)) v.push(`ok pero ${p.code} no quedó`);
      for (const p of res.products) if (p.status === "confirmado" && !r.correct(r.products.find((x) => x.code === p.code)!)) v.push(`${p.code} informado confirmado y no quedó`);
      if (res.confirmed !== res.products.filter((p) => p.status === "confirmado").length) v.push("cuenta de confirmados distinta");
    }
  } finally {
    await r.stop();
  }
  if (r.foreign() !== foreignBefore) v.push("se pisó un producto que no es de Patagonia");
  return { violations: v, ops: r.ops(), ok };
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

for (const kind of ["report", "aura", "cuora"] as Kind[]) {
  test(`[SIMULADO] conector · ${kind}: falla en cada operación k (todas las fallas)`, async (t) => {
    const base = await runCase(kind, null, `${kind}-base`);
    assert.deepEqual(base.violations, []);
    assert.equal(base.ok, true, "sin fallas sale bien");
    const cases: Fault[] = [];
    for (let at = 0; at < base.ops; at++) for (const k of [...FAST, ...SLOW]) cases.push({ at, kind: k });
    let n = 0;
    const results = await pool(cases, 64, (f) => runCase(kind, f, `${kind}-${n++}`));
    const bad = results.map((r, i) => ({ r, f: cases[i] })).filter((x) => x.r.violations.length > 0);
    t.diagnostic(`${kind}: ${base.ops} operaciones × ${FAST.length + SLOW.length} fallas = ${cases.length} casos; ${results.filter((r) => !r.ok).length} sin "ok"`);
    assert.equal(bad.length, 0, bad.slice(0, 10).map((x) => `k=${x.f.at} ${x.f.kind}: ${x.r.violations.join(" / ")}`).join("\n"));
  });
}
