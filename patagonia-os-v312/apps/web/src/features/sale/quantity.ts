/**
 * Cantidad (kilos o unidades) escrita a mano en Mostrador. Acepta coma o punto
 * como decimal ("0,750" y "0.750" son 750 g), que es como se escribe en Argentina.
 * NO es parseAmount (dinero): ahí "1.200" son mil doscientos; acá, para kilos,
 * "1.200" es 1,2 kg. Devuelve NaN si no es un número.
 */
export function parseQuantity(raw: string): number {
  const s = raw.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return NaN;
  return Number(s);
}
