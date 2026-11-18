/**
 * Report: con qué formato de etiqueta (campo 15 del PLU) graba Patagonia cada producto.
 *
 * El número de formato NO significa lo mismo en todas las Report: en la Report LT de Carnes Patagonia el "01"
 * imprime el código de barras, pero en la Report NX2 de Lauda (real 18/11/2026) el "01" sale SIN código de barras
 * y los productos cargados antes en la balanza (ej. PLU 37 BONDIOLA/ENTERA) usan otro formato que sí lo imprime.
 * Por eso no se adivina: se usa el formato que ya usan los productos reales de ESA balanza que Patagonia no tocó.
 *
 * Reglas (lógica pura, testeada en report-label.test.ts):
 * - Solo cuentan productos reales: ni el de fábrica ("NOMBRE"), ni los sin formato ("00"), ni los números que
 *   Patagonia graba (esos pueden tener el "01" que les puso Patagonia).
 * - Si algún producto real usa "01", queda "01" (lo que ya andaba en las balanzas donde el 01 imprime el código).
 * - Si no, el formato más usado entre los productos reales. Sin productos reales: "01".
 */
export const DEFAULT_REPORT_LABEL = "01";

export interface ReportLabelSample {
  plu: number;
  name: string;
  label: string;
}

const isFactoryName = (name: string) => {
  const n = name.trim().toUpperCase();
  return n === "" || /^NOMBRE *\d*$/.test(n);
};

/**
 * `preferOther` (Report por cable de red, la NX/NX2): el "01" está comprobado que sale SIN código en la NX2 de Lauda
 * (18/11), así que si algún producto real usa otro formato se toma ese aunque también haya productos con "01".
 */
export function chooseReportLabel(samples: ReportLabelSample[], patagoniaCodes: Iterable<number>, opts: { preferOther?: boolean } = {}): string {
  const own = new Set(patagoniaCodes);
  const counts = new Map<string, number>();
  for (const s of samples) {
    if (own.has(s.plu) || isFactoryName(s.name) || !/^\d{2}$/.test(s.label) || s.label === "00") continue;
    counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
  }
  if (opts.preferOther) counts.delete(DEFAULT_REPORT_LABEL);
  if (counts.size === 0 || counts.has(DEFAULT_REPORT_LABEL)) return DEFAULT_REPORT_LABEL;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/** Resumen para la pantalla: "37 BONDIOLA/ENTERA: 03 · 40 PALETA: 01" (los primeros 8 que no son de Patagonia). */
export function describeLabelSamples(samples: ReportLabelSample[], patagoniaCodes: Iterable<number>): string {
  const own = new Set(patagoniaCodes);
  const other = samples.filter((s) => !own.has(s.plu) && !isFactoryName(s.name));
  if (other.length === 0) return "la balanza no tiene otros productos además de los de Patagonia";
  return other.slice(0, 8).map((s) => `${s.plu} ${s.name.trim()}: ${s.label}`).join(" · ") + (other.length > 8 ? ` · y ${other.length - 8} más` : "");
}
