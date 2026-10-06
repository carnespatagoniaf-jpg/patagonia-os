import { recipeCost, type Product, type RecipeCostResult } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import type { Recipe, RecipeItem, SaveRecipeInput } from "./recipes-service";
import { quantityNumber } from "../sale/quantity";

// Lógica pura de la pantalla de Recetas (sin Supabase, para poder probarla con
// node --test): costo de una receta con el costo ACTUAL de cada insumo y si el
// costo cargado en el producto terminado quedó desactualizado.

export interface RecipeSummary {
  cost: RecipeCostResult;
  /** Insumos cuyo producto ya no existe o está inactivo (cuentan como costo 0). */
  missingIngredients: number;
  /** Insumos sin costo cargado (costo 0): el costo de la receta queda corto. */
  zeroCostIngredients: string[];
  /** Costo que tiene hoy cargado el producto terminado. */
  loadedCost: number;
  /** El costo cargado no coincide con lo que da la receta hoy (sube la carne y nadie actualizó). */
  drift: boolean;
}

export function summarizeRecipe(recipe: Recipe, productsById: Map<string, Product>): RecipeSummary {
  let missingIngredients = 0;
  const zeroCostIngredients: string[] = [];

  const cost = recipeCost({
    ingredients: recipe.items.map((item) => {
      const product = productsById.get(item.ingredientProductId);
      if (!product) {
        missingIngredients += 1;
        return { quantity: item.quantity, wastePct: item.wastePct, unitCost: 0 };
      }
      if (product.cost <= 0) zeroCostIngredients.push(product.name);
      return { quantity: item.quantity, wastePct: item.wastePct, unitCost: product.cost };
    }),
    extraCost: recipe.extraCost,
    yieldQty: recipe.yieldQty,
    marginPct: recipe.marginPct
  });

  const loadedCost = productsById.get(recipe.productId)?.cost ?? 0;
  const drift = cost.unitCost > 0 && Math.abs(loadedCost - cost.unitCost) >= 0.01;

  return { cost, missingIngredients, zeroCostIngredients, loadedCost, drift };
}

/** Suma de kilos NETOS de los insumos que se miden en kg: una sugerencia de
 * rinde para productos que se venden por kg (hamburguesas: 1 kg + 0,3 kg = 1,3 kg). */
export function suggestedYieldKg(
  items: Array<{ ingredientProductId: string; quantity: number }>,
  productsById: Map<string, Product>
): number {
  const total = items.reduce((sum, item) => {
    const product = productsById.get(item.ingredientProductId);
    return product?.unit === "kg" && Number.isFinite(item.quantity) ? sum + item.quantity : sum;
  }, 0);
  return Math.round(total * 1000) / 1000;
}

/** Costos con centavos: en recetas importan (una hamburguesa que cuesta $850,42
 * no es $850). El resto del sistema muestra pesos enteros; acá no. */
export function formatCost(value: number): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export interface RecipeDraft {
  productId: string;
  yieldQty: string;
  extraCost: string;
  marginPct: string;
  notes: string;
  items: Array<{ ingredientProductId: string; quantity: string; wastePct: string }>;
}

export type ParsedDraft = { ok: true; input: SaveRecipeInput } | { ok: false; error: string };

/** Valida lo que escribió la persona y lo convierte a números. Cantidades,
 * merma y margen son campos numéricos comunes (Number); solo el costo extra es
 * plata y usa parseAmount ("1.500,50"). Los mismos límites los vuelve a
 * chequear la base (save_recipe). */
export function parseRecipeDraft(draft: RecipeDraft): ParsedDraft {
  if (!draft.productId) return { ok: false, error: "Elegí el producto terminado." };

  const yieldQty = quantityNumber(draft.yieldQty);
  if (!Number.isFinite(yieldQty) || yieldQty <= 0) return { ok: false, error: "Poné cuánto rinde el lote (un número mayor que cero)." };

  if (draft.items.length === 0) return { ok: false, error: "Agregá al menos un insumo." };

  const items: RecipeItem[] = [];
  for (let i = 0; i < draft.items.length; i += 1) {
    const raw = draft.items[i];
    const quantity = quantityNumber(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: `Revisá la cantidad del insumo ${i + 1}: tiene que ser mayor que cero.` };
    const wastePct = raw.wastePct.trim() === "" ? 0 : Number(raw.wastePct);
    if (!Number.isFinite(wastePct) || wastePct < 0 || wastePct >= 100) return { ok: false, error: `Revisá la merma del insumo ${i + 1}: entre 0 y 99,99.` };
    items.push({ ingredientProductId: raw.ingredientProductId, quantity, wastePct });
  }

  const extraCost = draft.extraCost.trim() === "" ? 0 : parseAmount(draft.extraCost);
  if (!Number.isFinite(extraCost) || extraCost < 0) return { ok: false, error: "El costo extra no es válido." };

  let marginPct: number | null = null;
  if (draft.marginPct.trim() !== "") {
    marginPct = Number(draft.marginPct);
    if (!Number.isFinite(marginPct) || marginPct < 0) return { ok: false, error: "El margen no es válido." };
  }

  return { ok: true, input: { productId: draft.productId, yieldQty, extraCost, marginPct, notes: draft.notes.trim(), items } };
}
