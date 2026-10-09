import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takeSystelBackup } from "./systel-backup";
import { replyIsComplete, SystelClient, type SystelExchangeLog } from "./systel-client";
import { discoverSystelLink } from "./systel-discovery";
import { findSystelReply, parseSystelReply, toHex, xorChecksum } from "./systel-frame";
import { parseConfig, parsePing, parsePluList, parseSignature } from "./systel-plu";
import { E3_PING, E3_SIGNATURE, hexToBytes, SESSION_OK_1608 } from "./systel-real-captures";
import { SerialSystelLink } from "./systel-serial";

/**
 * Dos grupos, separados a propósito:
 * - [REAL]: solo bytes que mandó la Cuora Max de Los gringos (systel-real-captures.ts, huella md5
 *   igual a la de la base). Partirlos, demorarlos o mezclarlos prueba cómo Patagonia los recibe,
 *   sin agregar nada que la balanza no haya mandado.
 * - [SINTÉTICO]: agrega algo que NO vimos (la "F" final de la lista, un E3 que se destraba). Prueba
 *   el código de Patagonia; NO demuestra cómo responde la balanza.
 */

const real = (tx: string) => SESSION_OK_1608.find((x) => x.tx === tx)!;
const LIST = real("14 1f 0b");
const CONFIG = real("14 27 33");
const PING = real("14 17 03");

/** Puerto que entrega exactamente los trozos indicados, con las demoras indicadas, ante cada orden. */
class ScriptPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  received: string[] = [];
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  constructor(private script: (tx: string, send: (bytes: Uint8Array, atMs: number) => void) => void) {}
  async open() {
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { this.controller = c; } });
    this.writable = new WritableStream<Uint8Array>({
      write: (frame) => {
        const tx = toHex(frame);
        this.received.push(tx);
        this.script(tx, (bytes, atMs) => setTimeout(() => this.controller.enqueue(bytes), atMs));
      }
    });
  }
  /** Bytes que llegan sin que se haya pedido nada (por ejemplo, el final atrasado de otra respuesta). */
  push(bytes: Uint8Array) {
    this.controller.enqueue(bytes);
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
  async setSignals() {}
}

async function withLink(port: ScriptPort, fn: (link: SerialSystelLink) => Promise<void>) {
  const link = new SerialSystelLink(port as unknown as SerialPort);
  await link.connect();
  try {
    await fn(link);
  } finally {
    await link.close();
  }
}

describe("[REAL] respuestas de la balanza de Los gringos", () => {
  it("firma, ping, ping general y configuración: completas y con la verificación bien", () => {
    for (const x of SESSION_OK_1608.filter((e) => e.rx && e.tx !== LIST.tx)) {
      const r = parseSystelReply(hexToBytes(x.rx));
      assert.ok(r?.checksumOk, `verificación de la respuesta a ${x.tx}`);
      assert.equal(r!.address, 20);
    }
  });

  it("la firma: protocolo 0060, 8.000 PLU, precio sin decimales", () => {
    const sig = parseSignature(parseSystelReply(hexToBytes(real("14 02 16").rx))!.data);
    assert.deepEqual(sig, { productType: "2000", capacityGrams: 30000, protocolVersion: "0060", pluCapacity: 8000, shortcuts: 60, priceDecimals: 0 });
  });

  it("ping 'D' y configuración con coma de precio 0 y sin espera de sincronización", () => {
    assert.deepEqual(parsePing(parseSystelReply(hexToBytes(PING.rx))!.data), { state: "D" });
    const cfg = parseConfig(parseSystelReply(hexToBytes(CONFIG.rx))!.data);
    assert.equal(cfg.CPr, "0");
    assert.equal(cfg.Sinc, "0");
  });

  it("E3: tramas bien formadas, verificación bien, misma orden que a las 16:08 tuvo respuesta", () => {
    for (const x of [E3_PING, E3_SIGNATURE]) {
      const r = parseSystelReply(hexToBytes(x.rx))!;
      assert.ok(r.checksumOk);
      assert.equal(r.errorCode, "E3");
      assert.ok(SESSION_OK_1608.some((e) => e.tx === x.tx && e.rx.length > 0));
    }
  });

  it("la lista llegó sin cierre: 140 PLU enteros, sin 'F' ni verificación; Patagonia no la acepta", () => {
    const bytes = hexToBytes(LIST.rx);
    assert.equal(bytes.length, 982);
    const body = String.fromCharCode(...bytes.subarray(2));
    assert.equal(body.length % 7, 0, "cortada justo al final de un PLU");
    assert.equal(findSystelReply(bytes, 20, 31), null);
    assert.equal(parsePluList(body), null);
  });

  it("la configuración partida en dos en CUALQUIER byte, con 30 ms entre trozos, se arma igual", async () => {
    const bytes = hexToBytes(CONFIG.rx);
    for (const cut of [1, 2, 3, 50, 121, 240, 241]) {
      const port = new ScriptPort((tx, send) => {
        if (tx === CONFIG.tx) {
          send(bytes.slice(0, cut), 2);
          send(bytes.slice(cut), 32);
        }
      });
      await withLink(port, async (link) => {
        const rx = await link.exchange(hexToBytes(CONFIG.tx), { timeoutMs: 300, isComplete: replyIsComplete });
        assert.equal(toHex(rx!), CONFIG.rx, `corte en el byte ${cut}`);
      });
    }
  });

  it("la configuración con una pausa de 200 ms en el medio (más que los 60 ms de silencio): no se corta", async () => {
    const bytes = hexToBytes(CONFIG.rx);
    const port = new ScriptPort((tx, send) => {
      if (tx === CONFIG.tx) {
        send(bytes.slice(0, 100), 2);
        send(bytes.slice(100), 202);
      }
    });
    await withLink(port, async (link) => {
      const client = new SystelClient(link, { address: 20 });
      const cfg = await client.config();
      assert.equal(cfg?.raw, parseSystelReply(bytes)!.data);
      assert.match(link.events.filter((e) => e.kind === "rx").at(-1)!.detail, /1 pausas/);
    });
  });

  it("la lista real SIN cierre, en paquetes USB de 62 bytes: queda 'incompleta' (no se inventa el final)", async () => {
    const bytes = hexToBytes(LIST.rx);
    const port = new ScriptPort((tx, send) => {
      if (tx === LIST.tx) for (let i = 0; i < bytes.length; i += 62) send(bytes.slice(i, i + 62), 2 + i / 62);
    });
    await withLink(port, async (link) => {
      const rx = await link.exchange(hexToBytes(LIST.tx), { timeoutMs: 300, isComplete: (b) => findSystelReply(b, 20, 31) !== null });
      assert.equal(rx!.length, 982);
      assert.equal(findSystelReply(rx!, 20, 31), null);
      assert.match(link.events.filter((e) => e.kind === "rx").at(-1)!.detail, /incompleta/);
    });
  });

  it("datos pendientes: el final atrasado de otra respuesta llega antes de la orden; se anota y no se confunde", async () => {
    const port = new ScriptPort((tx, send) => {
      if (tx === PING.tx) send(hexToBytes(PING.rx), 5);
    });
    await withLink(port, async (link) => {
      port.push(hexToBytes(LIST.rx).slice(-40)); // 40 bytes reales de la lista, fuera de tiempo
      await new Promise((r) => setTimeout(r, 30));
      const client = new SystelClient(link, { address: 20 });
      assert.deepEqual(await client.ping(), { state: "D" });
      const discarded = link.events.find((e) => e.kind === "descartado");
      assert.ok(discarded && /40 bytes/.test(discarded.detail));
    });
  });

  it("datos pendientes mezclados: restos reales pegados ADELANTE de la respuesta en el mismo trozo; se encuentra la trama buena", async () => {
    const tail = hexToBytes(LIST.rx).slice(-13);
    const port = new ScriptPort((tx, send) => {
      if (tx === PING.tx) send(Uint8Array.from([...tail, ...hexToBytes(PING.rx)]), 5);
    });
    await withLink(port, async (link) => {
      const client = new SystelClient(link, { address: 20 });
      assert.deepEqual(await client.ping(), { state: "D" });
    });
  });

  it("E3 real persistente: pocas órdenes, solo pings y firma, nada escrito y aviso con el código", async () => {
    const port = new ScriptPort((tx, send) => {
      if (tx === E3_PING.tx) send(hexToBytes(E3_PING.rx), 5);
      if (tx === E3_SIGNATURE.tx) send(hexToBytes(E3_SIGNATURE.rx), 5);
    });
    await withLink(port, async (link) => {
      const client = new SystelClient(link, { address: 20, busyRetryMs: [5, 5, 5, 5, 5] });
      const b = await takeSystelBackup(client);
      assert.equal(b.complete, false);
      assert.match(b.detail, /E3/);
      assert.ok(port.received.length <= 40, `mandó ${port.received.length} órdenes`);
      assert.ok(port.received.every((tx) => [2, 23].includes(parseInt(tx.split(" ")[1], 16))));
    });
  });

  it("respaldo con lo real: firma, ping, configuración; sin cierre real de la lista se frena ahí y no lee productos", async () => {
    const port = new ScriptPort((tx, send) => {
      const ex = SESSION_OK_1608.find((x) => x.tx === tx);
      if (ex?.rx) send(hexToBytes(ex.rx), 5);
    });
    await withLink(port, async (link) => {
      const client = new SystelClient(link, { address: 20, timeoutMs: 300 });
      const b = await takeSystelBackup(client);
      assert.equal(b.signature?.priceDecimals, 0);
      assert.match(b.detail, /lista de productos/);
      assert.equal(b.plus.length, 0);
      assert.ok(!port.received.some((tx) => tx.split(" ")[1] === "3e"), "no pidió productos (62)");
    });
  });
});

describe("[SINTÉTICO] código de Patagonia ante cosas que NO vimos en la balanza", () => {
  /** La "F" y su XOR NO se capturaron: se agregan para probar que el código espera el cierre. */
  const syntheticClose = () => {
    const bytes = hexToBytes(LIST.rx);
    return Uint8Array.from([0x46, xorChecksum([...bytes, 0x46])]);
  };

  it("con un cierre agregado después de 1,5 s, la lista se lee entera (140 PLU)", async () => {
    const bytes = hexToBytes(LIST.rx);
    const port = new ScriptPort((tx, send) => {
      if (tx === LIST.tx) {
        send(bytes, 5);
        send(syntheticClose(), 1505);
      }
    });
    await withLink(port, async (link) => {
      const list = await new SystelClient(link, { address: 20 }).list();
      assert.equal(list?.entries.length, 140);
      assert.equal(list?.digits, 4);
    });
  });

  it("si el cierre llega TARDE (después de que se dejó de esperar), queda anotado como descartado con su F", async () => {
    const bytes = hexToBytes(LIST.rx);
    const port = new ScriptPort((tx, send) => {
      if (tx === LIST.tx) {
        send(bytes, 5);
        send(syntheticClose(), 300);
      }
      if (tx === PING.tx) send(hexToBytes(PING.rx), 5);
    });
    await withLink(port, async (link) => {
      await link.exchange(hexToBytes(LIST.tx), { timeoutMs: 100 }); // como el código de las 16:08
      await new Promise((r) => setTimeout(r, 400));
      await link.exchange(hexToBytes(PING.tx), { timeoutMs: 300 });
      const late = link.events.find((e) => e.kind === "descartado");
      assert.match(late!.hex!, /^46 /);
    });
  });

  it("HIPÓTESIS: E3 que se destraba al recibir una orden a otro número; con lo guardado se repite 1 → 0 → 20", async () => {
    let latched = true;
    const port = new ScriptPort((tx, send) => {
      const b = hexToBytes(tx);
      if (b[0] !== 20) latched = false;
      if (b[0] === 1) return;
      if (latched && b[0] === 20) {
        const body = [20, b[1], 0x45, 0x33];
        send(Uint8Array.from([...body, xorChecksum(body)]), 5);
        return;
      }
      const ex = SESSION_OK_1608.find((x) => x.tx === tx);
      if (ex?.rx) send(hexToBytes(ex.rx), 5);
    });
    const log: SystelExchangeLog[] = [];
    const found = await discoverSystelLink(port as unknown as SerialPort, log, () => {}, { settings: { baudRate: 115200, stopBits: 1, parity: "none" }, address: 20 }, 350);
    assert.equal(found?.address, 20);
    assert.deepEqual(port.received.slice(0, 2), ["01 17 16", "00 17 17"]);
    assert.ok(await new SystelClient(found!.link, { address: 20, log }).signature());
    await found!.link.close();
  });

  it("puerto tomado por otra pantalla: se informa así, no como 'la balanza no contestó'", async () => {
    const busy = { open: async () => { throw new Error("Failed to execute 'open' on 'SerialPort': The port is already open."); }, getInfo: () => ({}) };
    await assert.rejects(discoverSystelLink(busy as unknown as SerialPort, []), /abierto en otra pantalla/);
  });
});
