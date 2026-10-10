import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SystelExchangeOptions, SystelLink } from "./systel-client";
import { FakeCuora, fakeReadRecord } from "./systel-fake";
import { toHex, xorChecksum } from "./systel-frame";
import { runCreateLab, runPriceChangeLab, verifyCreateRestored } from "./systel-lab";
import { hexToBytes, SESSION_OK_1608 } from "./systel-real-captures";

/**
 * Herramienta de laboratorio. Todas usan el simulador hecho con el documento ([SINTÉTICO]) salvo la que
 * dice [REAL]. Prueban que la HERRAMIENTA registra y se detiene donde debe; no validan una balanza real.
 */

function fake(layout: "max60" | "cuora2" = "max60", options: ConstructorParameters<typeof FakeCuora>[1] = {}) {
  const f = new FakeCuora(layout, { address: 20, ...options });
  f.plus.set(1, fakeReadRecord(layout, { number: 1, name: "NALGA", price: 18500, code: 1, type: "P" }));
  f.plus.set(2, fakeReadRecord(layout, { number: 2, name: "HAMBURGUESA X4", price: 4200, code: 2, type: "U" }));
  f.plus.set(7999, fakeReadRecord(layout, { number: 7999, name: "PRUEBA LAB", price: 1000, code: 7999, type: "P" }));
  return f;
}

/** Envuelve un enlace y modifica lo que contesta (para simular control roto, formato raro, etc.). */
class Tamper implements SystelLink {
  calls = 0;
  constructor(private inner: SystelLink, private edit: (frame: Uint8Array, reply: Uint8Array | null, n: number) => Uint8Array | null) {}
  async exchange(frame: Uint8Array, o: SystelExchangeOptions) {
    this.calls += 1;
    return this.edit(frame, await this.inner.exchange(frame, o), this.calls);
  }
}

const fns = (f: FakeCuora) => f.received.map((r) => r.fn);
const WRITE_FNS = [4, 33, 61];
const yes = async () => true;

describe("[SINTÉTICO] laboratorio: cambio de precio", () => {
  it("lee, guarda el estado inicial, cambia solo el precio, relee, restaura y queda igual; registra cada paso", async () => {
    const f = fake();
    const r = await runPriceChangeLab(f, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA LAB", newPriceRaw: 1001, confirm: yes });
    assert.equal(r.outcome, "aprobado", JSON.stringify(r.steps.filter((s) => !s.ok)));
    assert.equal(r.protocol.layout, "max60");
    assert.equal(r.protocol.readFn, 62);
    assert.equal(r.afterWrite?.prices[0], 1001);
    assert.equal(r.afterRestore?.prices[0], 1000);
    assert.equal(f.plus.get(2), fakeReadRecord("max60", { number: 2, name: "HAMBURGUESA X4", price: 4200, code: 2, type: "U" }), "el otro producto no se tocó");
    assert.ok(r.steps.every((s) => s.ms >= 0 && Array.isArray(s.commands)));
    assert.ok(r.steps.find((s) => s.name.startsWith("cambiar SOLO"))!.commands.some((c) => c.fn === 33 && c.tx.length > 0 && c.rx.length > 0));
    assert.equal(fns(f).filter((x) => x === 33).length, 2, "un cambio y una restauración");
    assert.ok(!fns(f).some((x) => x === 61 || x === 4), "no da de alta nada");
  });

  it("se detiene ANTES de escribir si una respuesta no pasa el control", async () => {
    const f = fake();
    const link = new Tamper(f, (frame, rep) => (frame[1] === 62 && rep ? Uint8Array.from([...rep.subarray(0, -1), rep.at(-1)! ^ 0xff]) : rep));
    const r = await runPriceChangeLab(link, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA LAB", newPriceRaw: 1001, confirm: yes });
    assert.equal(r.outcome, "detenido_antes_de_escribir");
    assert.ok(!fns(f).some((x) => WRITE_FNS.includes(x)));
  });

  it("se detiene ANTES de escribir si el formato del producto no encaja con ninguno documentado", async () => {
    const f = fake();
    const link = new Tamper(f, (frame, rep) => {
      if (frame[1] !== 62 || !rep) return rep;
      const body = [...rep.subarray(0, -6)]; // 5 caracteres menos: largo que no es de ningún formato
      return Uint8Array.from([...body, xorChecksum(body)]);
    });
    const r = await runPriceChangeLab(link, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA LAB", newPriceRaw: 1001, confirm: yes });
    assert.equal(r.outcome, "detenido_antes_de_escribir");
    assert.match(r.steps.at(-1)!.detail, /ambiguo o no reconocido/);
    assert.ok(!fns(f).some((x) => WRITE_FNS.includes(x)));
  });

  it("se detiene si dos lecturas del mismo producto no coinciden", async () => {
    const f = fake();
    let reads = 0;
    const link = new Tamper(f, (frame, rep) => {
      if (frame[1] !== 62 || !rep) return rep;
      reads += 1;
      if (reads < 2) return rep;
      const body = [...rep.subarray(0, -1)];
      body[8] = body[8] === 0x41 ? 0x42 : 0x41; // una letra del nombre distinta
      return Uint8Array.from([...body, xorChecksum(body)]);
    });
    const r = await runPriceChangeLab(link, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA LAB", newPriceRaw: 1001, confirm: yes });
    assert.equal(r.outcome, "detenido_antes_de_escribir");
    assert.match(r.steps.at(-1)!.detail, /no coinciden/);
  });

  it("si la persona no confirma, no escribe", async () => {
    const f = fake();
    const r = await runPriceChangeLab(f, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA LAB", newPriceRaw: 1001, confirm: async () => false });
    assert.equal(r.outcome, "cancelado");
    assert.ok(!fns(f).some((x) => WRITE_FNS.includes(x)));
  });

  it("si la balanza no aplica el precio, lo informa y verifica que quedó como al principio", async () => {
    const f = fake();
    f.ignorePriceChange = true;
    const r = await runPriceChangeLab(f, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA LAB", newPriceRaw: 1001, confirm: yes });
    assert.equal(r.outcome, "fallo_al_escribir");
    assert.equal(r.afterRestore?.prices[0], 1000);
  });
});

describe("[SINTÉTICO] laboratorio: solo productos destinados a pruebas", () => {
  it("cambio de precio: un producto real del negocio (aunque exista y se lea bien) NO se toca", async () => {
    const f = fake();
    const r = await runPriceChangeLab(f, { lab: true, address: 20, plu: 1, expectedName: "NALGA", newPriceRaw: 18501, confirm: yes });
    assert.equal(r.outcome, "detenido_antes_de_escribir");
    assert.match(r.steps.at(-1)!.detail, /empezar con PRUEBA/);
    assert.ok(!fns(f).some((x) => WRITE_FNS.includes(x)));
  });

  it("cambio de precio: si el nombre en la balanza no es el que escribió la persona, no se toca", async () => {
    const f = fake();
    const r = await runPriceChangeLab(f, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA OTRO", newPriceRaw: 1001, confirm: yes });
    assert.equal(r.outcome, "detenido_antes_de_escribir");
    assert.ok(!fns(f).some((x) => WRITE_FNS.includes(x)));
  });

  it("alta: el 7998 no se da por libre; se comprueba con lectura directa (E7) y el nombre tiene que ser PRUEBA…", async () => {
    const f = fake();
    const bad = await runCreateLab(f, { lab: true, address: 20, plu: 7998, name: "POLLO", priceRaw: 1, saleType: "P", variant: "con", confirm: yes });
    assert.equal(bad.outcome, "detenido_antes_de_escribir");
    const ok = await runCreateLab(f, { lab: true, address: 20, plu: 7998, name: "PRUEBA ALTA", priceRaw: 1, saleType: "P", variant: "con", confirm: yes });
    assert.ok(ok.steps.some((s) => s.name.startsWith("comprobar que el PLU 7998 está libre") && s.ok && /E7/.test(s.detail)));
  });

  it("alta: si la lectura directa no contesta E7 (por ejemplo, sin respuesta), no se escribe aunque falte en la lista", async () => {
    const f = fake();
    let reads = 0;
    const link = new Tamper(f, (frame, rep) => (frame[1] === 62 && frame.length > 3 && String.fromCharCode(...frame.subarray(2, 6)) === "7998" && ++reads ? null : rep));
    const r = await runCreateLab(link, { lab: true, address: 20, plu: 7998, name: "PRUEBA ALTA", priceRaw: 1, saleType: "P", variant: "con", confirm: yes });
    assert.equal(r.outcome, "detenido_antes_de_escribir");
    assert.ok(!fns(f).some((x) => WRITE_FNS.includes(x)));
  });
});

describe("[SINTÉTICO] laboratorio: escritura sin confirmación", () => {
  it("si no llega el ACK del cambio de precio: resultado INDETERMINADO, relee antes de restaurar y deja el estado inicial", async () => {
    const f = fake();
    const link = new Tamper(f, (frame, rep) => (frame[1] === 33 ? null : rep));
    const r = await runPriceChangeLab(link, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA LAB", newPriceRaw: 1001, confirm: yes });
    assert.equal(r.outcome, "indeterminado", JSON.stringify(r.steps.map((s) => [s.name, s.ok, s.detail])));
    const change = r.steps.find((s) => s.name.startsWith("cambiar SOLO"))!;
    assert.match(change.detail, /^indeterminado/);
    const restore = r.steps.find((s) => s.name.startsWith("restaurar"))!;
    assert.equal(restore.commands[0].fn, 62, "lo primero al restaurar es releer");
    assert.equal(r.afterRestore?.prices[0], 1000);
  });
});

describe("[REAL] laboratorio con los bytes de Los gringos", () => {
  it("la lista real sin cierre: se detiene en 'lista completa' y no manda ninguna escritura", async () => {
    const sent: number[] = [];
    const link: SystelLink = {
      async exchange(frame) {
        sent.push(frame[1]);
        const ex = SESSION_OK_1608.find((x) => x.tx === toHex(frame));
        return ex?.rx ? hexToBytes(ex.rx) : null;
      }
    };
    const r = await runPriceChangeLab(link, { lab: true, address: 20, plu: 7999, expectedName: "PRUEBA LAB", newPriceRaw: 1, confirm: yes });
    assert.equal(r.outcome, "detenido_antes_de_escribir");
    assert.equal(r.steps.at(-1)!.name, "lista completa (31)");
    assert.equal(r.protocol.signature?.protocolVersion, "0060");
    assert.ok(!sent.some((x) => WRITE_FNS.includes(x)));
  });
});

describe("[SINTÉTICO] laboratorio: alta (separada del cambio de precio)", () => {
  it("con control (la forma justificada): crea en un número libre, relee igual y pide borrarlo a mano", async () => {
    const f = fake("max60", { writeChecksum: true });
    const r = await runCreateLab(f, { lab: true, address: 20, plu: 7998, name: "PRUEBA ALTA", priceRaw: 100, saleType: "P", variant: "con", confirm: yes });
    assert.equal(r.outcome, "restaurar_a_mano", JSON.stringify(r.steps.filter((s) => !s.ok)));
    assert.match(r.manualAction!, /Borrar a mano el PLU 7998/);
    assert.ok(!fns(f).includes(33), "el alta no cambia precios");
    f.plus.delete(7998); // la persona lo borra desde el menú
    assert.equal((await verifyCreateRestored(f, r)).ok, true);
  });

  it("si la balanza rechaza el largo (E5) se detiene con UN solo intento; no prueba sola la otra forma", async () => {
    const f = fake("max60", { writeChecksum: false });
    const r = await runCreateLab(f, { lab: true, address: 20, plu: 7998, name: "PRUEBA ALTA", priceRaw: 100, saleType: "P", variant: "con", confirm: yes });
    assert.equal(r.outcome, "fallo_al_escribir");
    assert.equal(fns(f).filter((x) => x === 61).length, 1);
    assert.equal(f.plus.has(7998), false);
  });

  it("la variante sin control es otra corrida, elegida a propósito", async () => {
    const f = fake("max60", { writeChecksum: false });
    const r = await runCreateLab(f, { lab: true, address: 20, plu: 7998, name: "PRUEBA ALTA", priceRaw: 100, saleType: "P", variant: "sin_experimental", confirm: yes });
    assert.equal(r.variant, "sin_experimental");
    assert.equal(r.outcome, "restaurar_a_mano");
  });

  it("no da de alta sobre un número que ya existe", async () => {
    const f = fake();
    const r = await runCreateLab(f, { lab: true, address: 20, plu: 2, name: "X", priceRaw: 1, saleType: "U", variant: "con", confirm: yes });
    assert.equal(r.outcome, "detenido_antes_de_escribir");
    assert.ok(!fns(f).some((x) => WRITE_FNS.includes(x)));
  });
});
