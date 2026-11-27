import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { scaleName } from "./preflight";
import { specPrefixes } from "../label-spec";
import { barcodeOk, expectation, expected1070, expectedName, FOREIGN, fullCatalog, makeHarness, MODEL_LABEL, MODELS, NAME_LENGTH, onScale, printedLabel, productProblemOnScale, readAtCounter, scaleRecords, type Variant } from "./test-envios-harness";

/**
 * [SIMULADO] MATRIZ DE ENVÍO (A): cada producto pesable de Patagonia llega bien a cada modelo de balanza, y la etiqueta
 * que imprimiría la balanza con lo que quedó grabado vuelve a Mostrador como el mismo producto, kilos e importe.
 *
 * Modelos: Report LT por USB, Report por red, Aura, Cuora Max 6.0 / 6.2 (con centavos) / 7.0 y Cuora 2.
 * Variantes: con y sin 'balanzas_v2' (con otra balanza del local que ya usa el inicio 20), con y sin zona de precios.
 * Catálogo: kilo y unidad, precios bajos/altos/en el tope/por encima, centavos, nombres largos con tildes y ñ, PLU de 1,
 * 3, 4 y 5 cifras, 998/999/9998, repetidos, sin precio, desactivados, ocupado por otro producto y uno con precio de zona.
 * La tabla de lo que TIENE que pasar (expectation) es propia: no se copia de la revisión previa.
 */

const serial = Object.assign(new EventTarget(), { getPorts: async () => [], requestPort: async () => { throw new Error("no"); } });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

const noop = () => {};
const VARIANTS: Variant[] = [
  { v2: false, zone: false },
  { v2: false, zone: true },
  { v2: true, zone: false },
  { v2: true, zone: true }
];

beforeEach(() => installFakeLocalStorage());

describe("[SIMULADO] Matriz de envío: modelos × catálogo × variantes", () => {
  for (const model of MODELS) {
    for (const variant of VARIANTS) {
      it(`${MODEL_LABEL[model]} · ${variant.v2 ? "balanzas_v2" : "sin balanzas_v2"} · ${variant.zone ? "con zona" : "sin zona"}`, async () => {
        const h = await makeHarness(model, variant, fullCatalog(model));
        const before = scaleRecords(h);
        const prep = await h.session.prepare(noop);
        assert.equal(prep.blocker, undefined, `${prep.blocker} ${prep.notes.join(" · ")}`);
        assert.equal(prep.canWrite, true);

        // 1. La revisión previa: cada producto NO enviable aparece con un motivo; los enviables, no.
        const skipped = prep.skipped ?? [];
        const send = h.engineProducts.filter((p) => expectation(model, p, h.catalog).kind === "send");
        for (const p of h.engineProducts) {
          const e = expectation(model, p, h.catalog);
          const s = skipped.filter((x) => x.code === p.code && x.name === p.name);
          if (e.kind === "skip") {
            assert.equal(s.length, 1, `${p.code} ${p.name}: tenía que aparecer en la revisión previa (${JSON.stringify(skipped)})`);
            assert.match(s[0].reason, e.reason, `${p.code} ${p.name}: motivo "${s[0].reason}"`);
          } else assert.equal(s.length, 0, `${p.code} ${p.name} no tenía que estar en la revisión previa: ${JSON.stringify(s)}`);
          if (e.kind === "occupied") assert.ok(prep.pending.some((x) => x.code === Number(p.code)), `${p.code}: ocupado por otro producto, a revisar`);
        }
        assert.equal(prep.writes, send.length, `cambios a escribir: ${prep.writes}, enviables: ${send.map((p) => p.code).join(",")}`);
        // El aviso del nombre dice cómo queda en la balanza (mismas letras; la mayúscula la decide la balanza).
        for (const w of prep.warnings ?? []) {
          const p = h.engineProducts.find((x) => x.code === w.code)!;
          const shown = /"(.*)"/.exec(w.reason)![1];
          assert.equal(shown, scaleName(p.name, NAME_LENGTH[model]));
          assert.equal(expectedName(model, p.name).toUpperCase(), shown, `aviso de nombre de ${p.code}: "${shown}" vs lo que graba la balanza "${expectedName(model, p.name)}"`);
        }

        const out = await h.session.sync(prep, noop);
        assert.equal(out.ok, true, `${out.message} ${JSON.stringify(out.failures)} ${String(JSON.stringify(out.support)).slice(0, 600)}`);
        assert.equal(out.verified, send.length);

        // 2. Cada enviable quedó con PLU, precio (escala del modelo), nombre cortado sin tildes rotas, kilo/unidad y código de barras.
        for (const p of send) {
          assert.equal(productProblemOnScale(h, p), null, `${p.code} ${p.name}`);
          const got = onScale(h, Number(p.code))!;
          assert.match(got.name, /^[\x20-\x7e]*$/, `${p.code}: nombre con letras que la balanza no tiene`);
          assert.ok(got.name.length <= NAME_LENGTH[model]);
          assert.doesNotMatch(got.name, /\?/);
        }
        const noquis = onScale(h, 42)!;
        assert.match(noquis.name.toUpperCase(), /^NOQUIS CASEROS/, `ñ y tildes: "${noquis.name}"`);
        if (variant.zone) assert.equal(onScale(h, 80)!.price, h.catalog.find((p) => p.code === "80")!.listPrices!.z1.price, "la balanza del local tiene el precio de la zona");

        // 3. Configuración del código de barras: Kretz el 1070 del perfil; Systel el tipo y formato por producto (en productProblemOnScale).
        assert.ok(barcodeOk(h), `1070: ${JSON.stringify(h.kretz?.barcodeConfigs)} (esperado ${expected1070(h)})`);
        if (variant.v2 && model === "cuora2") {
          // La Cuora 2 imprime con su formato general (no se le escribe un código por producto): no recibe un inicio propio.
          assert.equal(h.db.row(h.scaleKey).spec, null, "a la Cuora 2 no se le asigna un inicio que nunca imprime");
        } else if (variant.v2 && model !== "report-red") {
          const spec = h.db.row(h.scaleKey).spec!;
          assert.notEqual(spec.prefixes.weighed, "20", "otra balanza del local ya usa el 20: esta recibe un inicio propio");
        }

        // 4. Lo NO enviable no se escribió; lo ajeno y lo ocupado quedaron intactos.
        const after = scaleRecords(h);
        const sendCodes = new Set(send.map((p) => Number(p.code)));
        for (const [n, raw] of after) {
          if (sendCodes.has(n) || isProofProduct(h, n)) continue;
          assert.equal(raw, before.get(n), `el ${n} no era de este envío y cambió`);
        }
        for (const n of FOREIGN) assert.equal(after.get(n), before.get(n), `producto ajeno ${n}`);
        assert.deepEqual([...after.keys()].filter((n) => !before.has(n) && !sendCodes.has(n)).filter((n) => !isProofProduct(h, n)), [], "no se creó nada fuera del envío");

        // 5. El circuito completo: la etiqueta que imprime la balanza con lo grabado vuelve a Mostrador igual.
        for (const p of send) {
          const label = printedLabel(h, Number(p.code));
          assert.ok(label, `${p.code}: no se pudo armar la etiqueta`);
          // 'balanzas_v2': el perfil guardado de ESTA balanza tiene que describir lo que imprime (su inicio).
          if (variant.v2 && h.db.row(h.scaleKey).spec) {
            const own = specPrefixes(h.db.row(h.scaleKey).spec!);
            assert.ok(own.some((x) => label!.raw.startsWith(x)), `${p.code}: la balanza imprime ${label!.raw} pero su perfil dice inicios ${own.join("/")}`);
          }
          const r = readAtCounter(h, label!.raw);
          assert.equal(typeof r, "object", `${p.code} ${p.name}: Mostrador no leyó ${label!.raw}: ${r}`);
          const read = r as { productId: string; quantity: number; amount: number };
          assert.equal(read.productId, p.id, `${label!.raw}: otro producto`);
          assert.ok(Math.abs(read.quantity - label!.qty) < 1e-9, `${label!.raw}: ${read.quantity} en vez de ${label!.qty}`);
          assert.ok(Math.abs(read.amount - Math.round(label!.qty * p.priceRetail * 100) / 100) < 0.005, `${label!.raw}: importe ${read.amount} en vez de ${label!.qty * p.priceRetail}`);
        }
      });
    }
  }
});

/** El producto de prueba que la Systel 6.2/7.0/Cuora 2 escribe en un número libre antes de tocar los del cliente. */
function isProofProduct(h: Awaited<ReturnType<typeof makeHarness>>, n: number): boolean {
  return !h.kretz && onScale(h, n)?.name === "PRUEBA PATAGONIA";
}
