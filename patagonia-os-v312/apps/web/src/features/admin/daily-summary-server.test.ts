// La función daily-summary (supabase/functions) arma el WhatsApp con su propia copia del semáforo: estas pruebas
// controlan que diga lo mismo que el panel (client-health.ts) y que la plantilla salga como la aprueba Meta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { argentinaHour, health, previewText, templateParams, toWhatsAppNumber, type CompanyRow, type SummaryData } from "../../../../../supabase/functions/daily-summary/summary";
import { clientHealth } from "./client-health";

const NOW = Date.parse("2026-11-20T11:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function company(over: Partial<CompanyRow> & { usage?: Partial<CompanyRow["usage"]> }): CompanyRow {
  const { usage, ...rest } = over;
  return {
    id: "x", name: "X", created_at: ago(100), paid_until: "2026-12-10", trial_ends_at: null, last_payment_amount: 39000, mp_ok: false,
    ...rest,
    usage: { product_count: 100, sale_count: 3900, sales_last_7d: 300, first_sale_at: ago(90), last_sale_at: ago(0), last_sign_in_at: ago(0), ...usage }
  };
}

const CASES: CompanyRow[] = [
  company({ name: "Bien" }),
  company({ name: "Cae fuerte", usage: { sale_count: 3640, sales_last_7d: 40, first_sale_at: ago(91), last_sale_at: ago(1) } }),
  company({ name: "Cae algo", usage: { sale_count: 3720, sales_last_7d: 120, first_sale_at: ago(91), last_sale_at: ago(1) } }),
  company({ name: "Sin vender", usage: { last_sale_at: ago(15) } }),
  company({ name: "Sin productos", created_at: ago(5), usage: { product_count: 0, sale_count: 0, sales_last_7d: 0, first_sale_at: null, last_sale_at: null } }),
  company({ name: "Debe", paid_until: "2026-11-01" }),
  company({ name: "MP al día", paid_until: "2026-11-01", mp_ok: true })
];

test("el semáforo de la función dice lo mismo que el del panel", () => {
  for (const c of CASES) {
    const server = health(c, "2026-11-20", NOW);
    const owes = !c.mp_ok && c.paid_until !== null && c.paid_until < "2026-11-20";
    const web = clientHealth({
      createdAt: c.created_at,
      owes,
      usage: {
        productCount: c.usage.product_count, saleCount: c.usage.sale_count, salesLast7d: c.usage.sales_last_7d, firstSaleAt: c.usage.first_sale_at,
        lastSaleAt: c.usage.last_sale_at, lastSignInAt: c.usage.last_sign_in_at, closedShiftCount: 0, purchaseCount: 0, salesNote: null, salesContactedAt: null, salesLostReason: null
      }
    }, NOW);
    assert.deepEqual(server, { level: web.level, reasons: web.reasons }, c.name);
  }
});

test("las 6 variables de la plantilla, en una sola línea cada una", () => {
  const data: SummaryData = { today: "2026-11-20", companies: CASES, collected_month: 585000, collected_yesterday: 39000 };
  const params = templateParams("Patagonia System", data, NOW);
  assert.equal(params.length, 6);
  for (const p of params) assert.ok(!/[\n\r\t]| {5,}/.test(p) && p.length > 0, p);
  assert.equal(params[0], "Patagonia System · viernes 20/11");
  assert.equal(params[1], "$585.000 (ayer $39.000)");
  assert.equal(params[2], "1 cliente, $39.000");
  assert.equal(params[3], "nadie");
  assert.match(params[4], /^Cae fuerte \(vende menos: 40 ventas esta semana, antes unas 300\), Sin vender \(no vende hace 15 días\), Sin productos/);
  assert.equal(params[5], "Cae algo, Debe");
  assert.match(previewText(params), /^Resumen de Patagonia System · viernes 20\/11\nCobrado en el mes: \$585\.000/);
  assert.match(previewText(params), /Más detalle en el panel\.$/);
});

test("números y hora", () => {
  assert.equal(toWhatsAppNumber("2966 15 555-123"), "5492966555123");
  assert.equal(toWhatsAppNumber("+54 9 11 5555-1234"), "5491155551234");
  assert.equal(toWhatsAppNumber("123"), null);
  assert.equal(argentinaHour(Date.parse("2026-11-20T11:00:00Z")), 8);
});
