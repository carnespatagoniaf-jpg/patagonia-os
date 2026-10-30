import { supabase } from "../../lib/supabase";

// Recetas (fichas técnicas): ver migración 097_recipes.sql. Lectura directa de
// las tablas (solo dueño y administrador pasan la política de seguridad) y todo
// lo que escribe va por funciones de la base.

export interface RecipeItem {
  ingredientProductId: string;
  /** Neto que queda en el producto terminado, en la unidad del insumo. */
  quantity: number;
  wastePct: number;
}

/** "combo": varios productos que se venden juntos (sin merma, rinde 1 combo). Ver migración 112. */
export type RecipeKind = "receta" | "combo";

export interface Recipe {
  id: string;
  kind: RecipeKind;
  productId: string;
  yieldQty: number;
  extraCost: number;
  marginPct: number | null;
  notes: string;
  items: RecipeItem[];
  /** Al venderlo, baja del stock los insumos de la receta. Ver migración 168. */
  deductOnSale: boolean;
  updatedAt: string;
}

interface RecipeRow {
  id: string;
  kind?: string | null;
  product_id: string;
  yield_qty: number | string;
  extra_cost: number | string;
  margin_pct: number | string | null;
  notes: string | null;
  deduct_on_sale?: boolean | null;
  updated_at: string;
}

interface RecipeItemRow {
  recipe_id: string;
  ingredient_product_id: string;
  quantity: number | string;
  waste_pct: number | string;
  position: number;
}

const PAGE = 1000;

export async function listRecipes(): Promise<Recipe[]> {
  if (!supabase) return [];

  const columns = "id,kind,product_id,yield_qty,extra_cost,margin_pct,notes,updated_at";
  const first = await supabase
    .from("recipes")
    .select(`${columns},deduct_on_sale`)
    .order("updated_at", { ascending: false });
  // Base sin la migración 168 todavía: se lee como antes (nadie descuenta al vender).
  const { data: rows, error } =
    first.error?.code === "42703" ? await supabase.from("recipes").select(columns).order("updated_at", { ascending: false }) : first;
  if (error) throw error;

  // Los insumos se traen paginados: PostgREST corta en 1000 filas.
  const itemRows: RecipeItemRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: itemsError } = await supabase
      .from("recipe_items")
      .select("recipe_id,ingredient_product_id,quantity,waste_pct,position")
      .order("recipe_id")
      .order("position")
      .range(from, from + PAGE - 1);
    if (itemsError) throw itemsError;
    itemRows.push(...((data ?? []) as RecipeItemRow[]));
    if (!data || data.length < PAGE) break;
  }

  const itemsByRecipe = new Map<string, RecipeItem[]>();
  for (const item of itemRows) {
    const list = itemsByRecipe.get(item.recipe_id) ?? [];
    list.push({ ingredientProductId: item.ingredient_product_id, quantity: Number(item.quantity), wastePct: Number(item.waste_pct) });
    itemsByRecipe.set(item.recipe_id, list);
  }

  return ((rows ?? []) as RecipeRow[]).map((row) => ({
    id: row.id,
    kind: row.kind === "combo" ? "combo" : "receta",
    productId: row.product_id,
    yieldQty: Number(row.yield_qty),
    extraCost: Number(row.extra_cost),
    marginPct: row.margin_pct === null ? null : Number(row.margin_pct),
    notes: row.notes ?? "",
    items: itemsByRecipe.get(row.id) ?? [],
    deductOnSale: row.deduct_on_sale === true,
    updatedAt: row.updated_at
  }));
}

export interface SaveRecipeInput {
  productId: string;
  yieldQty: number;
  extraCost: number;
  marginPct: number | null;
  notes: string;
  items: RecipeItem[];
}

export async function saveRecipe(input: SaveRecipeInput): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("save_recipe", {
    p_product_id: input.productId,
    p_yield_qty: input.yieldQty,
    p_extra_cost: input.extraCost,
    p_margin_pct: input.marginPct,
    p_notes: input.notes,
    p_items: input.items.map((item) => ({
      ingredient_product_id: item.ingredientProductId,
      quantity: item.quantity,
      waste_pct: item.wastePct
    }))
  });
  if (error) throw error;
  return data as string;
}

/** Marca una receta como combo (o la vuelve a receta). Se llama después de saveRecipe. */
export async function setRecipeKind(recipeId: string, kind: RecipeKind): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_recipe_kind", { p_recipe_id: recipeId, p_kind: kind });
  if (error) throw error;
}

/** Prende o apaga "al venderlo, descontar los insumos del stock". Se llama después de saveRecipe. */
export async function setRecipeDeductOnSale(recipeId: string, enabled: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_recipe_deduct_on_sale", { p_recipe_id: recipeId, p_enabled: enabled });
  if (error) throw error;
}

export async function deleteRecipe(recipeId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_recipe", { p_recipe_id: recipeId });
  if (error) throw error;
}

export interface AppliedRecipe {
  cost: number;
  price: number;
  batchCost: number;
}

/** Carga en el producto terminado el costo que da la receta hoy (lo calcula la
 * base con el costo actual de los insumos) y, si se manda `price`, su precio. */
export async function applyRecipeToProduct(recipeId: string, price: number | null): Promise<AppliedRecipe> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("apply_recipe_to_product", { p_recipe_id: recipeId, p_price: price });
  if (error) throw error;
  const row = data as { cost: number; price: number; batch_cost: number };
  return { cost: Number(row.cost), price: Number(row.price), batchCost: Number(row.batch_cost) };
}
