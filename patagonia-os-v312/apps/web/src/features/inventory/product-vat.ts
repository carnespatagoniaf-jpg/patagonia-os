// IVA por producto (migración 154). Lógica pura, sin Supabase.

/** Las que se ofrecen en Stock. La base también acepta 0 y 27. */
export const PRODUCT_VAT_OPTIONS = [10.5, 21] as const;

/** 10.5 → "10,5%" */
export function vatPercentLabel(rate: number): string {
  return `${String(rate).replace(".", ",")}%`;
}

/** Valor del <select>: "" = el IVA general; si no, la alícuota como texto. */
export function vatSelectValue(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? "" : String(rate);
}

export function vatFromSelect(value: string): number | null {
  return value === "" ? null : Number(value);
}

/** Lo que muestra la columna IVA: la del producto, o la general entre paréntesis. */
export function productVatLabel(rate: number | null | undefined, generalRate: number | null): string {
  if (rate !== null && rate !== undefined) return vatPercentLabel(rate);
  return generalRate === null ? "General" : `General (${vatPercentLabel(generalRate)})`;
}
