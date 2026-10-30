// Rinde de un despiece: kilos aprovechables y su costo promedio. Lógica pura, sin Supabase.
// Por defecto el costo de cada corte se reparte por lo que vale (allocateCarcassCost); con "costo_parejo" (migración 170)
// todos los cortes cuestan este promedio. Sin la opción esto es informativo,
// porque si todos costaran lo mismo por kilo la falda daría pérdida y el lomo una ganancia enorme.

export interface CarcassYield {
  /** Kilos de cortes con precio de venta (lo que se vende; hueso y grasa sin precio no cuentan). */
  usableKg: number;
  /** Porcentaje del peso de la compra que se aprovecha. */
  usablePct: number;
  /** Lo que se pagó ÷ kilos aprovechables. */
  avgCostPerKg: number;
}

export function carcassYield(totalCost: number, totalWeight: number, cuts: { weight: number; unitPrice: number }[]): CarcassYield | null {
  const usableKg = cuts.reduce((sum, c) => (c.unitPrice > 0 && c.weight > 0 ? sum + c.weight : sum), 0);
  if (usableKg <= 0 || totalCost <= 0) return null;
  return {
    usableKg: Math.round(usableKg * 1000) / 1000,
    usablePct: totalWeight > 0 ? Math.round((usableKg / totalWeight) * 1000) / 10 : 0,
    avgCostPerKg: Math.round((totalCost / usableKg) * 100) / 100
  };
}
