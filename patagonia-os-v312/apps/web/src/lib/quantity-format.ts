/**
 * Kilos y unidades como se leen en Argentina: coma decimal y punto de miles ("18,006 kg", "1.250 u.").
 * Antes varias pantallas mostraban el número crudo ("18.006 kg"), que se lee como dieciocho mil kilos.
 */
export function formatQuantity(n: number, unit?: string | null, unitLabel = "u."): string {
  const value = Number.isFinite(n) ? n : 0;
  const text = value.toLocaleString("es-AR", { maximumFractionDigits: 3 });
  return unit === "kg" ? `${text} kg` : `${text} ${unitLabel}`;
}
