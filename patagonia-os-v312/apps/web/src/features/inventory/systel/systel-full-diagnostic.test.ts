import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Product } from "@patagonia/domain";
import { SYSTEL_READ_FUNCTIONS, SystelClient } from "./systel-client";
import { FakeCuora, fakeReadRecord, fakeSaleLine } from "./systel-fake";
import { labelFor, runSystelDiagnostic, salesRequestVariants } from "./systel-full-diagnostic";

const product = (code: string, name: string, unit: "kg" | "unit", priceRetail: number) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, cost: 0, stock: 0, minStock: 0, active: true }) as unknown as Product;
// Los 4 productos con precio de Los gringos (13/10) + uno sin precio.
const GRINGOS = [product("10", "PECHUGAC/H x1x5", "kg", 6480), product("5", "TROZADITOx1x2", "kg", 5200), product("2", "GRINGO CAJON DE POLLO", "unit", 72000), product("13", "PECHUGA S/H x1x3", "kg", 9000), product("17", "ALITAS", "kg", 0)];
// Configuración REAL leída de la balanza el 13/10 a las 20:42 (función 39).
const REAL_CONFIG_1310 = "Ton=2;Gris=0;Pap=0;APa=0;Vel=5;CPr=0;CAdm=01234;CCon=01234;Sinc=0;E_P=20PPPPCCCCII;E_U=21PPPPCCCCII;E_S=22AAIIIIIIII;CImp=2;Pub=LOS GRINGOS                    ;Enc1=NOMBRE DEL NEGOCIO;Enc2=Direccion - Telefono            ;PeP=3;SEt=S;ETi=S";
const NOW = new Date(2026, 9, 13, 20, 42);
const BRANCH_2_4_4 = { prefixLength: 2, pluLength: 4, weightLength: 4, weightDivisor: 1000, totalLength: 13, payloadType: "weight" as const };

function scale() {
  const f = new FakeCuora("max60", { address: 20, capacity: 8000 });
  f.config = REAL_CONFIG_1310;
  f.clock = "20:42:10 13/10/26";
  for (const [n, name, price, type] of [[2, "GRINGO CAJON DE", 72000, "U"], [5, "TROZADITOx1x2", 5200, "P"], [10, "PECHUGAC/H x1x5", 6480, "P"], [13, "PECHUGA S/H x1x3", 9000, "P"], [17, "ALITAS", 4500, "P"]] as const) {
    f.plus.set(n, fakeReadRecord("max60", { number: n, name, price, code: n, type }));
  }
  return f;
}
const run = (f: FakeCuora) => runSystelDiagnostic(new SystelClient(f, { address: 20, busyRetryMs: [1, 1] }), { products: GRINGOS, branchConfig: BRANCH_2_4_4, now: NOW });
const step = (r: Awaited<ReturnType<typeof run>>, id: string) => r.steps.find((s) => s.id === id)!;

describe("[SIMULADO] diagnóstico completo de la Systel, solo lectura", () => {
  it("balanza con ventas guardadas (el ticket real de 2 artículos): todo OK y solo funciones de lectura", async () => {
    const f = scale();
    f.salesEndExclusive = true; // como si la balanza no incluyera el día de fin (una de las causas posibles del E7 real)
    f.sales = [
      fakeSaleLine({ ticket: 3095, date: "13/10/26", time: "12:55:34", plu: 2, units: 1, amount: 72000 }),
      fakeSaleLine({ ticket: 3095, date: "13/10/26", time: "12:55:34", plu: 5, grams: 215, amount: 1118 })
    ];
    const r = await run(f);
    assert.deepEqual(r.steps.map((s) => [s.id, s.status]), [["respuesta", "ok"], ["modelo", "ok"], ["reloj", "ok"], ["formatos", "ok"], ["productos", "ok"], ["ventas", "ok"], ["detalle", "ok"], ["interpretacion", "ok"]], JSON.stringify(r.steps, null, 1));
    assert.match(step(r, "ventas").detail, /hoy a mañana/);
    assert.match(step(r, "interpretacion").detail, /2 de 2 artículos/);
    for (const x of f.received) assert.ok((SYSTEL_READ_FUNCTIONS as readonly number[]).includes(x.fn), `mandó la función ${x.fn}`);
  });

  it("E7 a todas las formas (como la balanza real el 13/10): lo dice sin concluir que no hubo ventas", async () => {
    const f = scale();
    const r = await run(f);
    assert.equal(step(r, "ventas").status, "aviso");
    assert.match(step(r, "ventas").detail, /E7.*7 formas.*No prueba que hoy no se haya vendido/);
    assert.equal(f.received.filter((x) => x.fn === 72).length, 7);
    assert.match(r.verdict, /código de cada producto/);
    // Lo demás igual se diagnosticó.
    assert.equal(step(r, "formatos").status, "ok");
    assert.equal(step(r, "productos").status, "ok");
  });

  it("formato de la sucursal distinto al de la balanza: aviso (Mostrador usa el de la balanza)", async () => {
    const r = await runSystelDiagnostic(new SystelClient(scale(), { address: 20, busyRetryMs: [] }), { products: GRINGOS, branchConfig: { ...BRANCH_2_4_4, weightLength: 6 }, now: NOW });
    assert.equal(step(r, "formatos").status, "aviso");
    assert.match(step(r, "formatos").detail, /NO coincide/);
  });

  it("producto con otro código o forma de venta en la balanza: aviso con el detalle", async () => {
    const f = scale();
    f.plus.set(5, fakeReadRecord("max60", { number: 5, name: "TROZADITOx1x2", price: 5200, code: 5, type: "U" }));
    const r = await run(f);
    assert.equal(step(r, "productos").status, "aviso");
    assert.match(step(r, "productos").detail, /por unidad \(en Patagonia "TROZADITOx1x2" es por kg\)/);
  });

  it("numeración por artículo y producto sin precio en Patagonia: se interpreta igual", async () => {
    const f = scale();
    f.sales = [
      fakeSaleLine({ ticket: 38, date: "13/10/26", time: "12:55:20", plu: 2, units: 1, amount: 72000 }),
      fakeSaleLine({ ticket: 39, date: "13/10/26", time: "12:55:34", plu: 5, grams: 215, amount: 1118 }),
      fakeSaleLine({ ticket: 40, date: "13/10/26", time: "13:00:00", plu: 17, grams: 1250, amount: 5625 })
    ];
    const r = await run(f);
    assert.match(step(r, "detalle").detail, /uno por ARTÍCULO/);
    // Del reporte se vinculan los 3 (el importe es el de la balanza), pero la ETIQUETA de ALITAS no se
    // cargaría en Mostrador porque no tiene precio en Patagonia (se cobraría $0): el diagnóstico lo avisa.
    assert.match(step(r, "interpretacion").detail, /3 de 3 artículos/);
    assert.equal(step(r, "interpretacion").status, "aviso");
    assert.match(step(r, "interpretacion").detail, /ALITAS: su etiqueta .* no se cargaría en Mostrador \(ALITAS no tiene precio cargado en Patagonia/);
  });

  it("la balanza no contesta: lo dice y no sigue", async () => {
    const f = scale();
    f.silent = true;
    const r = await run(f);
    assert.deepEqual(r.steps.map((s) => [s.id, s.status]), [["respuesta", "falla"]]);
  });

  it("E3 en el pedido de ventas: falla de comunicación, no \"sin ventas\"", async () => {
    const f = scale();
    const client = new SystelClient(f, { address: 20, busyRetryMs: [] });
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => (frame[1] === 72 ? Uint8Array.from([20, 72, 0x45, 0x33, 20 ^ 72 ^ 0x45 ^ 0x33]) : orig(frame));
    const r = await runSystelDiagnostic(client, { products: GRINGOS, branchConfig: BRANCH_2_4_4, now: NOW });
    assert.equal(step(r, "ventas").status, "falla");
    assert.match(r.verdict, /comunicación/);
  });
});

describe("piezas del diagnóstico", () => {
  it("formas del pedido: la primera es la del documento (día-mes-año, hoy a hoy)", () => {
    const v = salesRequestVariants(NOW);
    assert.equal(v[0][1], "131026131026");
    assert.equal(v[1][1], "131026141026");
    assert.equal(v.length, 7);
  });
  it("la etiqueta que imprimiría la balanza con su formato real (13/10)", () => {
    assert.equal(labelFor("20PPPPCCCCII", 5, 215)?.slice(0, 12), "200005021500");
    assert.equal(labelFor("21PPPPCCCCII", 2, 1)?.slice(0, 12), "210002000100");
    assert.equal(labelFor("20PPPPCCCCII", 5, 12345), null); // 12,345 kg no entra en 4 cifras
  });
});
