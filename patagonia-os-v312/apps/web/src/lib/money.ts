export function parseAmount(raw: string): number {
  const cleaned = raw.trim().replace(/\./g, "").replace(",", ".");
  return Number(cleaned);
}
