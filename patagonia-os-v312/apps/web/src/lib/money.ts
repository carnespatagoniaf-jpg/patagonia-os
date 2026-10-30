export function parseAmount(raw: string): number {
  const text = raw.trim();
  // Un solo punto, sin coma y con 1-2 decimales detrás: es un número de la computadora ("14315.25",
  // costo precargado en un campo con String(n)), no "punto de miles". Antes daba 1.431.525 (real 28/10).
  if (/^-?\d+\.\d{1,2}$/.test(text)) return Number(text);
  const cleaned = text.replace(/\./g, "").replace(",", ".");
  return Number(cleaned);
}

/** Número → texto para precargar un campo de plata: "14315,25" (coma decimal, sin miles), que parseAmount lee igual. */
export function amountInputText(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(Math.round(value * 100) / 100).replace(".", ",");
}
