import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeCuora } from "../../inventory/systel/systel-fake";
import type { SystelSerialSettings } from "../../inventory/systel/systel-serial";
import { makeSystelAdapter, type SystelDeps } from "../engine/adapters/systel";
import { busyKind, candidatePorts, connectBranchScale, portFitsFamily } from "../engine/connect-branch";
import { FriendlyError } from "../engine/friendly";
import type { EngineContext, ScaleAdapter, ScaleSession } from "../engine/types";
import { bindingFor, CONNECTION_KEYS, forgetBinding, restoreBinding, saveBinding } from "./local-bindings";
import { checkScaleFormats, choiceForScale, defaultScaleName, findRegistered, identityClash, legacyCandidate, sameIdentity, scaleStatus, type BranchScale } from "./scale-identity";
import { registerSerialHolder, releaseLocalHolders } from "../../inventory/kretz/serial-tabs";

/**
 * Varias balanzas por sucursal (migración 134, docs/BALANZAS_DIAGNOSTICO_2026-10-19.md).
 * [SIMULADO]: puertos y balanzas de mentira (la Cuora simulada sale de los documentos de Systel y de los registros
 * reales de Los gringos). Lo que depende del equipo físico está listado al final del documento.
 */

beforeEach(() => installFakeLocalStorage());

const noop = () => {};
const scale = (key: string, family: "systel" | "kretz", identity: Record<string, unknown> = {}, extra: Partial<BranchScale> = {}): BranchScale => ({
  key,
  name: extra.name ?? key,
  family,
  brand: family,
  model: extra.model ?? (family === "systel" ? "Systel Cuora Max" : "Kretz Aura"),
  identity,
  active: true,
  lastSeenAt: null,
  sellsWithCodes: false,
  ...extra
});
const ctx = (): EngineContext => ({ branchId: "b1", products: [], online: false });

// ── Puerto y balanzas de mentira ───────────────────────────────────────────────────────────────────────────────
function fakePort(usb: [number, number] | null, opts: { answer?: Record<string, unknown>; busy?: boolean } = {}) {
  return {
    usb,
    opts,
    getInfo: () => (usb ? { usbVendorId: usb[0], usbProductId: usb[1] } : {})
  } as unknown as SerialPort & { opts: { answer?: Record<string, unknown>; busy?: boolean } };
}
/** Adaptador de mentira: contesta lo que diga el puerto (su identidad), o nada. */
function fakeAdapter(family: "systel" | "kretz", seen: string[] = []): ScaleAdapter {
  return {
    family,
    identify: async (port) => {
      const p = port as unknown as { opts: { answer?: Record<string, unknown>; busy?: boolean } };
      seen.push(family);
      if (p.opts.busy) {
        const e = new Error("Failed to open serial port.");
        e.name = "NetworkError";
        throw e;
      }
      if (!p.opts.answer || p.opts.answer.family !== family) return null;
      const id = { ...p.opts.answer };
      delete id.family;
      let closed = false;
      return {
        model: family === "systel" ? "systel-cuora-max" : "kretz-aura",
        label: family === "systel" ? "Systel Cuora Max" : "Kretz Aura",
        identity: () => id,
        close: async () => void (closed = closed || true),
        prepare: async () => ({}) as never,
        sync: async () => ({}) as never,
        supportInfo: () => ({})
      } as ScaleSession;
    }
  };
}
const serialOf = (ports: SerialPort[], picked?: SerialPort) => {
  let asked = 0;
  return {
    api: {
      getPorts: async () => ports,
      requestPort: async () => {
        asked++;
        if (!picked) throw Object.assign(new Error("No port selected by the user."), { name: "NotFoundError" });
        return picked;
      }
    },
    asked: () => asked
  };
};
const FTDI: [number, number] = [0x0403, 0x6001];
const CH340: [number, number] = [0x1a86, 0x7523];

describe("[SIMULADO] Agregar y reconectar balanzas de una sucursal", () => {
  it("balanza nueva: abre la lista de cables una vez y la reconoce como nueva", async () => {
    const p = fakePort(FTDI, { answer: { family: "systel", address: 20 } });
    const s = serialOf([], p);
    const r = await connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: s.api, adapters: [fakeAdapter("systel"), fakeAdapter("kretz")] });
    assert.equal(s.asked(), 1);
    assert.equal(r.family, "systel");
    assert.equal(r.matched, null);
    assert.deepEqual(r.identity, { address: 20 });
    assert.equal(r.usb, "0403:6001");
    assert.ok(r.diag.steps.some((x) => /conectada/.test(x)));
  });

  it("segunda balanza del MISMO modelo con otro número: es nueva, no pisa la primera", async () => {
    const known = [scale("systel-a", "systel", { address: 20 })];
    const p = fakePort(FTDI, { answer: { family: "systel", address: 21 } });
    const r = await connectBranchScale(ctx(), noop, { target: null, known, pick: true }, { serial: serialOf([], p).api, adapters: [fakeAdapter("systel")] });
    assert.equal(r.matched, null, "no la confunde con la primera");
  });

  it("agregar una con el mismo número que una registrada: es NUEVA (no alcanza el número), y se avisa el parecido", async () => {
    const known = [scale("systel-a", "systel", { address: 20 }), scale("kretz-b", "kretz", { letter: "H", equipment: "01" })];
    const p = fakePort(CH340, { answer: { family: "kretz", letter: "H", equipment: "01" } });
    const r = await connectBranchScale(ctx(), noop, { target: null, known, pick: true }, { serial: serialOf([], p).api, adapters: [fakeAdapter("systel"), fakeAdapter("kretz")] });
    assert.equal(r.matched, null);
    assert.equal(r.lookalike?.key, "kretz-b");
  });

  it("la Systel de antes de la 134 (sin identidad): agregar otra no la pisa; queda como parecida", async () => {
    const known = [scale("systel", "systel", {})];
    const p = fakePort(FTDI, { answer: { family: "systel", address: 20 } });
    const r = await connectBranchScale(ctx(), noop, { target: null, known, pick: true }, { serial: serialOf([], p).api, adapters: [fakeAdapter("systel")] });
    assert.equal(r.matched, null);
    assert.equal(r.lookalike?.key, "systel");
  });

  it("dos modelos diferentes en la misma computadora: cada una se conecta por su cable, sin abrir la lista", async () => {
    const sys = fakePort(FTDI, { answer: { family: "systel", address: 20 } });
    const aura = fakePort(CH340, { answer: { family: "kretz", letter: "H", equipment: "01" } });
    const s = serialOf([sys, aura]);
    const known = [scale("systel-a", "systel", { address: 20 }), scale("kretz-b", "kretz", { letter: "H", equipment: "01" })];
    saveBinding("systel-a", { branchId: "b1", family: "systel", usb: "0403:6001" });
    saveBinding("kretz-b", { branchId: "b1", family: "kretz", usb: "1a86:7523" });
    const seenA: string[] = [];
    const a = await connectBranchScale(ctx(), noop, { target: known[0], known, pick: false }, { serial: s.api, adapters: [fakeAdapter("systel", seenA), fakeAdapter("kretz", seenA)] });
    const b = await connectBranchScale(ctx(), noop, { target: known[1], known, pick: false }, { serial: s.api, adapters: [fakeAdapter("systel"), fakeAdapter("kretz")] });
    assert.equal(a.usb, "0403:6001");
    assert.equal(b.usb, "1a86:7523");
    assert.deepEqual(seenA, ["systel"], "a una Systel registrada no se le prueba el protocolo Kretz");
    assert.equal(s.asked(), 0, "cerrar y volver a abrir el sistema: no se vuelve a pedir el cable");
  });

  it("dos cables IGUALES (dos Systel por FTDI): se queda con el que contesta el número registrado", async () => {
    const first = fakePort(FTDI, { answer: { family: "systel", address: 20 } });
    const second = fakePort(FTDI, { answer: { family: "systel", address: 21 } });
    const target = scale("systel-b", "systel", { address: 21 });
    saveBinding("systel-b", { branchId: "b1", family: "systel", usb: "0403:6001" });
    const r = await connectBranchScale(ctx(), noop, { target, known: [target], pick: false }, { serial: serialOf([first, second]).api, adapters: [fakeAdapter("systel")] });
    assert.equal(r.matched?.key, "systel-b");
    assert.deepEqual(r.identity, { address: 21 });
    assert.ok(r.diag.steps.some((x) => /contestó otra balanza/.test(x)), "queda en el reporte que primero contestó la otra");
  });

  it("contesta otra balanza y ningún cable es el de ella → mensaje claro, no se conecta a la equivocada", async () => {
    const other = fakePort(FTDI, { answer: { family: "systel", address: 20 } });
    const target = scale("systel-b", "systel", { address: 21 });
    saveBinding("systel-b", { branchId: "b1", family: "systel", usb: "0403:6001" });
    await assert.rejects(
      () => connectBranchScale(ctx(), noop, { target, known: [target], pick: false }, { serial: serialOf([other]).api, adapters: [fakeAdapter("systel")] }),
      (e: unknown) => e instanceof FriendlyError && e.kind === "otra_balanza"
    );
  });

  it("balanza registrada desde otra computadora: si acá no hay un cable que le sirva, pide elegirlo (no adivina)", async () => {
    const target = scale("systel-a", "systel", { address: 20 });
    await assert.rejects(
      () => connectBranchScale(ctx(), noop, { target, known: [target], pick: false }, { serial: serialOf([fakePort(CH340)]).api, adapters: [fakeAdapter("systel")] }),
      (e: unknown) => e instanceof FriendlyError && e.kind === "elegir_cable"
    );
  });

  it("puerto tomado: si otra pestaña de Patagonia lo tiene en uso lo dice; si no, es otro programa (Qendra)", async () => {
    const busy = fakePort(FTDI, { busy: true });
    const target = scale("systel-a", "systel", { address: 20 });
    saveBinding("systel-a", { branchId: "b1", family: "systel", usb: "0403:6001" });
    const run = (otherTabs: { busy: number }[]) =>
      connectBranchScale(ctx(), noop, { target, known: [target], pick: false }, { serial: serialOf([busy]).api, adapters: [fakeAdapter("systel")], release: async () => ({ localReleased: 0, otherTabs }) });
    await assert.rejects(() => run([{ busy: 1 }]), (e: unknown) => e instanceof FriendlyError && e.kind === "puerto_ocupado");
    await assert.rejects(() => run([]), (e: unknown) => e instanceof FriendlyError && e.kind === "puerto_otro_programa");
  });

  it("antes de hablarle pide soltar el cable y restaura la configuración de ESA balanza", async () => {
    const order: string[] = [];
    const p = fakePort(FTDI, { answer: { family: "systel", address: 20 } });
    const target = scale("systel-a", "systel", { address: 20 });
    saveBinding("systel-a", { branchId: "b1", family: "systel", usb: "0403:6001" });
    const adapter: ScaleAdapter = { family: "systel", identify: async (port, c, prog) => (order.push("identify"), fakeAdapter("systel").identify(port, c, prog)) };
    await connectBranchScale(ctx(), noop, { target, known: [target], pick: false }, {
      serial: serialOf([p]).api,
      adapters: [adapter],
      release: async () => (order.push("release"), { localReleased: 1, otherTabs: [] }),
      restore: () => void order.push("restore")
    });
    assert.deepEqual(order, ["release", "restore", "identify"]);
  });

  it("cancelar la lista de cables → le decimos que elija la balanza", async () => {
    await assert.rejects(() => connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: serialOf([]).api, adapters: [] }), (e: unknown) => e instanceof FriendlyError && e.kind === "sin_eleccion");
  });
});

// ── Con el protocolo Systel REAL contra dos Cuora simuladas ────────────────────────────────────────────────────
class FakeSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  constructor(private cuora: FakeCuora, private wants: SystelSerialSettings, private usb: [number, number]) {}
  getInfo() {
    return { usbVendorId: this.usb[0], usbProductId: this.usb[1] };
  }
  async open(o: { baudRate: number; stopBits?: number; parity?: string }) {
    const match = o.baudRate === this.wants.baudRate && (o.stopBits ?? 1) === this.wants.stopBits && (o.parity ?? "none") === this.wants.parity;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const cuora = this.cuora;
    this.writable = new WritableStream<Uint8Array>({
      async write(frame) {
        if (!match) return;
        const reply = await cuora.exchange(frame);
        if (reply) setTimeout(() => controller.enqueue(reply), 2);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
  async setSignals() {}
}
const nullDeps: SystelDeps = { loadSetup: async () => null, saveCatalog: async () => ({}), setLinks: async () => ({}), setActive: async () => ({}), saveLocalBackup: () => {} };

describe("[SIMULADO] Dos Systel Cuora Max iguales en la misma computadora (protocolo real)", () => {
  const settings: SystelSerialSettings = { baudRate: 115200, stopBits: 1, parity: "none" };

  it("cada una contesta su número y se reconecta la correcta", async () => {
    const p20 = new FakeSerialPort(new FakeCuora("max60", { address: 20 }), settings, FTDI) as unknown as SerialPort;
    const p21 = new FakeSerialPort(new FakeCuora("max60", { address: 21 }), settings, FTDI) as unknown as SerialPort;
    const adapter = makeSystelAdapter(nullDeps);
    const known: BranchScale[] = [];
    const a = await connectBranchScale(ctx(), noop, { target: null, known, pick: true }, { serial: serialOf([p20, p21], p20).api, adapters: [adapter] });
    assert.deepEqual(a.identity, { address: 20 });
    await a.session.close();
    const b = await connectBranchScale(ctx(), noop, { target: null, known: [scale("s20", "systel", a.identity)], pick: true }, { serial: serialOf([p20, p21], p21).api, adapters: [adapter] });
    assert.deepEqual(b.identity, { address: 21 });
    assert.equal(b.matched, null, "la segunda es nueva");
    await b.session.close();
    // Reabrir el sistema: se reconecta la del 21 sin abrir la lista, aunque los dos cables sean iguales.
    const t21 = scale("s21", "systel", { address: 21 });
    saveBinding("s21", { branchId: "b1", family: "systel", usb: "0403:6001" });
    const again = await connectBranchScale(ctx(), noop, { target: t21, known: [scale("s20", "systel", { address: 20 }), t21], pick: false }, { serial: serialOf([p20, p21]).api, adapters: [adapter] });
    assert.deepEqual(again.identity, { address: 21 });
    assert.ok(again.diag.log.length > 0, "el intercambio de bytes queda para soporte");
    await again.session.close();
  });
});

describe("Identidad de cada balanza y estado (lógica pura)", () => {
  it("misma balanza = coinciden en todo lo que las dos saben", () => {
    assert.equal(sameIdentity({ address: 20 }, { address: 20 }), true);
    assert.equal(sameIdentity({ address: 20 }, { address: "20" }), true);
    assert.equal(sameIdentity({ address: 20 }, { address: 21 }), false);
    assert.equal(sameIdentity({}, { address: 20 }), false, "sin datos en común no se puede decir que sea la misma");
    assert.equal(sameIdentity({ letter: "H", equipment: "01" }, { letter: "H", equipment: null }), true);
  });

  it("registradas: encuentra la misma, la de antes sin identidad y los choques", () => {
    const list = [scale("a", "systel", { address: 20 }), scale("b", "kretz", { letter: "H" })];
    assert.equal(findRegistered(list, "systel", { address: 20 })?.key, "a");
    assert.equal(findRegistered(list, "kretz", { address: 20 }), null);
    assert.equal(legacyCandidate([scale("systel", "systel")], "systel")?.key, "systel");
    assert.equal(legacyCandidate([scale("x", "systel"), scale("y", "systel")], "systel"), null);
    assert.equal(identityClash(list, "systel", { address: 20 }, null)?.key, "a");
    assert.equal(identityClash(list, "systel", { address: 20 }, "a"), null);
  });

  it("nombre inicial sin repetir y modelo para buscar", () => {
    assert.equal(defaultScaleName("Systel Cuora Max", []), "Systel Cuora Max");
    assert.equal(defaultScaleName("Systel Cuora Max", [scale("a", "systel", {}, { name: "Systel Cuora Max" })]), "Systel Cuora Max 2");
    assert.equal(choiceForScale({ family: "kretz", model: "Kretz Aura", name: "x" }), "kretz-aura");
    assert.equal(choiceForScale({ family: "kretz", model: "Kretz Report", name: "x" }), "kretz-report");
    assert.equal(choiceForScale({ family: "systel", model: null, name: "x" }), "systel");
  });

  it("estado en palabras simples", () => {
    const now = new Date("2026-10-19T15:00:00");
    assert.match(scaleStatus({ active: true, sellsWithCodes: true, localOkAt: null }, now).text, /no se conectó en esta computadora/);
    assert.match(scaleStatus({ active: true, sellsWithCodes: true, localOkAt: "2026-10-19T14:30:00" }, now).text, /Lista en esta computadora · última conexión hoy/);
    assert.equal(scaleStatus({ active: false, sellsWithCodes: true, localOkAt: "2026-10-19T14:30:00" }, now).tone, "off");
  });

  it("chip del cable y quién tiene el puerto", () => {
    assert.equal(portFitsFamily("0403:6001", "systel"), true);
    assert.equal(portFitsFamily("0403:6001", "kretz"), false);
    assert.equal(portFitsFamily(null, "kretz"), true);
    assert.equal(busyKind([{ busy: 0 }, { busy: 2 }]), "puerto_ocupado");
    assert.equal(busyKind(undefined), "puerto_otro_programa");
    const target = scale("a", "systel");
    assert.equal(candidatePorts([fakePort(FTDI), fakePort(CH340)], target, null).length, 1);
  });
});

describe("Configuración de cada balanza en esta computadora (local-bindings)", () => {
  it("dos balanzas de la misma marca no se pisan la configuración", () => {
    localStorage.setItem("patagonia-systel-link", JSON.stringify({ address: 20, settings: { baudRate: 115200 } }));
    saveBinding("s20", { branchId: "b1", family: "systel", usb: "0403:6001" });
    localStorage.setItem("patagonia-systel-link", JSON.stringify({ address: 21, settings: { baudRate: 57600 } }));
    saveBinding("s21", { branchId: "b1", family: "systel", usb: "0403:6001" });
    restoreBinding(bindingFor("s20", "b1")!);
    assert.equal(JSON.parse(localStorage.getItem("patagonia-systel-link")!).address, 20);
    restoreBinding(bindingFor("s21", "b1")!);
    assert.equal(JSON.parse(localStorage.getItem("patagonia-systel-link")!).address, 21);
  });

  it("separadas por sucursal; quitar una no toca la otra; no copia formatos de etiqueta", () => {
    saveBinding("k", { branchId: "b1", family: "kretz", usb: null });
    saveBinding("k", { branchId: "b2", family: "kretz", usb: "1a86:7523" });
    assert.equal(bindingFor("k", "b1")?.usb, null);
    assert.equal(bindingFor("k", "b2")?.usb, "1a86:7523");
    forgetBinding("k", "b1");
    assert.equal(bindingFor("k", "b1"), null);
    assert.ok(bindingFor("k", "b2"));
    assert.ok(!CONNECTION_KEYS.systel.includes("patagonia-systel-label-templates"));
  });
});

describe("Soltar el cable entre pantallas (serial-tabs)", () => {
  it("pide a quien tiene el puerto que lo suelte y cuenta cuántos se cerraron", async () => {
    let released = 0;
    const off = registerSerialHolder(async () => (released++, 1));
    assert.equal(await releaseLocalHolders(), 1);
    off();
    assert.equal(await releaseLocalHolders(), 0);
    assert.equal(released, 1);
  });
});

describe("[SIMULADO, caso REAL Los gringos 19/10] La Cuora contesta E3 (ocupada) a todo", () => {
  const settings: SystelSerialSettings = { baudRate: 115200, stopBits: 1, parity: "none" };

  it("se distingue de 'no contestó', el reporte lleva el intercambio, y cuando se libera conecta igual", async () => {
    const cuora = new FakeCuora("max60", { address: 20, protocol: "0060" });
    cuora.busyReplies = 100_000;
    const port = new FakeSerialPort(cuora, settings, FTDI) as unknown as SerialPort;
    const adapter = makeSystelAdapter(nullDeps);
    const r = await connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: serialOf([port], port).api, adapters: [adapter] });
    assert.deepEqual(r.identity, { address: 20 }, "la búsqueda la encuentra: contestó por el cable con su número");
    assert.ok(r.diag.steps.some((s) => /E1\/E2\/E3/.test(s)), "el reporte dice que contestó pero no atiende");
    await assert.rejects(() => r.session.prepare(noop), (e: unknown) => e instanceof FriendlyError && e.kind === "balanza_ocupada");
    const info = r.session.supportInfo() as { contesto_ocupada: boolean; intercambio_sesion: { rxText: string }[]; detalle: string };
    assert.equal(info.contesto_ocupada, true);
    assert.ok(info.intercambio_sesion.some((l) => /^E3/.test(l.rxText)), "los bytes de la lectura fallida ya no se pierden");
    assert.match(info.detalle, /E3/);
    // La balanza se libera (terminó la venta): la misma sesión lee bien.
    cuora.busyReplies = 0;
    await r.session.prepare(noop);
    const after = r.session.supportInfo() as { firma: { protocolVersion: string } | null };
    assert.equal(after.firma?.protocolVersion, "0060", "leyó la firma: la balanza ya atiende");
    await r.session.close();
  });
});

describe("[SIMULADO] Balanza que no atiende pedidos a su número (hipótesis Los gringos 19/10, balanza nueva)", () => {
  it("la búsqueda la encuentra por el general, la lectura elige el número que atiende y se lee completa", async () => {
    const cuora = new FakeCuora("max60", { address: 20, protocol: "0060", deafToOwnNumber: true });
    const port = new FakeSerialPort(cuora, { baudRate: 115200, stopBits: 1, parity: "none" }, FTDI) as unknown as SerialPort;
    const r = await connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: serialOf([port], port).api, adapters: [makeSystelAdapter(nullDeps)] });
    assert.deepEqual(r.identity, { address: 20 });
    await r.session.prepare(noop);
    const info = r.session.supportInfo() as { firma: { protocolVersion: string } | null; direccion_pedidos: number; como_se_eligio: string };
    assert.equal(info.firma?.protocolVersion, "0060", "leyó la firma");
    assert.equal(info.direccion_pedidos, 0, "los pedidos van al general porque a su número no atiende");
    assert.match(info.como_se_eligio, /general/);
    await r.session.close();
  });

  it("una balanza normal sigue usando su número (no cambia lo que ya anda)", async () => {
    const cuora = new FakeCuora("max60", { address: 20, protocol: "0060" });
    const port = new FakeSerialPort(cuora, { baudRate: 115200, stopBits: 1, parity: "none" }, FTDI) as unknown as SerialPort;
    const r = await connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: serialOf([port], port).api, adapters: [makeSystelAdapter(nullDeps)] });
    await r.session.prepare(noop);
    const info = r.session.supportInfo() as { direccion_pedidos: number };
    assert.ok(info.direccion_pedidos === 20 || info.direccion_pedidos === 1);
    await r.session.close();
  });
});

describe("[SIMULADO] Balanza que contesta E3 mientras DTR y RTS están encendidas (hipótesis Los gringos 19/10)", () => {
  /** Puerto de mentira que registra las señales: con las dos encendidas, la Cuora contesta E3 a todo. */
  class SignalPort extends FakeSerialPort {
    dtr = false;
    rts = false;
    constructor(private readonly c: FakeCuora) {
      super(c, { baudRate: 115200, stopBits: 1, parity: "none" }, FTDI);
    }
    override async setSignals(s?: { dataTerminalReady?: boolean; requestToSend?: boolean }) {
      if (s?.dataTerminalReady !== undefined) this.dtr = s.dataTerminalReady;
      if (s?.requestToSend !== undefined) this.rts = s.requestToSend;
      this.c.busyReplies = this.dtr && this.rts ? 1_000_000 : 0;
    }
  }

  it("prueba otras señales solo leyendo, se queda con la que atiende y la informa para guardarla", async () => {
    const cuora = new FakeCuora("max60", { address: 20, protocol: "0060" });
    const port = new SignalPort(cuora);
    let hints: unknown = null;
    const adapter = makeSystelAdapter({ ...nullDeps, onConnectionHints: (h) => void (hints = h) });
    const r = await connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: serialOf([port as unknown as SerialPort], port as unknown as SerialPort).api, adapters: [adapter] });
    await r.session.prepare(noop);
    const info = r.session.supportInfo() as { firma: { protocolVersion: string } | null; senales: unknown };
    assert.equal(info.firma?.protocolVersion, "0060", "leyó la firma");
    assert.deepEqual(info.senales, { dtr: false, rts: false }, "atendió con las dos apagadas, como el ejemplo oficial");
    assert.deepEqual((hints as { lines: unknown }).lines, { dtr: false, rts: false });
    assert.ok(!cuora.received.some((x) => [4, 5, 7, 33, 61].includes(x.fn)), "solo lecturas: no se escribió nada");
    await r.session.close();
  });
});

describe("[SIMULADO, protocolo DOCUMENTADO] Funciones 25 (liberar) y 35 (no esperar sincronización)", () => {
  const settings: SystelSerialSettings = { baudRate: 115200, stopBits: 1, parity: "none" };

  it("sin confirmación es SOLO LECTURA: con E3 a todo no manda la 25", async () => {
    const cuora = new FakeCuora("max60", { address: 20, protocol: "0060" });
    cuora.e3UntilRelease = true;
    const port = new FakeSerialPort(cuora, settings, FTDI) as unknown as SerialPort;
    const r = await connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: serialOf([port], port).api, adapters: [makeSystelAdapter(nullDeps)] });
    await assert.rejects(() => r.session.prepare(noop), (e: unknown) => e instanceof FriendlyError && e.kind === "balanza_ocupada");
    assert.equal(cuora.received.filter((x) => [4, 5, 7, 25, 33, 35, 61].includes(x.fn)).length, 0, "ni la 25 ni ninguna escritura");
    await r.session.close();
  });

  it("con la confirmación en pantalla, manda la 25 una vez, y si después atiende, lee completa", async () => {
    const cuora = new FakeCuora("max60", { address: 20, protocol: "0060" });
    cuora.e3UntilRelease = true;
    const port = new FakeSerialPort(cuora, settings, FTDI) as unknown as SerialPort;
    const r = await connectBranchScale({ ...ctx(), allowSystelRelease: true }, noop, { target: null, known: [], pick: true }, { serial: serialOf([port], port).api, adapters: [makeSystelAdapter(nullDeps)] });
    await r.session.prepare(noop);
    const info = r.session.supportInfo() as { firma: { protocolVersion: string } | null; liberada_con_25: boolean };
    assert.equal(info.liberada_con_25, true);
    assert.equal(info.firma?.protocolVersion, "0060");
    assert.equal(cuora.received.filter((x) => x.fn === 25).length, 1, "la 25 se manda una sola vez si contestó ACK");
    await r.session.close();
  });

  it("Sinc=1: al leer solo avisa (no cambia nada); al sincronizar manda 35 N y lo comprueba releyendo", async () => {
    const cuora = new FakeCuora("max60", { address: 20, protocol: "0060" });
    cuora.config = "Ton=2;Gris=0;Pap=0;APa=0;Vel=5;CPr=0;CAdm=01234;CCon=01234;Sinc=1;E_P=20PPPPCCCCII;E_U=21PPPPCCCCII;E_S=22AAIIIIIIII;CImp=2;SEt=S;ETi=S";
    const port = new FakeSerialPort(cuora, settings, FTDI) as unknown as SerialPort;
    const r = await connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: serialOf([port], port).api, adapters: [makeSystelAdapter(nullDeps)] });
    const prep = await r.session.prepare(noop);
    assert.equal(cuora.received.filter((x) => x.fn === 35).length, 0, "leer no cambia la configuración");
    assert.match(cuora.config!, /;Sinc=1;/);
    assert.ok(prep.notes.some((n) => /iniciar sin esperar/.test(n)), "se avisa antes de confirmar la sincronización");
    // Lo que hace sync() antes de escribir productos (acá se llama directo: la balanza simulada no tiene productos).
    await (r.session as unknown as { ensureNoStartupWait(c: { values: Record<string, string> }): Promise<void> }).ensureNoStartupWait({ values: { Sinc: "1" } });
    assert.match(cuora.config!, /;Sinc=0;/);
    assert.deepEqual(cuora.received.filter((x) => x.fn === 35).map((x) => x.data), ["N"]);
    await r.session.close();

    const ok = new FakeCuora("max60", { address: 20, protocol: "0060" });
    ok.config = cuora.config;
    const port2 = new FakeSerialPort(ok, settings, FTDI) as unknown as SerialPort;
    const r2 = await connectBranchScale(ctx(), noop, { target: null, known: [], pick: true }, { serial: serialOf([port2], port2).api, adapters: [makeSystelAdapter(nullDeps)] });
    await r2.session.prepare(noop);
    assert.equal(ok.received.filter((x) => x.fn === 35 || x.fn === 25).length, 0, "una balanza que ya atiende no recibe ni la 25 ni la 35");
    await r2.session.close();
  });
});

describe("[formatos REALES Los gringos] Tres Systel con el mismo número y el mismo cable, una por vez", () => {
  const vieja = scale("systel", "systel", {}, { name: "Systel Cuora", formats: { weighed: "20PPPPCCCCII", unit: "21PPPPCCCCII", total: "22AAIIIIIIII" } });
  const nueva = scale("systel-68afcb26", "systel", { address: 20 }, { name: "Balanza Systel", formats: { weighed: "20PPPPCCCCCC", unit: "21PPPPCCCCCC", total: "22BBIIIIIIII" } });
  const sinLeer = scale("systel-tercera", "systel", { address: 20 }, { name: "Tercera", formats: null });

  it("enchufada la nueva y tocada la tarjeta de la vieja: avisa que es la nueva y no sigue", () => {
    const r = checkScaleFormats(vieja, nueva.formats!, [vieja, nueva, sinLeer]);
    assert.equal(r.verdict, "otra");
    assert.equal(r.verdict === "otra" && r.same?.key, "systel-68afcb26");
  });

  it("la tarjeta correcta, o una tarjeta nunca leída: sigue", () => {
    assert.equal(checkScaleFormats(nueva, nueva.formats!, [vieja, nueva]).verdict, "ok");
    assert.equal(checkScaleFormats(sinLeer, vieja.formats!, [vieja, nueva, sinLeer]).verdict, "ok");
  });

  it("imprime distinto que todas: es otra (hay que agregarla)", () => {
    const r = checkScaleFormats(vieja, { weighed: "25PPPPCCCCCC", unit: null, total: null }, [vieja, nueva]);
    assert.equal(r.verdict === "otra" && r.same, null);
  });
});
