/**
 * Comparación automática: qué producto de Patagonia es cada producto de la balanza. Pura (sin balanza ni base).
 *
 * Reglas (en este orden):
 * 1. Lo que ya decidió una persona se respeta siempre ("keep"). Nunca se pisa un vínculo.
 * 2. Mismo código + nombre equivalente + misma forma de venta (kg / unidad) → se vincula solo.
 * 3. Sin producto con ese código: un ÚNICO producto con el nombre IDÉNTICO (normalizado) y la misma forma de venta
 *    → se vincula solo. Mismo nombre exacto no es "parecido": es la misma mercadería con otro número (otra lista).
 * 4. Todo lo demás queda para revisar, con una sugerencia si la hay. Nombres parecidos NUNCA vinculan solos.
 *
 * El precio no decide nada: solo se informa cuántos difieren.
 */

export interface MatchScaleItem {
  code: number;
  name: string;
  byWeight: boolean;
  /** Precio que tiene la balanza (lista 1), en pesos. */
  price?: number | null;
}

export interface MatchProduct {
  id: string;
  code: string;
  name: string;
  unit: string;
  priceRetail?: number | null;
  active?: boolean;
}

export interface ExistingLink {
  code: number;
  kind: "product" | "libre" | "none";
  productId: string | null;
}

export type PendingReason =
  | "codigo_de_otro_producto"
  | "forma_de_venta"
  | "sin_producto"
  | "nombre_parecido"
  | "varios_candidatos"
  | "codigo_duplicado_en_patagonia"
  | "producto_desactivado";

export type MatchDecision =
  | { kind: "keep"; code: number; link: ExistingLink }
  | { kind: "auto"; code: number; productId: string; why: "codigo_y_nombre" | "nombre_identico" }
  | { kind: "pending"; code: number; reason: PendingReason; suggestionId: string | null; detail: string };

export interface MatchResult {
  decisions: MatchDecision[];
  kept: number;
  auto: number;
  pending: number;
  /** Productos vinculados cuyo precio en la balanza no es el de Patagonia (solo informativo). */
  priceDiffs: number;
}

/** Mayúsculas, sin acentos, solo letras/números separados por un espacio. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * ¿Es el mismo nombre, teniendo en cuenta que la balanza lo corta (16 a 26 letras)? Sirve SOLO junto con el
 * mismo código: el código ya identifica el producto y el nombre lo confirma.
 */
export function namesEquivalent(scaleName: string, productName: string): boolean {
  const a = normalizeName(scaleName);
  const b = normalizeName(productName);
  if (!a || !b) return false;
  if (a === b) return true;
  // Cortado por la balanza: lo que tiene la balanza es el comienzo del nombre de Patagonia.
  if (a.length >= 8 && b.startsWith(a)) return true;
  // Todas las palabras de la balanza (de 2+ letras) están en Patagonia; la última puede venir cortada.
  const words = a.split(" ");
  const pw = b.split(" ");
  const useful = words.filter((w) => w.length >= 2);
  if (useful.length === 0) return false;
  return words.every((w, i) => w.length < 2 || pw.includes(w) || (i === words.length - 1 && pw.some((x) => x.startsWith(w))));
}

const unitMatches = (item: MatchScaleItem, p: MatchProduct) => item.byWeight === (p.unit === "kg");

export function matchScaleCatalog(items: MatchScaleItem[], products: MatchProduct[], existing: ExistingLink[] = []): MatchResult {
  const active = products.filter((p) => p.active ?? true);
  const byId = new Map(products.map((p) => [p.id, p]));
  const decisions: MatchDecision[] = [];
  let priceDiffs = 0;
  const priceDiffers = (item: MatchScaleItem, p: MatchProduct | undefined) =>
    !!p && !!item.price && !!p.priceRetail && Math.abs(item.price - p.priceRetail) >= 0.5;

  for (const item of items) {
    const prev = existing.find((l) => l.code === item.code);
    if (prev && prev.kind !== "none") {
      const p = prev.productId ? byId.get(prev.productId) : undefined;
      if (prev.kind === "product" && (!p || !(p.active ?? true))) {
        decisions.push({ kind: "pending", code: item.code, reason: "producto_desactivado", suggestionId: null, detail: "estaba vinculado a un producto que ya no está activo" });
        continue;
      }
      decisions.push({ kind: "keep", code: item.code, link: prev });
      if (priceDiffers(item, p)) priceDiffs++;
      continue;
    }

    const sameCode = active.filter((p) => p.code === String(item.code));
    const identical = active.filter((p) => normalizeName(p.name) === normalizeName(item.name) && unitMatches(item, p));

    if (sameCode.length > 1) {
      decisions.push({ kind: "pending", code: item.code, reason: "codigo_duplicado_en_patagonia", suggestionId: null, detail: `en Patagonia hay ${sameCode.length} productos con el código ${item.code}` });
      continue;
    }
    if (sameCode.length === 1) {
      const p = sameCode[0];
      const nameOk = namesEquivalent(item.name, p.name);
      if (nameOk && unitMatches(item, p)) {
        decisions.push({ kind: "auto", code: item.code, productId: p.id, why: "codigo_y_nombre" });
        if (priceDiffers(item, p)) priceDiffs++;
        continue;
      }
      if (nameOk) {
        decisions.push({ kind: "pending", code: item.code, reason: "forma_de_venta", suggestionId: null, detail: `en la balanza se vende ${item.byWeight ? "por kilo" : "por unidad"} y en Patagonia ${p.unit === "kg" ? "por kilo" : "por unidad"}` });
        continue;
      }
      decisions.push({
        kind: "pending",
        code: item.code,
        reason: "codigo_de_otro_producto",
        suggestionId: identical.length === 1 ? identical[0].id : null,
        detail: `en Patagonia el ${item.code} es "${p.name}"`
      });
      continue;
    }

    if (identical.length === 1) {
      decisions.push({ kind: "auto", code: item.code, productId: identical[0].id, why: "nombre_identico" });
      if (priceDiffers(item, identical[0])) priceDiffs++;
      continue;
    }
    if (identical.length > 1) {
      decisions.push({ kind: "pending", code: item.code, reason: "varios_candidatos", suggestionId: null, detail: `hay ${identical.length} productos con ese nombre en Patagonia` });
      continue;
    }
    const similar = active.filter((p) => unitMatches(item, p) && namesEquivalent(item.name, p.name));
    decisions.push(
      similar.length === 1
        ? { kind: "pending", code: item.code, reason: "nombre_parecido", suggestionId: similar[0].id, detail: `se parece a "${similar[0].name}"` }
        : { kind: "pending", code: item.code, reason: similar.length > 1 ? "varios_candidatos" : "sin_producto", suggestionId: null, detail: similar.length > 1 ? `se parece a ${similar.length} productos` : "no hay un producto así en Patagonia" }
    );
  }

  return {
    decisions,
    kept: decisions.filter((d) => d.kind === "keep").length,
    auto: decisions.filter((d) => d.kind === "auto").length,
    pending: decisions.filter((d) => d.kind === "pending").length,
    priceDiffs
  };
}
