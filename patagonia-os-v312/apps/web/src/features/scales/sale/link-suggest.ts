import { isWeighed, type ScaleCatalogItem } from "./profile";

/**
 * Sugerencia de vínculo por NOMBRE para un producto de la balanza que no coincide por código. Es conservadora: se
 * equivoca dejando sin sugerir, nunca sugiriendo otro producto.
 *
 * - Mismo nombre (sin distinguir mayúsculas ni espacios de más) y la misma forma de venta.
 * - Si la balanza cortó el nombre (guarda hasta 16-18 letras), vale un nombre de Patagonia que empiece igual.
 * - Tiene que quedar UNO solo. Si hay más de uno, no se sugiere nada.
 *
 * Real (Los gringos):
 * - "MOLIDA x1" NO sugiere "MOLIDA x5";
 * - "ARABES" sugiere "ARABES" y no "ARABES X 5 EFECTIVO";
 * - "BOCADITOS MUZZA" (96) sugiere el 102.
 * La persona igual confirma con "Guardar".
 */
export interface SuggestProduct {
  id: string;
  code: string;
  name: string;
  unit: string;
}

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

export function suggestByName<P extends SuggestProduct>(item: ScaleCatalogItem, products: P[]): P | null {
  const name = norm(item.name);
  if (name.length < 3) return null;
  const truncated = item.name.trimEnd().length >= 16;
  const weighed = isWeighed(item.saleType);
  const found = products.filter((p) => weighed === (p.unit === "kg") && (norm(p.name) === name || (truncated && norm(p.name).startsWith(name))));
  return found.length === 1 ? found[0] : null;
}
