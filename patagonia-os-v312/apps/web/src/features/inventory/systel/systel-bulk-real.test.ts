import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SystelClient } from "./systel-client";
import { FakeCuora } from "./systel-fake";
import { pluEanSetting } from "./systel-plu";
import { compareWithBackup, restoreFromBackup, rewriteAllProductBarcodes, takeProductBackup, targetCodeFor } from "./systel-product-barcode";

// [SIMULADO con registros REALES] del respaldo de Los gringos (14/10, 103 productos, huella b8c2d441): uno de cada
// forma que hay en esa balanza. La Cuora simulada se porta como la real: acepta el tipo como dígito y lo guarda como
// byte (0x01), y deja en 0x00 el último carácter del lote si era espacio.
const T1 = "\u0001";
const T0 = "\u0000";
const Z = "0".repeat(56);
const SP = "0".repeat(44) + "          0 ";
const REAL: [number, string][] = [
  [1, `00010ALPINA CAJON DE   08200007800000001010000U00000000N                              ${Z}${T1}000000000000N`],
  [4, `00040POLLO ENTEROxKG   00520000000000004010000P00000000N                              ${Z}${T1}000000000000N`],
  [13, `00130PECHUGA S/H x1x3  00920000900000013010000P00000000N                              ${SP}${T1}20PPPPCCCCCCN`],
  [51, `00510CAJA MED.MERL SOLA02600002400000051010000U00000000N                              ${SP}${T1}21PPPPCCCCCCN`],
  [86, `00860CRINKLE KG        00900000000000086010000P00000000N                              ${SP}${T0}20PPPPCCCCCCN`],
  [97, `00970BOCADITOS CAJA    05200004900000097010000U00000000N                              ${SP}${T0}21PPPPCCCCCCN`],
  [98, `00981ARABES            00090000090000098080000U00000000N                              ${Z}${T1}000000000000N`]
];

function realScale() {
  const f = new FakeCuora("max60", { address: 20, typeByteAccepted: "ascii", loteNulOnWrite: true });
  for (const [n, raw] of REAL) f.plus.set(n, raw);
  return f;
}
const client = (f: FakeCuora) => new SystelClient(f, { address: 20, busyRetryMs: [], writes: { productBarcode: true } });
const items = () => REAL.map(([n, raw]) => ({ number: n, saleType: raw[46] })).filter((x) => targetCodeFor(x.saleType));

describe("[SIMULADO con registros REALES] 3. Todos los productos, como se porta la Cuora de Los gringos", () => {
  it("todos confirmados; precios, nombres y forma de venta intactos; cada uno con su código", async () => {
    const f = realScale();
    const r = await rewriteAllProductBarcodes(client(f), "max60", items(), { mode: "ascii" });
    assert.equal(r.stoppedAt, null, JSON.stringify(r.results.at(-1)));
    for (const [n, raw] of REAL) {
      const now = f.plus.get(n)!;
      assert.equal(now.slice(0, 4) + now.slice(5, 56), raw.slice(0, 4) + raw.slice(5, 56), `producto ${n}: cambió algo antes del lote`);
      assert.deepEqual(pluEanSetting(now), { type: 1, config: raw[46] === "P" ? "20PPPPCCCCCC" : "21PPPPCCCCCC" });
    }
  });

  it("si se corre otra vez (o se corta y se repite), no reescribe lo que ya está", async () => {
    const f = realScale();
    await rewriteAllProductBarcodes(client(f), "max60", items(), { mode: "ascii" });
    const before = f.received.length;
    const r = await rewriteAllProductBarcodes(client(f), "max60", items(), { mode: "ascii" });
    assert.equal(r.stoppedAt, null);
    assert.ok(r.results.every((x) => x.verdict === "ya_estaba"));
    assert.ok(f.received.slice(before).every((x) => x.fn !== 61));
  });

  it("el producto 97 tal como quedó en la balanza real (lote con 0x00) también se confirma", async () => {
    const f = realScale();
    const raw97 = f.plus.get(97)!;
    const end = raw97.length - 1;
    f.plus.set(97, raw97.slice(0, end - 14) + T0 + raw97.slice(end - 13));
    const r = await rewriteAllProductBarcodes(client(f), "max60", [{ number: 97, saleType: "U" }], { mode: "ascii" });
    assert.equal(r.stoppedAt, null, JSON.stringify(r.results));
  });

  it("restaurar desde el respaldo después de escribir todo: vuelven a como estaban", async () => {
    const f = realScale();
    const c = client(f);
    const { backup: b, missing } = await takeProductBackup(c, "max60", REAL.map(([n]) => n));
    assert.equal(missing.length, 0);

    await rewriteAllProductBarcodes(c, "max60", items(), { mode: "ascii" });
    const out = await restoreFromBackup(c, b, undefined, "ascii");
    assert.ok(out.every((x) => x.verdict === "restaurado" || x.verdict === "igual"), JSON.stringify(out));
    const cmp = await compareWithBackup(c, b);
    assert.ok(cmp.every((x) => x.state === "igual"), JSON.stringify(cmp));
  });
});
