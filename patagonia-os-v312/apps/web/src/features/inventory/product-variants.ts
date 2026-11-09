// Producto con variantes (migración 196, negocios con 'sin_carniceria', ej. mates and chill): "Mate imperial" en negro,
// marrón y verde son tres productos con su propio stock, mismo precio y categoría, nombre "Mate imperial - Negro" y
// código "<código>-1", "-2"… Así se buscan juntos en Mostrador y Pedidos (escribiendo "imperial" salen todos).
// Puro, testeado en product-variants.test.ts.

export interface VariantLine {
  label: string;
  /** Stock inicial escrito como "Negro: 3"; null = sin stock inicial. */
  stock: number | null;
}

/** "Negro: 3, Marrón, Verde: 1" (también uno por renglón). Error en castellano si algo no se entiende. */
export function parseVariants(text: string): { variants: VariantLine[]; error: string | null } {
  const parts = text.split(/[,\n;]/).map((p) => p.trim()).filter(Boolean);
  const variants: VariantLine[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const [rawLabel, rawStock, ...rest] = part.split(":");
    const label = rawLabel.trim().replace(/\s+/g, " ");
    if (!label || rest.length > 0) return { variants: [], error: `No se entiende "${part}". Escribí por ejemplo: Negro: 3, Marrón: 2` };
    let stock: number | null = null;
    if (rawStock !== undefined && rawStock.trim()) {
      // Por unidad: número entero (la coma separa variantes).
      stock = Number(rawStock.trim());
      if (!Number.isInteger(stock) || stock < 0) return { variants: [], error: `El stock de "${label}" no es un número entero.` };
    }
    const key = label.toLocaleLowerCase("es");
    if (seen.has(key)) return { variants: [], error: `"${label}" está dos veces.` };
    seen.add(key);
    variants.push({ label, stock });
  }
  if (variants.length === 1) return { variants: [], error: "Con una sola variante no hace falta: cargalo como un producto normal." };
  if (variants.length > 30) return { variants: [], error: "Máximo 30 variantes por vez." };
  return { variants, error: null };
}

export interface VariantProduct {
  code: string;
  name: string;
  stock: number | null;
}

export function variantProducts(code: string, name: string, variants: VariantLine[]): VariantProduct[] {
  const baseCode = code.trim();
  const baseName = name.trim();
  return variants.map((v, i) => ({ code: `${baseCode}-${i + 1}`, name: `${baseName} - ${v.label}`, stock: v.stock }));
}
