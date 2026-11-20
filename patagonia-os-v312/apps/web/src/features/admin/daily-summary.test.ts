import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailySummary, previousDay } from "./daily-summary";

const base = {
  brandName: "Patagonia System",
  today: "2026-11-20",
  activeClients: 17,
  collectedThisMonth: 585000,
  collectedYesterday: 39000,
  overdue: 78000,
  overdueCount: 2,
  dueSoon: [{ name: "Carnes del Sur", days: 3 }],
  atRisk: [
    { name: "Fiambrería Don Tito", level: "risk" as const, reason: "Vende menos: 41 ventas esta semana, antes unas 300" },
    { name: "Granja La Esquina", level: "warn" as const, reason: "Debe el abono" }
  ],
  upsellCount: 2
};

test("el resumen trae lo que importa a la mañana", () => {
  const text = buildDailySummary(base);
  assert.equal(
    text,
    [
      "*Patagonia System · viernes 20/11*",
      "",
      "💰 Cobrado en noviembre: $585.000 (ayer $39.000)",
      "🔴 Deben: 2 clientes, $78.000",
      "⏰ Vencen esta semana: Carnes del Sur (en 3 días)",
      "",
      "⚠️ Pueden irse (1):",
      "• Fiambrería Don Tito: Vende menos: 41 ventas esta semana, antes unas 300",
      "👀 Para mirar: Granja La Esquina",
      "📈 2 oportunidades de venderle más (ver Resumen)",
      "",
      "Clientes activos: 17"
    ].join("\n")
  );
});

test("un día tranquilo", () => {
  const text = buildDailySummary({ ...base, collectedYesterday: 0, overdue: 0, overdueCount: 0, dueSoon: [], atRisk: [], upsellCount: 0 });
  assert.match(text, /Cobrado en noviembre: \$585\.000\n/);
  assert.match(text, /✅ Nadie debe el abono/);
  assert.match(text, /✅ Todos los clientes venden y están al día/);
  assert.doesNotMatch(text, /Vencen|Pueden irse|oportunidad/);
});

test("muchos en riesgo: muestra 5 y cuenta el resto", () => {
  const atRisk = Array.from({ length: 7 }, (_, i) => ({ name: `C${i}`, level: "risk" as const, reason: "No vende hace 20 días" }));
  const text = buildDailySummary({ ...base, atRisk });
  assert.match(text, /Pueden irse \(7\)/);
  assert.match(text, /• y 2 más/);
});

test("día anterior, también a fin de mes", () => {
  assert.equal(previousDay("2026-11-20"), "2026-11-19");
  assert.equal(previousDay("2026-12-01"), "2026-11-30");
});
