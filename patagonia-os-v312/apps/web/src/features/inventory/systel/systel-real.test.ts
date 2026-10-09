import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takeSystelBackup } from "./systel-backup";
import { SystelClient, type SystelExchangeLog } from "./systel-client";
import { discoverSystelLink } from "./systel-discovery";
import { findSystelReply, parseSystelReply, toHex, xorChecksum } from "./systel-frame";
import { parseConfig, parsePing, parsePluList, parseSignature } from "./systel-plu";
import { E3_PING, E3_SIGNATURE, hexToBytes, SESSION_OK_1608 } from "./systel-real-captures";
import { SerialSystelLink } from "./systel-serial";

/**
 * Pruebas con los bytes REALES de la Cuora Max de Los gringos (ver systel-real-captures.ts).
 * Lo que no salió de la balanza está marcado como DOCUMENTADO (lo dice el protocolo V6.0) o
 * HIPÓTESIS (modelo de lo que pudo pasar); esas pruebas comprueban lo que hace Patagonia, no la balanza.
 */

const real = (tx: string) => SESSION_OK_1608.find((x) => x.tx === tx)!;
const LIST = real("14 1f 0b");

describe("respuestas reales de la balanza de Los gringos", () => {
  it("firma, ping, ping general y configuración llegan completas y con la verificación bien", () => {
    for (const x of SESSION_OK_1608.filter((e) => e.rx && e.tx !== "14 1f 0b")) {
      const r = parseSystelReply(hexToBytes(x.rx));
      assert.ok(r?.checksumOk, `verificación de la respuesta a ${x.tx}`);
      assert.equal(r!.address, 20);
    }
  });

  it("la firma dice: protocolo 0060, 8.000 PLU, precio sin decimales", () => {
    const sig = parseSignature(parseSystelReply(hexToBytes(real("14 02 16").rx))!.data);
    assert.deepEqual(sig, { productType: "2000", capacityGrams: 30000, protocolVersion: "0060", pluCapacity: 8000, shortcuts: 60, priceDecimals: 0 });
  });

  it("ping 'D' (trabajando desactualizado) y la configuración con coma de precio 0 y sin espera de sincronización", () => {
    assert.deepEqual(parsePing(parseSystelReply(hexToBytes(real("14 17 03").rx))!.data), { state: "D" });
    const cfg = parseConfig(parseSystelReply(hexToBytes(real("14 27 33").rx))!.data);
    assert.equal(cfg.CPr, "0");
    assert.equal(cfg.Sinc, "0");
  });

  it("E3: tramas bien formadas y con la verificación bien (la balanza entendió dirección y función)", () => {
    for (const x of [E3_PING, E3_SIGNATURE]) {
      const r = parseSystelReply(hexToBytes(x.rx))!;
      assert.ok(r.checksumOk);
      assert.equal(r.kind, "error");
      assert.equal(r.errorCode, "E3");
      assert.equal(toHex(hexToBytes(x.tx)), x.tx, "es exactamente la misma orden que a las 16:08 tuvo respuesta");
    }
    assert.ok(SESSION_OK_1608.some((x) => x.tx === E3_PING.tx && x.rx.length > 0));
    assert.ok(SESSION_OK_1608.some((x) => x.tx === E3_SIGNATURE.tx && x.rx.length > 0));
  });

  it("la lista real llegó cortada: 140 PLU enteros, sin la 'F' final ni la verificación (CAUSA del fallo de las 16:08)", () => {
    const bytes = hexToBytes(LIST.rx);
    assert.equal(bytes.length, 982);
    const body = String.fromCharCode(...bytes.subarray(2));
    assert.equal(body.length % 7, 0, "cortada justo al final de un PLU");
    assert.equal(findSystelReply(bytes, 20, 31), null, "no es una trama completa");
    assert.equal(parsePluList(body), null, "sin la F no se acepta (no se trabaja con una lista a medias)");
    // DOCUMENTADO (protocolo V6.0, función 31): la lista termina con "F". Con ella son 140 PLU de 4 dígitos.
    const list = parsePluList(body + "F")!;
    assert.equal(list.entries.length, 140);
    assert.equal(list.digits, 4);
    assert.deepEqual(list.entries.slice(-4).map((e) => e.number), [500, 501, 502, 503]);
  });
});

/**
 * Puerto que contesta con los bytes reales de las 16:08 según la orden recibida, partidos en
 * paquetes USB de 62 bytes (FTDI). La lista se manda como llegó y, después de una pausa, la "F"
 * y la verificación (DOCUMENTADO, no capturado: es lo que no llegamos a ver).
 */
class ReplayPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  received: string[] = [];
  /** HIPÓTESIS E3: contesta E3 hasta que reciba una orden a otro número (1 o 0). */
  e3UntilOtherAddress = false;
  e3Forever = false;
  constructor(private listTailPauseMs: number) {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const send = (bytes: Uint8Array, delay: number) => {
      for (let i = 0; i < bytes.length; i += 62) setTimeout(() => controller.enqueue(bytes.slice(i, i + 62)), delay + i / 62);
    };
    this.writable = new WritableStream<Uint8Array>({
      write: (frame) => {
        const tx = toHex(frame);
        this.received.push(tx);
        if (frame[0] !== 20 && frame[0] !== 0) {
          this.e3UntilOtherAddress = false;
          return; // otro número: la balanza no contesta (real: "01 17 16" sin respuesta)
        }
        if (frame[0] === 0) this.e3UntilOtherAddress = false;
        if (frame[0] === 20 && (this.e3Forever || this.e3UntilOtherAddress)) {
          const body = [20, frame[1], 0x45, 0x33];
          send(Uint8Array.from([...body, xorChecksum(body)]), 5);
          return;
        }
        const ex = SESSION_OK_1608.find((x) => x.tx === tx);
        if (!ex || !ex.rx) return; // sin captura real de esa orden: no se inventa respuesta
        const bytes = hexToBytes(ex.rx);
        send(bytes, 5);
        if (ex === LIST) {
          const all = [...bytes, 0x46];
          send(Uint8Array.from([0x46, xorChecksum(all)]), 5 + this.listTailPauseMs);
        }
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
  async setSignals() {}
}

describe("Patagonia contra la balanza real reproducida", () => {
  it("lee la lista entera aunque la balanza haga una pausa larga antes de la 'F' (antes: cortaba a los 60 ms)", async () => {
    const port = new ReplayPort(1500);
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    const client = new SystelClient(link, { address: 20 });
    const list = await client.list();
    await link.close();
    assert.equal(list?.entries.length, 140);
  });

  it("respaldo: firma, ping, configuración y lista reales; frena en el formato de producto porque NO hay captura real de la función 62", async () => {
    const port = new ReplayPort(300);
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    const log: SystelExchangeLog[] = [];
    const client = new SystelClient(link, { address: 20, log, timeoutMs: 300 });
    const b = await takeSystelBackup(client);
    await link.close();
    assert.equal(b.signature?.priceDecimals, 0);
    assert.equal(b.list.length, 140);
    assert.equal(b.layout, null);
    assert.match(b.detail, /no se reconoció el formato/);
    assert.ok(port.received.every((tx) => [2, 23, 31, 39, 62, 3].includes(parseInt(tx.split(" ")[1], 16))), "solo lecturas");
    assert.equal(b.plus.length, 0, "no escribió ni respaldó productos inventados");
  });

  it("HIPÓTESIS E3 'se destraba con la secuencia de las 16:08': con lo guardado repite 1 → 0 → 20 y lee bien", async () => {
    const port = new ReplayPort(100);
    port.e3UntilOtherAddress = true;
    const log: SystelExchangeLog[] = [];
    const found = await discoverSystelLink(port as unknown as SerialPort, log, () => {}, { settings: { baudRate: 115200, stopBits: 1, parity: "none" }, address: 20 }, 350);
    assert.equal(found?.address, 20);
    assert.deepEqual(port.received.slice(0, 2), ["01 17 16", "00 17 17"], "misma secuencia que anduvo");
    const client = new SystelClient(found!.link, { address: 20, log });
    assert.ok(await client.signature());
    await found!.link.close();
  });

  it("si la balanza contesta E3 siempre: pocas órdenes, solo lecturas, nada escrito y un aviso claro", async () => {
    const port = new ReplayPort(100);
    port.e3Forever = true;
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    const client = new SystelClient(link, { address: 20, busyRetryMs: [5, 5, 5, 5, 5] });
    const b = await takeSystelBackup(client);
    await link.close();
    assert.equal(b.complete, false);
    assert.match(b.detail, /E3/);
    assert.ok(port.received.length <= 40, `mandó ${port.received.length} órdenes`);
    assert.ok(port.received.every((tx) => [2, 23].includes(parseInt(tx.split(" ")[1], 16))));
  });
});

describe("registro del cable (para no volver a quedarnos sin datos)", () => {
  it("anota apertura, cada orden y respuesta con sus tiempos, y los bytes que llegan tarde y se descartan", async () => {
    const port = new ReplayPort(300);
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    // Como el código de las 16:08: cortar por 60 ms de silencio, sin esperar la trama completa.
    await link.exchange(hexToBytes(LIST.tx), { timeoutMs: 300 });
    await new Promise((r) => setTimeout(r, 400));
    await link.exchange(hexToBytes("14 17 03"), { timeoutMs: 300 });
    await link.close();
    const kinds = link.events.map((e) => e.kind);
    assert.deepEqual(kinds.slice(0, 3), ["abrir", "tx", "rx"]);
    const late = link.events.find((e) => e.kind === "descartado");
    assert.ok(late, "el cierre que llegó tarde queda anotado");
    assert.match(late!.hex!, /^46 /, "empieza con la F");
    assert.match(link.events.find((e) => e.kind === "rx")!.detail, /primer byte a los \d+ ms/);
  });
});
