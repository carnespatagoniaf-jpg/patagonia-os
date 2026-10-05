import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AURA_BARCODE_CONFIG, auraName, planAuraSync, runAuraSync, summarizeAuraPlan, type AuraSyncProduct } from "./aura-sync";
import { kretzChecksum } from "./kretz-frame";

/** Lo que había en la balanza de la clienta después de la prueba del 2026-10-03c (REAL). */
const SCALE_NOW = [
  "000001FRUTILLA        P0000100010500000005",
  "000002PASTELITOS      N0000200000900000003",
  "000003PAN NEGRO       P0000300004800100001",
  "000006MILA BERENJENA  D0000600052000000000",
  "000008PROMO           C0000800189000000000",
  "000011HAMB POLLO      D0001100108000000000",
  "000096PRUEBA UNIDAD V C0096000003000000003",
  "000097PRUEBA KILO     D0009700260000000002",
  "000098PRUEBA UNIDAD   C0009800015000000000",
  "000099PRUEBA PATAGONIAD0050000012340000000"
];

function reply(group: string, code: string, data = ""): Uint8Array {
  const body = [0x07, ...Array.from("H01" + group + code + data, (c) => c.charCodeAt(0))];
  return new Uint8Array([...body, ...kretzChecksum(body), 0x04]);
}

/** Aura simulada con el comportamiento REAL: guarda tipo y código, y al releer el código vuelve en 5 dígitos + "0". */
class MemoryAura {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  commands: string[] = [];
  mangleOn: number | null = null;
  rejectOn: number | null = null;
  barcodeConfig: string | null = null;
  constructor(public plus: string[]) {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const text = String.fromCharCode(...chunk);
        const command = text.slice(4, 8);
        const data = text.slice(8, -3);
        self.commands.push(command);
        let out: Uint8Array;
        if (command === "0001") out = reply("00", "01");
        else if (command === "5005") {
          const next = [...self.plus].sort().find((r) => Number(r.slice(0, 6)) > Number(data));
          out = next ? reply("05", "01", next) : reply("05", "40");
        } else if (command === "2005") {
          const plu = Number(data.slice(0, 6));
          if (data.length !== 42 || self.rejectOn === plu) out = reply("02", "05");
          else {
            let stored = data.slice(0, 22) + data[28] + data.slice(23, 28) + "0" + data.slice(29);
            if (self.mangleOn === plu) stored = stored.slice(0, 29) + "000001" + stored.slice(35);
            self.plus = self.plus.filter((r) => r.slice(0, 6) !== data.slice(0, 6)).concat(stored);
            out = reply("02", "01");
          }
        } else if (command === "1070") {
          self.barcodeConfig = data;
          out = reply("00", "01");
        } else out = reply("00", "02");
        setTimeout(() => controller.enqueue(out), 2);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}
const responder = { link: { baudRate: 9600, stopBits: 2 as const }, deviceType: "H", equipmentId: "01" };

const PRODUCTS: AuraSyncProduct[] = [
  { code: "1", name: "Frutilla", byWeight: true, price: 9800 }, // mismo nombre, estaba en P (centavos) → D en pesos
  { code: "6", name: "Mila berenjena", byWeight: true, price: 6100 }, // mismo nombre, D → cambia el precio
  { code: "11", name: "Hamb pollo", byWeight: true, price: 10800 }, // mismo precio → sin cambios
  { code: "2", name: "Suprema", byWeight: true, price: 9900 }, // el 2 es PASTELITOS → conflicto
  { code: "97", name: "Pechuga", byWeight: true, price: 8500 }, // producto de prueba nuestro → se reemplaza solo
  { code: "120", name: "Milanesa de pollo", byWeight: true, price: 11800 }, // libre → crear
  { code: "121", name: "Empanadas x12", byWeight: false, price: 14500.5 }, // libre, por unidad, redondea
  { code: "A-7", name: "Sin número", byWeight: true, price: 100 }, // omitir
  { code: "130", name: "Caro", byWeight: true, price: 1_200_000 } // omitir
];

describe("plan de envío a la Aura (D/C en pesos enteros)", () => {
  it("crea, actualiza, deja sin cambios, frena conflictos y omite lo que no entra", () => {
    const plan = planAuraSync(SCALE_NOW, PRODUCTS);
    assert.deepEqual(plan.map((p) => p.action), ["actualizar", "actualizar", "sin_cambios", "conflicto", "reemplazar", "crear", "crear", "omitir", "omitir"]);
    // FRUTILLA: pasa de P (centavos) a D en pesos, conserva código 1 y validez 5 días.
    assert.equal(plan[0].record, "000001FRUTILLA        000001D0098000000005");
    assert.equal(plan[0].expected, "000001FRUTILLA        D0000100098000000005");
    // MILA BERENJENA: solo cambia el precio.
    assert.equal(plan[1].expected, "000006MILA BERENJENA  D0000600061000000000");
    assert.match(plan[6].record!, /^000121EMPANADAS X12   000121C014501/);
    assert.match(plan[3].reason, /PASTELITOS/);
  });

  it("con \"Reemplazar\" tildado, pisa los conflictos", () => {
    const plan = planAuraSync(SCALE_NOW, PRODUCTS, { replaceConflicts: true });
    assert.equal(plan[3].action, "reemplazar");
    assert.equal(summarizeAuraPlan(plan).conflicto, 0);
  });

  it("nombres como los guarda la balanza", () => {
    assert.equal(auraName("Matambre de cerdo relleno"), "MATAMBRE DE CERD");
    assert.equal(auraName("Ñoquis"), "NOQUIS");
  });
});

describe("envío real a la Aura simulada", () => {
  it("manda el plan, cada producto queda exacto y los demás no cambian", async () => {
    const aura = new MemoryAura([...SCALE_NOW]);
    const plan = planAuraSync(SCALE_NOW, PRODUCTS);
    const untouched = ["000002PASTELITOS      N0000200000900000003", "000003PAN NEGRO       P0000300004800100001", "000008PROMO           C0000800189000000000"];
    const r = await runAuraSync(aura as unknown as SerialPort, responder, plan, { timeoutMs: 200 });
    assert.equal(r.verdict, "ok", r.detail);
    assert.equal(r.written.length, 5);
    for (const u of untouched) assert.ok(aura.plus.includes(u), u);
    assert.ok(aura.plus.includes("000120MILANESA DE POLLD001200011800" + "0000000"));
    assert.ok(!aura.commands.includes("3005") && !aura.commands.includes("4005"), "nunca borra");
    // Volver a planificar después del envío: no queda nada por mandar (se puede retomar sin repetir).
    const again = planAuraSync(aura.plus, PRODUCTS);
    assert.equal(again.filter((p) => p.record).length, 0);
  });

  it("con el ajuste pedido, al final manda SOLO el formato de código de barras 2-3-7 con importe", async () => {
    const aura = new MemoryAura([...SCALE_NOW]);
    const r = await runAuraSync(aura as unknown as SerialPort, responder, planAuraSync(SCALE_NOW, PRODUCTS), { timeoutMs: 200, configureBarcode: true });
    assert.equal(r.verdict, "ok", r.detail);
    assert.equal(r.barcode, "ok");
    assert.equal(aura.barcodeConfig, "2002005");
    assert.equal(AURA_BARCODE_CONFIG, "2002005");
    assert.equal(aura.commands.filter((c) => c === "1070").length, 1);
    assert.deepEqual([...new Set(aura.commands)].sort(), ["0001", "1070", "2005", "5005"]);
  });

  it("si no hay productos para mandar, igual ajusta el código de barras (caso de la clienta hoy) sin grabar productos", async () => {
    const aura = new MemoryAura([...SCALE_NOW]);
    const same = [{ code: "11", name: "Hamb pollo", byWeight: true, price: 10800 }];
    const r = await runAuraSync(aura as unknown as SerialPort, responder, planAuraSync(SCALE_NOW, same), { timeoutMs: 200, configureBarcode: true });
    assert.equal(r.verdict, "ok", r.detail);
    assert.equal(r.barcode, "ok");
    assert.ok(!aura.commands.includes("2005"));
  });

  it("sin el ajuste pedido no manda el formato", async () => {
    const aura = new MemoryAura([...SCALE_NOW]);
    const r = await runAuraSync(aura as unknown as SerialPort, responder, planAuraSync(SCALE_NOW, PRODUCTS), { timeoutMs: 200 });
    assert.equal(r.barcode, "no_enviado");
    assert.ok(!aura.commands.includes("1070"));
  });

  it("si un producto no queda como se mandó, frena ahí (y no toca el código de barras)", async () => {
    const aura = new MemoryAura([...SCALE_NOW]);
    aura.mangleOn = 120;
    const r = await runAuraSync(aura as unknown as SerialPort, responder, planAuraSync(SCALE_NOW, PRODUCTS), { timeoutMs: 200, configureBarcode: true });
    assert.equal(r.verdict, "diferencia");
    assert.equal(r.barcode, "no_enviado");
    assert.equal(r.stoppedAt?.plu, 120);
    assert.ok(!aura.plus.some((x) => x.startsWith("000121")), "no siguió con el siguiente");
  });

  it("si la balanza cambió desde que se armó el envío, no manda nada", async () => {
    const aura = new MemoryAura([...SCALE_NOW, "000120OTRO PRODUCTO   D0012000001000000000"]);
    const r = await runAuraSync(aura as unknown as SerialPort, responder, planAuraSync(SCALE_NOW, PRODUCTS), { timeoutMs: 200 });
    assert.equal(r.verdict, "cambio_la_balanza");
    assert.ok(!aura.commands.includes("2005"));
  });

  it("si la balanza rechaza un producto, frena y lo informa", async () => {
    const aura = new MemoryAura([...SCALE_NOW]);
    aura.rejectOn = 6;
    const r = await runAuraSync(aura as unknown as SerialPort, responder, planAuraSync(SCALE_NOW, PRODUCTS), { timeoutMs: 200 });
    assert.equal(r.verdict, "rechazada");
    assert.equal(r.written.length, 1);
  });
});
