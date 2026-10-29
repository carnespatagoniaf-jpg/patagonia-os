import { useCallback, useEffect, useMemo, useState } from "react";
import { marginPercent, recipeCost, type Product } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { parseAmount } from "../../lib/money";
import { useActiveBranch } from "../branches/BranchProvider";
import { createProduct, listProductsForBranch } from "../inventory/inventory-service";
import { applyRecipeToProduct, deleteRecipe, listRecipes, saveRecipe, setRecipeDeductOnSale, setRecipeKind, type Recipe, type RecipeKind } from "./recipes-service";
import { quantityNumber } from "../sale/quantity";
import { checkPrice, comboDiscountPct, comboRetailTotal, formatCost, type PriceCheck, parseRecipeDraft, suggestedYieldKg, summarizeRecipe, type RecipeDraft } from "./recipe-view";

// Recetas (fichas técnicas): milanesas, hamburguesas y demás productos que se
// arman con otros. Etapa 1: solo costeo -- calcula el costo por kg/unidad y un
// precio sugerido, y los carga en el producto. No toca el stock.
// Combos (2026-10-08, migración 112): varios productos que se venden juntos
// ("1 kg milanesa + 1 kg pata muslo + …"). Es una receta sin merma que rinde 1
// combo; además muestra cuánto saldría suelto y el descuento del combo.

const UNIT_LABEL: Record<Product["unit"], string> = { kg: "kg", unit: "unidades", box: "cajas" };
const UNIT_SHORT: Record<Product["unit"], string> = { kg: "kg", unit: "u.", box: "caja" };

const emptyDraft = (kind: RecipeKind = "receta"): RecipeDraft => ({ productId: "", yieldQty: kind === "combo" ? "1" : "", extraCost: "", marginPct: "", notes: "", items: [] });

function draftFromRecipe(recipe: Recipe): RecipeDraft {
  return {
    productId: recipe.productId,
    yieldQty: String(recipe.yieldQty),
    extraCost: recipe.extraCost ? String(recipe.extraCost).replace(".", ",") : "",
    marginPct: recipe.marginPct === null ? "" : String(recipe.marginPct),
    notes: recipe.notes,
    items: recipe.items.map((item) => ({ ingredientProductId: item.ingredientProductId, quantity: String(item.quantity), wastePct: item.wastePct ? String(item.wastePct) : "" }))
  };
}

/** Para buscar sin importar mayúsculas ni tildes: "vaci" encuentra "Vacío". */
function plain(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** "12,5% más barato que suelto" / "3% más caro que suelto". */
function discountText(pct: number): string {
  if (pct === 0) return "mismo precio que suelto";
  return pct > 0 ? `${fmtNum(pct, 1)}% más barato que suelto` : `${fmtNum(-pct, 1)}% más caro que suelto`;
}

/** "Ganás $5.700 por combo (29,5% sobre el costo) · 15% más barato que suelto". */
function PriceCheckText({ check, per }: { check: PriceCheck | null; per: string }) {
  if (!check) return <span className="muted">Escribí un precio y te digo cuánto ganás.</span>;
  const loses = check.profit < 0;
  return (
    <span style={{ color: loses ? "#8b1e1e" : "#176329", fontWeight: 700 }}>
      {loses ? `Perdés ${formatCost(-check.profit)} por ${per}` : `Ganás ${formatCost(check.profit)} por ${per}`}
      {check.marginPct !== null && ` (${fmtNum(check.marginPct, 1)}% sobre el costo)`}
      {check.discountPct !== null && <span className="muted" style={{ fontWeight: 400 }}> · {discountText(check.discountPct)}</span>}
    </span>
  );
}

/** Número con coma decimal argentina y hasta `max` decimales: 10,87 en vez de 10.87. */
function fmtNum(value: number, max = 3): string {
  return value.toLocaleString("es-AR", { maximumFractionDigits: max });
}

const num = (raw: string) => {
  const value = quantityNumber(raw);
  return Number.isFinite(value) ? value : 0;
};

function ProductPicker({ products, excludeIds, placeholder, onPick }: { products: Product[]; excludeIds: Set<string>; placeholder: string; onPick: (product: Product) => void }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = plain(query);
    if (!q) return [];
    return products.filter((p) => !excludeIds.has(p.id) && (plain(p.name).includes(q) || plain(p.code).includes(q))).slice(0, 8);
  }, [products, excludeIds, query]);

  return (
    <div className="pos-search-wrap">
      <input className="pos-search" placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
      {matches.length > 0 && (
        <div className="pos-dropdown">
          {matches.map((product) => (
            <button
              key={product.id}
              type="button"
              className="pos-dropdown-item"
              onClick={() => {
                onPick(product);
                setQuery("");
              }}
            >
              <span>
                {product.name} <span className="muted">({UNIT_LABEL[product.unit]})</span>
              </span>
              <strong>{product.cost > 0 ? formatCost(product.cost) : "sin costo"}</strong>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Recipes() {
  const { branchId } = useActiveBranch();
  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<{ recipeId: string | null; kind: RecipeKind; deductOnSale: boolean; draft: RecipeDraft } | null>(null);
  /** "Lo vendés a $": arranca con el precio de hoy del producto; si se cambia, se carga en el producto al guardar. */
  const [sellPrice, setSellPrice] = useState("");
  /** "Rinde el lote" sigue solo la suma de los kilos de los insumos hasta que la persona lo cambia (productos por kg). */
  const [yieldAuto, setYieldAuto] = useState(true);
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [npCode, setNpCode] = useState("");
  const [npName, setNpName] = useState("");
  const [npUnit, setNpUnit] = useState<Product["unit"]>("kg");

  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured || !branchId) return;
    setLoading(true);
    setError(null);
    try {
      const [loadedProducts, loadedRecipes] = await Promise.all([listProductsForBranch(branchId), listRecipes()]);
      setProducts(loadedProducts);
      setRecipes(loadedRecipes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las recetas.");
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const draft = editing?.draft ?? null;
  const finished = draft ? productsById.get(draft.productId) : undefined;
  const usedIds = useMemo(() => new Set(draft?.items.map((item) => item.ingredientProductId) ?? []), [draft]);
  const recipeProductIds = useMemo(() => new Set(recipes.map((r) => r.productId)), [recipes]);

  const preview = useMemo(() => {
    if (!draft) return null;
    return recipeCost({
      ingredients: draft.items.map((item) => ({
        quantity: num(item.quantity),
        wastePct: num(item.wastePct),
        unitCost: productsById.get(item.ingredientProductId)?.cost ?? 0
      })),
      extraCost: draft.extraCost.trim() === "" ? 0 : parseAmount(draft.extraCost) || 0,
      yieldQty: num(draft.yieldQty),
      marginPct: draft.marginPct.trim() === "" ? null : num(draft.marginPct)
    });
  }, [draft, productsById]);

  // Al elegir (o cambiar) el producto terminado, "Lo vendés a" arranca con su precio de hoy.
  const finishedId = finished?.id;
  useEffect(() => {
    const price = finishedId ? productsById.get(finishedId)?.priceRetail ?? 0 : 0;
    setSellPrice(price > 0 ? String(price).replace(".", ",") : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedId]);

  function updateDraft(patch: Partial<RecipeDraft>) {
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));
  }

  function updateItem(index: number, patch: Partial<RecipeDraft["items"][number]>) {
    setEditing((current) => {
      if (!current) return current;
      const items = current.draft.items.map((item, i) => (i === index ? { ...item, ...patch } : item));
      return { ...current, draft: { ...current.draft, items } };
    });
  }

  function removeItem(index: number) {
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, items: current.draft.items.filter((_, i) => i !== index) } } : current));
  }

  function startNew(kind: RecipeKind = "receta") {
    setMessage("");
    setYieldAuto(kind !== "combo");
    setNpUnit(kind === "combo" ? "unit" : "kg");
    setEditing({ recipeId: null, kind, deductOnSale: false, draft: emptyDraft(kind) });
  }

  function startEdit(recipe: Recipe) {
    setMessage("");
    const sum = suggestedYieldKg(recipe.items, productsById);
    setYieldAuto(recipe.kind === "receta" && productsById.get(recipe.productId)?.unit === "kg" && Math.abs(sum - recipe.yieldQty) < 0.0005);
    setEditing({ recipeId: recipe.id, kind: recipe.kind, deductOnSale: recipe.deductOnSale, draft: draftFromRecipe(recipe) });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeEditor() {
    setEditing(null);
    setShowNewProduct(false);
  }

  async function handleCreateProduct() {
    if (!branchId) return;
    if (!npCode.trim() || !npName.trim()) {
      setMessage("Poné el código (PLU) y el nombre del producto nuevo.");
      return;
    }
    if (!isSupabaseConfigured) {
      setMessage("En modo demo no se pueden crear productos nuevos: elegí uno de la lista.");
      return;
    }
    setBusy(true);
    try {
      const { id } = await createProduct({ branchId, code: npCode.trim(), name: npName.trim(), unit: npUnit, cost: 0, priceRetail: 0, minStock: 0 });
      await reload();
      updateDraft({ productId: id });
      setShowNewProduct(false);
      setNpCode("");
      setNpName("");
      setMessage(`Producto "${npName.trim()}" creado. Ahora cargá su receta.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el producto.");
    } finally {
      setBusy(false);
    }
  }

  /** Guarda la receta que se está editando y devuelve su id (o null si algo falló). */
  async function persist(): Promise<string | null> {
    if (!editing) return null;
    const isCombo = editing.kind === "combo";
    // Un combo no tiene merma y rinde 1 combo: se fuerza acá para que el costeo sea el de siempre.
    const parsed = parseRecipeDraft(isCombo ? { ...editing.draft, yieldQty: "1", items: editing.draft.items.map((item) => ({ ...item, wastePct: "" })) } : editing.draft);
    if (!parsed.ok) {
      setMessage(parsed.error);
      return null;
    }
    if (!isSupabaseConfigured) {
      // Modo demo: se guarda solo en esta pantalla, sin base de datos.
      const id = editing.recipeId ?? `demo-${parsed.input.productId}`;
      const saved: Recipe = { id, kind: editing.kind, deductOnSale: editing.deductOnSale, ...parsed.input, updatedAt: new Date().toISOString() };
      setRecipes((current) => [saved, ...current.filter((r) => r.id !== id)]);
      setEditing((current) => (current ? { ...current, recipeId: id } : current));
      return id;
    }
    const id = await saveRecipe(parsed.input);
    const previous = recipes.find((r) => r.id === id);
    if (editing.kind !== (previous?.kind ?? "receta")) await setRecipeKind(id, editing.kind);
    if (editing.deductOnSale !== (previous?.deductOnSale ?? false)) await setRecipeDeductOnSale(id, editing.deductOnSale);
    setRecipes(await listRecipes());
    setEditing((current) => (current ? { ...current, recipeId: id } : current));
    return id;
  }

  async function handleSave() {
    setMessage("");
    setBusy(true);
    try {
      const id = await persist();
      if (id) setMessage(editing?.kind === "combo" ? "Combo guardado." : "Receta guardada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar la receta.");
    } finally {
      setBusy(false);
    }
  }

  async function applyToProduct(recipeId: string, price: number | null, unitCostForDemo: number) {
    if (!isSupabaseConfigured) {
      const recipe = recipes.find((r) => r.id === recipeId);
      setProducts((current) => current.map((p) => (p.id === recipe?.productId ? { ...p, cost: unitCostForDemo, priceRetail: price ?? p.priceRetail } : p)));
      return { cost: unitCostForDemo, price: price ?? 0 };
    }
    const result = await applyRecipeToProduct(recipeId, price);
    await reload();
    return result;
  }

  /** Guarda la receta y deja el producto con el costo de la receta; el precio solo si se cambió "Lo vendés a". */
  async function handleSaveAndApply() {
    if (!finished) return;
    const price = parseAmount(sellPrice);
    const priceChanged = Number.isFinite(price) && price > 0 && Math.abs(price - finished.priceRetail) >= 0.005;
    setMessage("");
    setBusy(true);
    try {
      const id = await persist();
      if (!id || !preview) return;
      const result = await applyToProduct(id, priceChanged ? price : null, preview.unitCost);
      setMessage(
        priceChanged
          ? `Listo: ${finished.name} ahora cuesta ${formatCost(result.cost)} y se vende a ${formatCost(result.price)}.`
          : `Listo: el costo de ${finished.name} ahora es ${formatCost(result.cost)} (el precio sigue igual).`
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  async function handleQuickUpdate(recipe: Recipe) {
    const summary = summarizeRecipe(recipe, productsById);
    const product = productsById.get(recipe.productId);
    if (!product) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await applyToProduct(recipe.id, null, summary.cost.unitCost);
      setMessage(`${product.name}: costo actualizado a ${formatCost(result.cost)}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo actualizar.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateAllCosts() {
    const outdated = recipes.filter((r) => summarizeRecipe(r, productsById).drift);
    if (outdated.length === 0) return;
    if (!window.confirm(`Se va a actualizar el COSTO de ${outdated.length} producto(s) con lo que dan hoy sus recetas. Los precios de venta no se tocan. ¿Seguimos?`)) return;
    setBusy(true);
    setMessage("");
    try {
      for (const recipe of outdated) {
        await applyToProduct(recipe.id, null, summarizeRecipe(recipe, productsById).cost.unitCost);
      }
      setMessage(`Se actualizó el costo de ${outdated.length} producto(s).`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron actualizar todos.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(recipe: Recipe) {
    const name = productsById.get(recipe.productId)?.name ?? "este producto";
    const what = recipe.kind === "combo" ? "el combo" : "la receta de";
    if (!window.confirm(`¿Borrar ${what} ${name}? El producto y su costo actual no se tocan.`)) return;
    setBusy(true);
    try {
      if (isSupabaseConfigured) {
        await deleteRecipe(recipe.id);
        setRecipes(await listRecipes());
      } else {
        setRecipes((current) => current.filter((r) => r.id !== recipe.id));
      }
      if (editing?.recipeId === recipe.id) closeEditor();
      setMessage(recipe.kind === "combo" ? "Combo borrado." : "Receta borrada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo borrar la receta.");
    } finally {
      setBusy(false);
    }
  }

  const summaries = useMemo(() => recipes.map((recipe) => ({ recipe, summary: summarizeRecipe(recipe, productsById) })), [recipes, productsById]);
  const outdatedCount = summaries.filter((s) => s.summary.drift).length;
  const unitLabel = finished ? UNIT_LABEL[finished.unit] : "";
  const yieldSuggestion = draft && finished?.unit === "kg" ? suggestedYieldKg(draft.items.map((item) => ({ ingredientProductId: item.ingredientProductId, quantity: num(item.quantity) })), productsById) : 0;
  const currentMargin = finished && finished.cost > 0 ? marginPercent(finished.cost, finished.priceRetail) : null;
  const isCombo = editing?.kind === "combo";
  // La merma no se pide más (2026-10-27, dueño: "mucha info al pedo"); se muestra solo si la receta ya tiene alguna.
  const showWaste = !isCombo && !!draft?.items.some((item) => num(item.wastePct) > 0);
  const comboRetail = draft && isCombo ? comboRetailTotal(draft.items.map((item) => ({ ingredientProductId: item.ingredientProductId, quantity: num(item.quantity) })), productsById) : 0;
  const comboCurrentDiscount = finished && isCombo ? comboDiscountPct(finished.priceRetail, comboRetail) : null;
  const yieldIsAuto = yieldAuto && !isCombo && finished?.unit === "kg";
  // Rinde automático = lo que suman los insumos en kg (1 kg de suprema + 1 kg de pan rallado = 2 kg).
  useEffect(() => {
    if (!yieldIsAuto || !draft) return;
    const auto = yieldSuggestion > 0 ? String(yieldSuggestion).replace(".", ",") : "";
    if (draft.yieldQty !== auto) updateDraft({ yieldQty: auto });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yieldIsAuto, yieldSuggestion]);
  // Insumos y rinde muy distintos (ej. 0,05 kg de insumos que "rinden" 1 kg): casi siempre es un error de tipeo.
  const yieldValue = draft ? num(draft.yieldQty) : 0;
  const yieldLooksWrong = !yieldIsAuto && !isCombo && finished?.unit === "kg" && yieldSuggestion > 0 && yieldValue > 0
    && (yieldValue > yieldSuggestion * 1.5 || yieldValue < yieldSuggestion * 0.5);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">PRODUCTO Y STOCK</p>
          <h1>Recetas</h1>
          <p className="muted">
            Armá milanesas, chorizos, hamburguesas y otros productos con sus insumos y lo que rinde el lote, o combos de varios productos: el sistema calcula el costo real y cuánto ganás.
          </p>
        </div>
        {!editing && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => startNew("receta")}>+ Nueva receta</button>
            <button className="secondary" onClick={() => startNew("combo")}>+ Nuevo combo</button>
          </div>
        )}
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      {editing && draft && preview && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-title">
            <h2>{isCombo ? (editing.recipeId ? "Editar combo" : "Nuevo combo") : editing.recipeId ? "Editar receta" : "Nueva receta"}</h2>
            <button className="secondary" onClick={closeEditor}>Cerrar</button>
          </div>

          <p className="pos-section-label">{isCombo ? "1. El combo (el producto que vas a vender)" : "1. Producto terminado"}</p>
          {finished ? (
            <p style={{ margin: "0 0 14px" }}>
              <strong>{finished.name}</strong> <span className="muted">({UNIT_LABEL[finished.unit]} · código {finished.code})</span>{" "}
              {!editing.recipeId && <button className="secondary" onClick={() => updateDraft({ productId: "" })}>Cambiar</button>}
            </p>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <ProductPicker
                products={products.filter((p) => !recipeProductIds.has(p.id))}
                excludeIds={new Set()}
                placeholder={isCombo ? "Buscá el producto del combo (ej. Combo familiar)…" : "Buscá el producto que vas a elaborar (ej. Milanesa)…"}
                onPick={(product) => updateDraft({ productId: product.id })}
              />
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
                ¿No existe todavía?{" "}
                <button className="secondary" onClick={() => setShowNewProduct((v) => !v)}>{showNewProduct ? "Cancelar" : "+ Crear el producto"}</button>
              </p>
              {showNewProduct && (
                <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 8 }}>
                  <input placeholder="Código (PLU)" value={npCode} onChange={(e) => setNpCode(e.target.value)} style={{ width: 130 }} />
                  <input placeholder={isCombo ? "Nombre (ej. Combo familiar)" : "Nombre (ej. Milanesa de nalga)"} value={npName} onChange={(e) => setNpName(e.target.value)} style={{ width: 240 }} />
                  <select value={npUnit} onChange={(e) => setNpUnit(e.target.value as Product["unit"])}>
                    <option value="kg">Se vende por kg</option>
                    <option value="unit">Se vende por unidad</option>
                  </select>
                  <button disabled={busy} onClick={() => void handleCreateProduct()}>Crear producto</button>
                </div>
              )}
            </div>
          )}

          {finished && (
            <>
              <p className="pos-section-label">{isCombo ? "2. Qué lleva el combo" : "2. Insumos (lo que lleva un lote)"}</p>
              <ProductPicker
                products={products.filter((p) => p.id !== finished.id)}
                excludeIds={usedIds}
                placeholder={isCombo ? "Agregar producto: buscá por nombre o código (ej. Pata muslo)…" : "Agregar insumo: buscá por nombre o código (ej. Nalga, Huevo)…"}
                onPick={(product) => updateDraft({ items: [...draft.items, { ingredientProductId: product.id, quantity: "", wastePct: "" }] })}
              />

              {draft.items.length > 0 && (
                <table className="data-table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>{isCombo ? "Producto" : "Insumo"}</th>
                      <th className="num">{isCombo ? "Cantidad" : "Cantidad que lleva"}</th>
                      {isCombo && <th className="num">Suelto sale</th>}
                      {showWaste && <th className="num">Merma %</th>}
                      {showWaste && <th className="num">Hay que comprar</th>}
                      <th className="num">Costo</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.items.map((item, index) => {
                      const product = productsById.get(item.ingredientProductId);
                      const line = preview.lines[index];
                      return (
                        <tr key={item.ingredientProductId}>
                          <td>
                            {product?.name ?? "Insumo no encontrado"}{" "}
                            <span className="muted">
                              {product ? (product.cost > 0 ? `· ${formatCost(product.cost)}/${UNIT_SHORT[product.unit]}` : "· sin costo cargado") : ""}
                            </span>
                          </td>
                          <td className="num">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={item.quantity}
                              onChange={(e) => updateItem(index, { quantity: e.target.value })}
                              style={{ width: 90, textAlign: "right" }}
                            />{" "}
                            {product ? UNIT_SHORT[product.unit] : ""}
                          </td>
                          {isCombo && (
                            <td className="num">{product && num(item.quantity) > 0 ? formatCost(num(item.quantity) * product.priceRetail) : "-"}</td>
                          )}
                          {showWaste && (
                            <>
                              <td className="num">
                                <input
                                  type="number"
                                  min="0"
                                  max="99.99"
                                  step="0.1"
                                  placeholder="0"
                                  value={item.wastePct}
                                  onChange={(e) => updateItem(index, { wastePct: e.target.value })}
                                  style={{ width: 70, textAlign: "right" }}
                                />
                              </td>
                              <td className="num">{line && num(item.quantity) > 0 ? `${fmtNum(line.grossQuantity)} ${product ? UNIT_SHORT[product.unit] : ""}` : "-"}</td>
                            </>
                          )}
                          <td className="num">{line ? formatCost(line.cost) : "-"}</td>
                          <td>
                            <button className="pos-remove-btn" onClick={() => removeItem(index)} aria-label="Quitar insumo" title="Quitar">×</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {draft.items.length === 0 && <p className="muted" style={{ marginTop: 8 }}>{isCombo ? "Todavía no agregaste productos." : "Todavía no agregaste insumos."}</p>}

              <p className="pos-section-label" style={{ marginTop: 18 }}>{isCombo ? "3. Otros costos" : "3. Rinde y otros costos"}</p>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
                {!isCombo && (
                  <label className="muted">
                    Rinde el lote ({unitLabel})
                    <br />
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft.yieldQty}
                      onChange={(e) => {
                        setYieldAuto(false);
                        updateDraft({ yieldQty: e.target.value });
                      }}
                      style={{ width: 130 }}
                    />
                  </label>
                )}
                <label className="muted">
                  {isCombo ? "Bolsa, bandeja u otros $" : "Otros costos del lote $ (packaging, mano de obra)"}
                  <br />
                  <input type="text" inputMode="decimal" placeholder="0" value={draft.extraCost} onChange={(e) => updateDraft({ extraCost: e.target.value })} style={{ width: 170 }} />
                </label>
              </div>
              {yieldIsAuto && yieldSuggestion > 0 && (
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
                  Rinde = lo que suman los insumos ({fmtNum(yieldSuggestion)} kg). Si al final sale otra cantidad, cambialo.
                </p>
              )}
              {!yieldIsAuto && !isCombo && finished.unit === "kg" && yieldSuggestion > 0 && Math.abs(yieldValue - yieldSuggestion) >= 0.0005 && (
                <p className={yieldLooksWrong ? "message warning" : "muted"} style={{ margin: "8px 0 0", fontSize: 13 }}>
                  {yieldLooksWrong
                    ? `Ponés ${fmtNum(yieldSuggestion)} kg de insumos y rinde ${fmtNum(yieldValue)} kg: revisá las cantidades. `
                    : `Los insumos suman ${fmtNum(yieldSuggestion)} kg. `}
                  <button className="secondary" onClick={() => setYieldAuto(true)}>Usar la suma ({fmtNum(yieldSuggestion)} kg)</button>
                </p>
              )}
              <textarea
                placeholder={isCombo ? "Notas (opcional): qué días se ofrece, para quién…" : "Notas (opcional): cómo se prepara, quién la hace…"}
                value={draft.notes}
                onChange={(e) => updateDraft({ notes: e.target.value })}
                style={{ width: "100%", marginTop: 10, minHeight: 50, padding: 10, border: "1px solid #d6dce5", borderRadius: 10, fontFamily: "inherit" }}
              />

              <div className="pos-adjust-card" style={{ marginTop: 10 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 700 }}>
                  <input
                    type="checkbox"
                    checked={editing.deductOnSale}
                    onChange={(e) => setEditing((current) => (current ? { ...current, deductOnSale: e.target.checked } : current))}
                    style={{ marginTop: 3 }}
                  />
                  {isCombo ? "Al vender el combo, descontar del stock los productos que lleva" : "Al venderlo, descontar del stock los insumos de la receta"}
                </label>
                <p className="muted" style={{ margin: "6px 0 0 24px", fontSize: 13 }}>
                  {isCombo
                    ? "Cada combo vendido en Mostrador o entregado a cuenta baja lo que lleva de cada producto."
                    : "Cada kilo o unidad vendida en Mostrador o entregada a cuenta baja lo que lleva de cada insumo según la receta. No hace falta cargar lo que se elaboró."}{" "}
                  Si se anula la venta, vuelve al stock. Se guarda con el botón de abajo.
                </p>
              </div>

              <div className="recipe-summary">
                {isCombo ? (
                  <>
                    <div>
                      <span className="muted">Costo del combo</span>
                      <strong>{preview.unitCost > 0 ? formatCost(preview.unitCost) : "-"}</strong>
                    </div>
                    <div>
                      <span className="muted">Suelto saldría</span>
                      <strong>{comboRetail > 0 ? formatCost(comboRetail) : "-"}</strong>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <span className="muted">Costo del lote</span>
                      <strong>{formatCost(preview.batchCost)}</strong>
                    </div>
                    <div>
                      <span className="muted">Costo por {finished.unit === "unit" ? "unidad" : finished.unit === "box" ? "caja" : "kg"}</span>
                      <strong>{preview.unitCost > 0 ? formatCost(preview.unitCost) : "-"}</strong>
                    </div>
                  </>
                )}
                <div>
                  <span className="muted">Hoy en el producto</span>
                  <strong>
                    {formatCost(finished.cost)} → {formatCost(finished.priceRetail)}
                  </strong>
                  {currentMargin !== null && <span className="muted">margen actual {fmtNum(currentMargin, 1)}%</span>}
                  {comboCurrentDiscount !== null && <span className="muted">{discountText(comboCurrentDiscount)}</span>}
                </div>
              </div>
              <div className="pos-adjust-card" style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ fontWeight: 700 }}>
                  Lo vendés a ${" "}
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="ej. 13000"
                    value={sellPrice}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setSellPrice(e.target.value)}
                    style={{ width: 140 }}
                  />
                </label>
                <PriceCheckText check={checkPrice(parseAmount(sellPrice), preview.unitCost, isCombo ? comboRetail : 0)} per={isCombo ? "combo" : finished.unit === "kg" ? "kg" : finished.unit === "box" ? "caja" : "unidad"} />
              </div>
              {draft.items.some((item) => (productsById.get(item.ingredientProductId)?.cost ?? 0) <= 0) && (
                <div className="message warning" style={{ marginTop: 10 }}>
                  {isCombo ? "Hay productos sin costo cargado: el costo del combo queda corto." : "Hay insumos sin costo cargado: el costo de la receta queda corto."} Cargá su costo en Stock o con una compra.
                </div>
              )}

              {(() => {
                const price = parseAmount(sellPrice);
                const priceChanged = Number.isFinite(price) && price > 0 && Math.abs(price - finished.priceRetail) >= 0.005;
                return (
                  <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
                    <button disabled={busy || preview.unitCost <= 0} onClick={() => void handleSaveAndApply()}>
                      {busy ? "Guardando…" : priceChanged ? "Guardar y actualizar costo y precio" : "Guardar y actualizar el costo"}
                    </button>
                    <button className="secondary" disabled={busy} onClick={() => void handleSave()}>{isCombo ? "Guardar solo el combo" : "Guardar solo la receta"}</button>
                    {preview.unitCost > 0 && (
                      <span className="muted" style={{ fontSize: 13 }}>
                        {finished.name} queda con costo {formatCost(preview.unitCost)}
                        {priceChanged ? ` y precio ${formatCost(price)}` : " (el precio no cambia)"}.
                      </span>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-title">
          <h2>Recetas cargadas <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}>{loading ? "Cargando…" : recipes.length}</span></h2>
        </div>

        {outdatedCount > 0 && (
          <div className="message warning" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <span>
              {outdatedCount === 1 ? "1 receta tiene" : `${outdatedCount} recetas tienen`} el costo desactualizado: los insumos cambiaron de precio y el producto todavía tiene el costo viejo.
            </span>
            <button disabled={busy} onClick={() => void handleUpdateAllCosts()}>Actualizar todos los costos</button>
          </div>
        )}

        {recipes.length === 0 && !loading && (
          <p className="muted">
            Todavía no cargaste ninguna receta. Tocá <strong>+ Nueva receta</strong> y probá con tus milanesas o hamburguesas, o <strong>+ Nuevo combo</strong> para armar un combo de varios productos.
          </p>
        )}

        {recipes.length > 0 && (
          <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num hide-md">Rinde</th>
                <th className="num hide-sm" title="Lo que cuesta hacerla hoy, con los precios actuales de los insumos">Costo hoy</th>
                <th className="num hide-md" title="El costo que tiene hoy el producto en Stock">Costo cargado</th>
                <th className="num">Venta</th>
                <th className="num">Margen</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {summaries.map(({ recipe, summary }) => {
                const product = productsById.get(recipe.productId);
                const margin = product && product.cost > 0 ? marginPercent(product.cost, product.priceRetail) : null;
                return (
                  <tr key={recipe.id}>
                    <td>
                      {recipe.kind === "combo" && <span className="badge brand" style={{ marginRight: 6 }}>Combo</span>}
                      <strong>{product?.name ?? "Producto no encontrado"}</strong>{" "}
                      <span className="muted" style={{ fontSize: 12 }}>({recipe.items.length} {recipe.kind === "combo" ? "productos" : "insumos"})</span>
                      {recipe.deductOnSale && <div className="muted" style={{ fontSize: 12 }}>Baja el stock al vender</div>}
                      {recipe.kind === "combo" && product && (() => {
                        const suelto = comboRetailTotal(recipe.items, productsById);
                        const discount = comboDiscountPct(product.priceRetail, suelto);
                        return suelto > 0 ? (
                          <div className="muted" style={{ fontSize: 12 }}>
                            Suelto: {formatCost(suelto)}{discount !== null ? ` · ${discountText(discount)}` : ""}
                          </div>
                        ) : null;
                      })()}
                    </td>
                    <td className="num hide-md">{recipe.kind === "combo" ? "1 combo" : `${fmtNum(recipe.yieldQty)} ${product ? UNIT_SHORT[product.unit] : ""}`}</td>
                    <td className="num hide-sm">{summary.cost.unitCost > 0 ? formatCost(summary.cost.unitCost) : "-"}</td>
                    <td className="num hide-md">{product ? formatCost(summary.loadedCost) : "-"}</td>
                    <td className="num">{product ? formatCost(product.priceRetail) : "-"}</td>
                    <td className="num">{margin !== null ? `${fmtNum(margin, 1)}%` : "-"}</td>
                    <td>
                      {summary.zeroCostIngredients.length > 0 || summary.missingIngredients > 0 ? (
                        <span className="badge danger">Insumos sin costo</span>
                      ) : summary.drift ? (
                        <span className="badge warn">Costo desactualizado</span>
                      ) : (
                        <span className="badge ok">Al día</span>
                      )}
                      {summary.drift && (
                        <span className="cell-sub">
                          <button className="link-button" style={{ fontSize: 12 }} disabled={busy} onClick={() => void handleQuickUpdate(recipe)}>Actualizar costo</button>
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button className="secondary" disabled={busy} onClick={() => startEdit(recipe)}>Editar</button>
                        <button className="danger" disabled={busy} onClick={() => void handleDelete(recipe)}>Borrar</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </>
  );
}
