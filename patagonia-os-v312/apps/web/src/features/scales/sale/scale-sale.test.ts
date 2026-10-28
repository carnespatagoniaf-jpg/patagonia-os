import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCode, parseTemplate, readFields, validEan13, withCheckDigit } from "./label-template";
import { decodeScaleCode, expectedItemCode, profileReadiness, unitsFromField } from "./profile";
import { addLibreFromPaper, addScannedItem, closePaper, emptyPaper, paperFingerprint, setLibreAmount, type Paper } from "./paper";
import { mirrorLinks, mirrorProducts, realProfileToday, realTickets, targetProfile } from "./los-gringos-fixture";
import { replayTicket } from "./los-gringos-replay";

const target = targetProfile();
const products = mirrorProducts(target.catalog);
const links = mirrorLinks(target.catalog);
const item = (code: number) => target.catalog.find((i) => i.code === code)!;
const scan = (paper: Paper, barcode: string) => addScannedItem(paper, decodeScaleCode(barcode, target), links, products);

describe("formatos de código (cualquier marca)", () => {
  it("lee los campos y respeta el verificador", () => {
    const t = parseTemplate("20PPPPCCCCCC")!;
    const code = buildCode(t, { P: 5, C: 14935 })!;
    assert.equal(code, withCheckDigit("200005014935"));
    assert.deepEqual(readFields(code, t), { P: 5, C: 14935 });
    assert.equal(validEan13(code.slice(0, 12) + ((Number(code[12]) + 1) % 10)), false);
  });
  it("no acepta letras desconocidas ni campos partidos", () => {
    assert.equal(parseTemplate("20PPPPXXCCCC"), null);
    assert.equal(parseTemplate("20PPCCPPCCCC"), null);
    assert.equal(parseTemplate("PPPP20CCCCCC"), null);
  });
  it("como la balanza: si el valor no entra, no hay código", () => {
    assert.equal(buildCode(parseTemplate("20PPPPCCCCII")!, { P: 8, C: 10110, I: 0 }), null);
  });
});

describe("Systel Cuora Max de Los gringos: configuración REAL de hoy vs la necesaria", () => {
  it("hoy: casi ningún producto vinculado se puede vender escaneando su código", () => {
    const today = realProfileToday();
    const r = profileReadiness(today, mirrorLinks(today.catalog), 14935);
    const by = (p: string) => r.problems.filter((x) => x.problem === p).length;
    // 87 con código propio en ceros (+ el 201 de prueba), y los que usan el general tienen solo 4 cifras de cantidad.
    assert.equal(by("sin_codigo"), 88);
    assert.ok(by("kilos_limitados") >= 1);
    assert.equal(r.totalOk, true);
  });
  it("con 20PPPPCCCCCC / 21PPPPCCCCCC por producto: ningún problema, hasta 999,999 kg", () => {
    const r = profileReadiness(target, links, 14935);
    assert.deepEqual(r.problems, []);
  });
  it("códigos REALES del TOTAL de la balanza (tickets 3095 y 3098)", () => {
    assert.deepEqual(decodeScaleCode("2202000731184", target), { kind: "total", amount: 73118, articles: 2, barcode: "2202000731184" });
    assert.deepEqual(decodeScaleCode("2202000727545", target), { kind: "total", amount: 72754, articles: 2, barcode: "2202000727545" });
    assert.equal(decodeScaleCode("2211999999994", target).kind, "error");
  });
  it("más de 10 kg sin perder un gramo (real: 14,935 kg)", () => {
    const code = expectedItemCode(item(8), target, 14.935)!;
    const d = decodeScaleCode(code, target);
    assert.equal(d.kind === "item" && d.quantity, 14.935);
  });
  it("unidades: enteras o como kilos, y si no se puede saber, no se carga", () => {
    assert.equal(unitsFromField(15), 15);
    assert.equal(unitsFromField(15000), 15);
    assert.equal(unitsFromField(1500), null);
    const d = decodeScaleCode(withCheckDigit("210002001500"), target);
    assert.equal(d.kind === "item" && d.quantity, null);
    assert.equal(scan(emptyPaper(), withCheckDigit("210002001500")).ok, false);
  });
  it("código mal leído o de otro comercio", () => {
    const good = expectedItemCode(item(5), target, 0.215)!;
    const bad = good.slice(0, 12) + ((Number(good[12]) + 1) % 10);
    assert.equal(decodeScaleCode(bad, target).kind, "error");
    assert.equal(decodeScaleCode("7790001234567", target).kind, "not_scale");
  });
});

describe("papel: artículos + TOTAL", () => {
  const trozadito = (kg: number) => expectedItemCode(item(5), target, kg)!;
  const cajon = expectedItemCode(item(2), target, 1)!;

  it("ticket REAL 3095: cajón 1 u. + trozadito 0,215 kg = $73.118 → $72.000 + $1.118", () => {
    let p = emptyPaper();
    p = (scan(p, cajon) as { paper: Paper }).paper;
    p = (scan(p, trozadito(0.215)) as { paper: Paper }).paper;
    const r = closePaper(p, { amount: 73118, articles: 2 });
    assert.deepEqual(r.ok && r.amounts, [72000, 1118]);
  });
  it("mayorista: el cajón a lista 2 ($68.000)", () => {
    let p = (scan(emptyPaper(), cajon) as { paper: Paper }).paper;
    p = (scan(p, trozadito(0.215)) as { paper: Paper }).paper;
    const r = closePaper(p, { amount: 69118, articles: 2 });
    assert.deepEqual(r.ok && r.amounts, [68000, 1118]);
  });
  it("precio a mano: no adivina, pide el papel y exige que sume el TOTAL", () => {
    let p = (scan(emptyPaper(), cajon) as { paper: Paper }).paper;
    p = (scan(p, cajon) as { paper: Paper }).paper;
    const r = closePaper(p, { amount: 140000, articles: 2 });
    assert.equal(!r.ok && r.need, "paper_amounts");
    const wrong = closePaper(p, { amount: 140000, articles: 2 }, [72000, 70000]);
    assert.equal(wrong.ok, false);
    const right = closePaper(p, { amount: 140000, articles: 2 }, [74000, 66000]);
    assert.deepEqual(right.ok && right.amounts, [74000, 66000]);
  });
  it("falta o sobra un artículo (o el mismo código dos veces): no confirma", () => {
    const p1 = (scan(emptyPaper(), cajon) as { paper: Paper }).paper;
    assert.match((closePaper(p1, { amount: 73118, articles: 2 }) as { reason: string }).reason, /falta escanear 1/);
    let p3 = (scan(p1, trozadito(0.215)) as { paper: Paper }).paper;
    p3 = (scan(p3, trozadito(0.215)) as { paper: Paper }).paper;
    assert.match((closePaper(p3, { amount: 73118, articles: 2 }) as { reason: string }).reason, /sobra 1/);
  });
  it("artículos de otro papel mezclados: si la cantidad coincide, el importe no cierra y no confirma", () => {
    let p = (scan(emptyPaper(), cajon) as { paper: Paper }).paper;
    p = (scan(p, trozadito(0.5)) as { paper: Paper }).paper;
    const r = closePaper(p, { amount: 73118, articles: 2 });
    assert.equal(r.ok, false);
  });
  it("producto sin vínculo, vínculo con otra forma de venta, producto desactivado: no se agrega", () => {
    const noLink = addScannedItem(emptyPaper(), decodeScaleCode(cajon, target), links.filter((l) => l.code !== 2), products);
    assert.match((noLink as { reason: string }).reason, /no está vinculado/);
    const wrongUnit = addScannedItem(emptyPaper(), decodeScaleCode(cajon, target), links.map((l) => (l.code === 2 ? { ...l, productId: "p-5" } : l)), products);
    assert.match((wrongUnit as { reason: string }).reason, /por unidad en la balanza/);
    const inactive = addScannedItem(emptyPaper(), decodeScaleCode(cajon, target), links, products.map((p) => (p.id === "p-2" ? { ...p, active: false } : p)));
    assert.equal(inactive.ok, false);
  });
  it("venta libre: se cobra su importe y no tiene producto (no descuenta stock)", () => {
    let p = (scan(emptyPaper(), cajon) as { paper: Paper }).paper;
    p = addLibreFromPaper(p, 6500);
    const r = closePaper(p, { amount: 78500, articles: 2 });
    assert.deepEqual(r.ok && r.amounts, [72000, 6500]);
    assert.equal(p.items[1].productId, null);
  });
  it("venta libre escaneada (genérico con código): pide su importe", () => {
    const generic = { ...target, catalog: [...target.catalog, { code: 8002, name: "GENERICO PESABLE", saleType: "P" as const, prices: [0], eanType: 1, eanConfig: "20PPPPCCCCCC" }] };
    const code = expectedItemCode(generic.catalog.at(-1)!, generic, 1.86)!;
    let p = (addScannedItem(emptyPaper(), decodeScaleCode(code, generic), links, products) as { paper: Paper }).paper;
    const r = closePaper(p, { amount: 15438, articles: 1 });
    assert.equal(!r.ok && r.need, "libre_amounts");
    p = setLibreAmount(p, 0, 15438);
    assert.deepEqual(closePaper(p, { amount: 15438, articles: 1 }).ok, true);
  });
  it("REAL 08/10 ticket 2300: dos cajones iguales → pide confirmar con el papel, no reparte solo", () => {
    let p = (scan(emptyPaper(), cajon) as { paper: Paper }).paper;
    p = (scan(p, cajon) as { paper: Paper }).paper;
    const r = closePaper(p, { amount: 144000, articles: 2 });
    assert.equal(!r.ok && r.need, "confirm_split");
    assert.match((r as { question: string }).question, /2 × .*: \$72\.000 cada uno/);
    assert.deepEqual(closePaper(p, { amount: 144000, articles: 2 }, [74000, 70000]).ok, true);
  });
  it("mismo importe y distintos productos: huellas distintas (nunca se toma como el mismo ticket)", () => {
    // $72.000 = 1 cajón GRINGO (lista 1) o 1 cajón MINDANAO (lista 2, $72.000): mismo TOTAL, otro papel.
    const a = (scan(emptyPaper(), cajon) as { paper: Paper }).paper;
    const b = (scan(emptyPaper(), expectedItemCode(item(3), target, 1)!) as { paper: Paper }).paper;
    assert.notEqual(paperFingerprint("2201000720004", a), paperFingerprint("2201000720004", b));
  });
  it("la huella no depende del orden de escaneo", () => {
    let a = (scan(emptyPaper(), cajon) as { paper: Paper }).paper;
    a = (scan(a, trozadito(0.215)) as { paper: Paper }).paper;
    let b = (scan(emptyPaper(), trozadito(0.215)) as { paper: Paper }).paper;
    b = (scan(b, cajon) as { paper: Paper }).paper;
    assert.equal(paperFingerprint("2202000731184", a), paperFingerprint("2202000731184", b));
  });
});

describe("los 945 tickets REALES de la semana (07-13/10), escaneados como lo haría el cajero", () => {
  const tickets = realTickets();
  const results = tickets.map((t) => ({ t, r: replayTicket(t, target, links, products) }));

  it("son 945 tickets y 1.430 artículos", () => {
    assert.equal(tickets.length, 945);
    assert.equal(tickets.reduce((s, t) => s + t.lines.length, 0), 1430);
  });
  it("todos se cobran, y el producto y la cantidad de cada artículo son los de la balanza", () => {
    const failed = results.filter((x) => !x.r.ok);
    assert.deepEqual(failed.map((x) => `${x.t.key}: ${x.r.problem}`), []);
    for (const { t, r } of results) {
      const printed = t.lines.filter((l) => l.amount > 0 || l.units > 0 || l.grams > 0);
      printed.forEach((l, i) => {
        const generic = target.genericCodes.includes(l.plu);
        assert.equal(r.lines[i].productId, generic ? null : `p-${l.plu}`, t.key);
        if (!generic) assert.equal(r.lines[i].quantity, l.grams > 0 ? l.grams / 1000 : l.units, t.key);
      });
    }
  });
  it("el total de cada ticket es exacto y el importe de CADA artículo es el de la balanza (ningún reparto adivinado)", () => {
    let mismatch = 0;
    const counts = { listas: 0, papel: 0 };
    for (const { t, r } of results) {
      const total = t.lines.reduce((s, l) => s + l.amount, 0);
      assert.equal(r.lines.reduce((s, l) => s + l.amount, 0), total, t.key);
      if (r.lines.some((l) => Math.abs(l.amount - l.realAmount) > 1)) mismatch++;
      counts[r.method!]++;
    }
    // Antes, el 08/10 ticket 2300 (dos cajones a mano $74.000 + $70.000) se deducía como 2 × $72.000. Ahora los
    // artículos iguales se confirman con el papel: 0 diferencias.
    assert.equal(mismatch, 0);
    assert.deepEqual(counts, { listas: 911, papel: 34 });
    // Confirmaciones de "artículos iguales" que vería el cajero en la semana (y en ninguna se aceptó un reparto falso).
    assert.equal(results.filter((x) => x.r.confirmedSplit).length, 2);
  });
  it("stock: lo que se descontaría por producto es exactamente lo vendido en la balanza", () => {
    const sold = new Map<string, number>();
    const charged = new Map<string, number>();
    for (const { t, r } of results) {
      for (const l of t.lines) if (!target.genericCodes.includes(l.plu)) sold.set(`p-${l.plu}`, (sold.get(`p-${l.plu}`) ?? 0) + (l.grams > 0 ? l.grams : l.units * 1000));
      for (const l of r.lines) if (l.productId) charged.set(l.productId, (charged.get(l.productId) ?? 0) + Math.round(l.quantity * 1000));
    }
    assert.deepEqual([...charged.entries()].sort(), [...sold.entries()].filter(([, v]) => v > 0).sort());
  });
  it("huellas repetidas en el mismo día (dos clientes con lo mismo) se confirman, no se bloquean", () => {
    const seen = new Map<string, number>();
    for (const { t, r } of results) seen.set(`${t.date}|${r.fingerprint}`, (seen.get(`${t.date}|${r.fingerprint}`) ?? 0) + 1);
    const repeated = [...seen.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0);
    // Cantidad de cobros que le van a pedir al cajero "¿es otro ticket igual?" en una semana real.
    assert.equal(repeated, 94);
  });
});

describe("Systel de Pollería Giuseppe: el código del artículo trae el IMPORTE, no el peso (REAL 27/10)", () => {
  // Ticket real 20-451: MILA POLLO 0,220 kg × $11.000 = $2420. Artículo "2000010024209", TOTAL "2201000024203".
  const giuseppe = (weighedFormat: string, prices = [11000]) => {
    const catalog = [{ code: 1, name: "MILA POLLO", saleType: "P" as const, prices, eanType: 0, eanConfig: null }, { code: 2, name: "HUEVOS", saleType: "U" as const, prices: [300], eanType: 0, eanConfig: null }];
    return { profile: { scaleKey: "systel", brand: "systel", weighedFormat, unitFormat: weighedFormat, totalFormat: "22AAIIIIIIII", amountDecimals: 0, genericCodes: [], catalog }, products: mirrorProducts(catalog), links: mirrorLinks(catalog) };
  };

  it("lee producto, importe y saca los kilos con el precio de la balanza", () => {
    const g = giuseppe("20PPPPIIIIII");
    const d = decodeScaleCode("2000010024209", g.profile);
    assert.equal(d.kind, "item");
    if (d.kind !== "item") return;
    assert.equal(d.code, 1);
    assert.equal(d.amount, 2420);
    assert.equal(d.quantity, 0.22);
  });

  it("el ticket real se cobra con su importe exacto y descuenta 0,220 kg", () => {
    const g = giuseppe("20PPPPIIIIII");
    const added = addScannedItem(emptyPaper(), decodeScaleCode("2000010024209", g.profile), g.links, g.products);
    assert.ok(added.ok);
    if (!added.ok) return;
    assert.equal(added.item.quantity, 0.22);
    const total = decodeScaleCode("2201000024203", g.profile);
    assert.equal(total.kind, "total");
    if (total.kind !== "total") return;
    assert.deepEqual([total.amount, total.articles], [2420, 1]);
    const close = closePaper(added.paper, total);
    assert.ok(close.ok);
    if (close.ok) assert.deepEqual(close.amounts, [2420]);
  });

  it("si los importes de los artículos no suman el TOTAL, no confirma", () => {
    const g = giuseppe("20PPPPIIIIII");
    const added = addScannedItem(emptyPaper(), decodeScaleCode("2000010024209", g.profile), g.links, g.products);
    assert.ok(added.ok);
    if (!added.ok) return;
    const close = closePaper(added.paper, { amount: 5000, articles: 1 });
    assert.equal(close.ok, false);
  });

  it("precio cambiado a mano en la balanza: no adivina los kilos y no lo agrega", () => {
    const g = giuseppe("20PPPPIIIIII", [12500]);
    const d = decodeScaleCode("2000010024209", g.profile);
    assert.equal(d.kind === "item" && d.quantity, null);
    assert.equal(addScannedItem(emptyPaper(), d, g.links, g.products).ok, false);
  });

  it("unitarios: las unidades salen del importe (3 × $300 = $900)", () => {
    const g = giuseppe("20PPPPIIIIII");
    const code = withCheckDigit("200002000900");
    const d = decodeScaleCode(code, g.profile);
    assert.equal(d.kind === "item" && d.quantity, 3);
  });

  it("listo para vender: un formato con importe no es 'sin cantidad'", () => {
    const g = giuseppe("20PPPPIIIIII");
    assert.deepEqual(profileReadiness(g.profile, g.links).problems, []);
  });
});
