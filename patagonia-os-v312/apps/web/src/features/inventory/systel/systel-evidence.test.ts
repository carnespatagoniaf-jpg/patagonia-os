import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takeSystelBackup } from "./systel-backup";
import { SystelClient, type SystelExchangeLog } from "./systel-client";
import { discoverSystelLink } from "./systel-discovery";
import { buildSystelFrame, findSystelReply, toHex, xorChecksum as xorOf } from "./systel-frame";
import { SYSTEL_VERIFIED_WRITE_PROFILES, systelWriteVerified } from "./systel-models";
import { hexToBytes, SESSION_OK_1608 } from "./systel-real-captures";
import { SerialSystelLink } from "./systel-serial";

/** Puerto que contesta con los bytes REALES de las 16:08 y anota cada orden con su momento (ms desde abrir). */
class TimedReplay {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  sent: { tx: string; t: number }[] = [];
  opens = 0;
  private t0 = 0;
  async open() {
    this.opens += 1;
    this.t0 = Date.now();
    let c!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (x) => { c = x; } });
    this.writable = new WritableStream<Uint8Array>({
      write: (frame) => {
        const tx = toHex(frame);
        this.sent.push({ tx, t: Date.now() - this.t0 });
        const ex = SESSION_OK_1608.find((x) => x.tx === tx);
        if (ex?.rx) setTimeout(() => c.enqueue(hexToBytes(ex.rx)), 15);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
  async setSignals() {}
}

/** Orden real de las 16:08 (tx), tal como está en el reporte. */
const ORDER_1608 = SESSION_OK_1608.map((x) => x.tx);

describe("[REAL] secuencia del código final contra la de las 16:08", () => {
  for (const saved of [false, true]) {
    it(`${saved ? "con" : "sin"} número guardado: mismas órdenes y en el mismo orden que las 16:08 hasta la lista`, async () => {
      const port = new TimedReplay();
      const log: SystelExchangeLog[] = [];
      const preferred = saved ? { settings: { baudRate: 115200, stopBits: 1 as const, parity: "none" as const }, address: 20 } : null;
      const found = await discoverSystelLink(port as unknown as SerialPort, log, () => {}, preferred, 350);
      assert.equal(found?.address, 20);
      const client = new SystelClient(found!.link, { address: 20, log, timeoutMs: 300 });
      await takeSystelBackup(client);
      await found!.link.close();
      const order = port.sent.map((s) => s.tx);
      assert.deepEqual(order.slice(0, ORDER_1608.length), ORDER_1608, "1 → 0 → firma → ping → configuración → lista");
      assert.equal(port.opens, 1, "un solo abrir de puerto");
      // El 0 sale cuando vence la espera del 1 (350 ms), como a las 16:08 (356 ms).
      assert.ok(port.sent[1].t >= 340 && port.sent[1].t < 500, `ping general a los ${port.sent[1].t} ms`);
    });
  }
});

/**
 * Programa de ejemplo oficial (zip "Protocolo Cuora 2 y Cuora MAX", Form1.vb, Button3_Click):
 *   CRC = Text_IP Xor Text_Funcion; por cada carácter de PARAMETROS: CRC = CRC Xor ASCII(carácter)
 *   TramaTX = ChrW(IP) & ChrW(Funcion) & PARAMETROS & ChrW(CRC); SerialPort1.Write(TramaTX)
 * SerialPort.Write(string) usa ASCIIEncoding (valor por defecto de .NET): todo carácter > 127 sale como "?" (0x3F).
 */
function officialVbFrame(ip: number, fn: number, params: string): Uint8Array {
  let crc = ip ^ fn;
  for (const ch of params) crc ^= ch.charCodeAt(0) > 127 ? 0x3f : ch.charCodeAt(0);
  const chars = [ip, fn, ...Array.from(params, (c) => c.charCodeAt(0)), crc];
  return Uint8Array.from(chars.map((c) => (c > 127 ? 0x3f : c)));
}

describe("[DOCUMENTO] el programa de ejemplo oficial arma las mismas tramas que Patagonia", () => {
  // Los botones del ejemplo: 1 peso, 23 ping, 6 marquesina, 3 leer PLU "0001", 4 alta (Cuora 2), 5 borrar, 26 apagar.
  const SAMPLE_4 = "00012Activia Bebible Fr00050000050000001050000U000000SSOtros datos del PLU, esta leyenda puede ser de hasta 100 caracteres                                 ";
  const cases: [string, number, string][] = [
    ["peso (1)", 1, ""],
    ["ping (23)", 23, ""],
    ["leer PLU (3)", 3, "0001"],
    ["alta Cuora 2 (4), dato del ejemplo", 4, SAMPLE_4],
    ["marquesina (6)", 6, "Esta es la marquesina de ejemplo"],
    // Las que el ejemplo NO trae (31, 33, 39, 62, 61) siguen la misma regla del documento:
    ["lista (31)", 31, ""],
    ["cambio de precio (33)", 33, "000110000000000000"],
    ["leer PLU extendido (62)", 62, "0001"]
  ];
  for (const [name, fn, params] of cases) {
    it(`${name}: bytes idénticos con dirección 20`, () => {
      assert.equal(toHex(buildSystelFrame(20, fn, params)), toHex(officialVbFrame(20, fn, params)));
    });
  }

  it("ping y firma del ejemplo = lo que Patagonia mandó a la balanza real (14 17 03, 14 02 16)", () => {
    assert.equal(toHex(officialVbFrame(20, 23, "")), "14 17 03");
    assert.equal(toHex(officialVbFrame(20, 2, "")), "14 02 16");
  });

  it("con dirección ≤ 99, función < 128 y datos ASCII, el byte de control es siempre < 0x80 (el envío como texto del ejemplo es seguro)", () => {
    for (const fn of [1, 2, 3, 4, 23, 31, 33, 39, 61, 62]) for (let a = 0; a <= 99; a++) assert.ok(buildSystelFrame(a, fn, "Zz~09 ").at(-1)! < 0x80);
  });
});

describe("guardas de recepción", () => {
  const CONFIG = SESSION_OK_1608.find((x) => x.tx === "14 27 33")!;

  it("[REAL] un byte cambiado en la configuración real: la verificación falla y se rechaza", () => {
    const bytes = hexToBytes(CONFIG.rx);
    bytes[50] ^= 0x01;
    assert.equal(findSystelReply(bytes, 20, 0x27), null);
  });

  it("[REAL] una respuesta completa VIEJA de la misma orden delante de la nueva: juntas verifican por XOR, igual se toma la última", () => {
    const ping = hexToBytes("14 17 30 30 44 47"); // real
    const e3 = hexToBytes("14 17 45 33 75"); // real (16:40)
    const both = Uint8Array.from([...e3, ...ping]);
    assert.equal(xorOf(both.subarray(0, -1)), both.at(-1), "las dos juntas pasan el control: el XOR solo no alcanza");
    const r = findSystelReply(both, 20, 23);
    assert.equal(r?.data, "00D");
  });

  it("[SINTÉTICO] dos órdenes a la vez sobre la misma conexión: salen de a una y cada una recibe su respuesta", async () => {
    const port = new TimedReplay();
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    const client = new SystelClient(link, { address: 20 });
    const [sig, ping] = await Promise.all([client.signature(), client.ping()]);
    await link.close();
    assert.equal(sig?.protocolVersion, "0060");
    assert.deepEqual(ping, { state: "D" });
    assert.ok(port.sent[1].t - port.sent[0].t >= 60, "la segunda salió después de terminar la primera");
  });

  it("escritura: ningún perfil validado; S0060 con cualquier formato de 4 dígitos queda bloqueado", () => {
    assert.equal(SYSTEL_VERIFIED_WRITE_PROFILES.length, 0);
    for (const op of ["precio", "alta"] as const) {
      for (const layout of ["cuora2", "max60", "max62", "max7"]) assert.equal(systelWriteVerified(op, "0060", layout), false);
      assert.equal(systelWriteVerified(op, null, "max60"), false);
    }
  });
});
