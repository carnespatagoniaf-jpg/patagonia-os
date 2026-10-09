import { Fragment, useEffect, useState } from "react";
import type { Product } from "@patagonia/domain";
import { marginPercent, priceFromMargin } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";
import { adjustProductStock, createProduct, listProductsForBranch, setProductStockSource, updateProduct } from "./inventory-service";
import {
  createProductCategory,
  deleteProductCategory,
  listProductCategories,
  reorderProductCategory,
  updateProductCategory,
  type ProductCategory
} from "./product-categories-service";
import { parseAmount } from "../../lib/money";
import { downloadScaleExportCsv } from "./scale-export";
import { ScaleSyncPanel } from "./ScaleSyncPanel";
import { SystelPanel } from "./systel/SystelPanel";

/** Balanzas Systel: módulo nuevo, oculto hasta que el dueño autorice publicarlo. */
const SHOW_SYSTEL_PANEL = false;
/** Prueba piloto (2026-10-09, autorizada por el dueño): Los gringos tiene una Cuora Max. Solo esa empresa ve el panel. */
const SYSTEL_PILOT_COMPANIES = new Set(["a2660765-99a4-4945-84a1-803b8913a71f"]);
import { PriceTools } from "./PriceTools";
import { quantityNumber } from "../sale/quantity";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

const UNIT_LABELS: Record<Product["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

interface DraftProduct {
  code: string;
  name: string;
  unit: Product["unit"];
  cost: string;
  margin: string;
  priceRetail: string;
  minStock: string;
  active: boolean;
  categoryId: string;
}

function emptyDraft(): DraftProduct {
  return { code: "", name: "", unit: "kg", cost: "", margin: "", priceRetail: "", minStock: "", active: true, categoryId: "" };
}

/** Bloque "Stock" de la ficha: stock propio o descuenta de otro producto (el principal). */
interface DraftLink {
  linked: boolean;
  sourceId: string;
  factor: string;
  moveStock: boolean;
}

function draftLinkFromProduct(p: Product): DraftLink {
  return {
    linked: Boolean(p.stockSourceId),
    sourceId: p.stockSourceId ?? "",
    factor: String(p.stockFactor ?? 1).replace(".", ","),
    moveStock: true
  };
}

/** Para buscar sin importar acentos ni mayúsculas ("cajon" encuentra "Cajón"). */
function plainText(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function formatQty(value: number) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(value);
}

function draftFromProduct(p: Product): DraftProduct {
  return {
    code: p.code,
    name: p.name,
    unit: p.unit,
    cost: String(p.cost),
    margin: String(marginPercent(p.cost, p.priceRetail)),
    priceRetail: String(p.priceRetail),
    minStock: String(p.minStock),
    active: p.active ?? true,
    categoryId: p.categoryId ?? ""
  };
}

export function Inventory() {
  const { branchId } = useActiveBranch();
  const { profile } = useAuth();

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");

  const [showNewForm, setShowNewForm] = useState(false);
  const [newDraft, setNewDraft] = useState<DraftProduct>(emptyDraft());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftProduct>(emptyDraft());
  const [editLink, setEditLink] = useState<DraftLink>({ linked: false, sourceId: "", factor: "1", moveStock: true });

  // Panel "Presentaciones" de un producto principal.
  const [presentationsOfId, setPresentationsOfId] = useState<string | null>(null);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkSelected, setLinkSelected] = useState<Record<string, string>>({});
  const [linkMoveStock, setLinkMoveStock] = useState(true);
  const [linkBusy, setLinkBusy] = useState(false);

  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustCounted, setAdjustCounted] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);
  const [renameCategoryName, setRenameCategoryName] = useState("");


  async function reload() {
    if (!isSupabaseConfigured || !branchId) return;
    setLoading(true);
    try {
      setProducts(await listProductsForBranch(branchId, true));
    } finally {
      setLoading(false);
    }
  }

  async function reloadCategories() {
    if (!isSupabaseConfigured) return;
    setCategories(await listProductCategories());
  }

  useEffect(() => {
    void reload();
    void reloadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  function categoryName(categoryId: string | undefined) {
    if (!categoryId) return "—";
    return categories.find((c) => c.id === categoryId)?.name ?? "—";
  }

  // Buscador: por nombre o código, sin importar acentos ni mayúsculas; se suma al filtro de categoría.
  const searchText = plainText(productSearch);
  const visibleProducts = products.filter(
    (p) =>
      (!categoryFilter || p.categoryId === categoryFilter) &&
      (!searchText || plainText(p.name).includes(searchText) || plainText(p.code).includes(searchText))
  );

  const productById = new Map(products.map((p) => [p.id, p]));
  function presentationsOf(principalId: string) {
    return products.filter((p) => p.stockSourceId === principalId);
  }
  /** Puede ser principal: no es presentación de otro y está activo. */
  function sourceOptionsFor(product: Product) {
    return products
      .filter((p) => p.id !== product.id && !p.stockSourceId && (p.active ?? true))
      .sort(compareByCode);
  }
  /** Si las unidades difieren (cajón vs kg) hay que decir cuánto descuenta cada unidad. */
  function needsFactor(unit: Product["unit"], source: Product | undefined) {
    return Boolean(source) && source!.unit !== unit;
  }

  function compareByCode(a: Product, b: Product) {
    const na = Number(a.code);
    const nb = Number(b.code);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.code.localeCompare(b.code);
  }

  const productsByCategory = new Map<string, Product[]>();
  const productsWithoutCategory: Product[] = [];
  for (const product of visibleProducts) {
    if (product.categoryId) {
      const group = productsByCategory.get(product.categoryId) ?? [];
      group.push(product);
      productsByCategory.set(product.categoryId, group);
    } else {
      productsWithoutCategory.push(product);
    }
  }
  const groupedProducts: { key: string; label: string; products: Product[] }[] = categories
    .map((c) => ({ key: c.id, label: c.name, products: (productsByCategory.get(c.id) ?? []).sort(compareByCode) }))
    .filter((g) => g.products.length > 0);
  if (productsWithoutCategory.length > 0) {
    groupedProducts.push({ key: "sin-categoria", label: "Sin categoría", products: productsWithoutCategory.sort(compareByCode) });
  }

  async function handleCreateCategory() {
    try {
      if (!newCategoryName.trim()) throw new Error("Ingresá un nombre.");
      await createProductCategory(newCategoryName.trim());
      setNewCategoryName("");
      await reloadCategories();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear la categoría.");
    }
  }

  function startRenameCategory(category: ProductCategory) {
    setRenamingCategoryId(category.id);
    setRenameCategoryName(category.name);
  }

  async function handleRenameCategory() {
    try {
      if (!renamingCategoryId || !renameCategoryName.trim()) return;
      await updateProductCategory(renamingCategoryId, renameCategoryName.trim());
      setRenamingCategoryId(null);
      await reloadCategories();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo renombrar la categoría.");
    }
  }

  async function handleMoveCategory(category: ProductCategory, direction: "up" | "down") {
    try {
      await reorderProductCategory(category.id, direction);
      await reloadCategories();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo reordenar la categoría.");
    }
  }

  async function handleDeleteCategory(category: ProductCategory) {
    if (!window.confirm(`¿Seguro que querés borrar la categoría "${category.name}"?`)) return;
    try {
      await deleteProductCategory(category.id);
      await reloadCategories();
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo borrar la categoría.");
    }
  }

  function onCostOrMarginChange(draft: DraftProduct, setDraft: (d: DraftProduct) => void, field: "cost" | "margin") {
    return (value: string) => {
      const cost = field === "cost" ? parseAmount(value) : parseAmount(draft.cost);
      const margin = field === "margin" ? parseAmount(value) : parseAmount(draft.margin);
      const next = { ...draft, [field]: value };
      if (Number.isFinite(cost) && Number.isFinite(margin)) {
        next.priceRetail = String(priceFromMargin(cost, margin));
      }
      setDraft(next);
    };
  }

  function onPriceChange(draft: DraftProduct, setDraft: (d: DraftProduct) => void) {
    return (value: string) => {
      const cost = parseAmount(draft.cost);
      const price = parseAmount(value);
      const next = { ...draft, priceRetail: value };
      if (Number.isFinite(cost) && Number.isFinite(price) && cost > 0) {
        next.margin = String(marginPercent(cost, price));
      }
      setDraft(next);
    };
  }

  async function handleCreate() {
    try {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      if (!newDraft.code.trim() || !newDraft.name.trim()) throw new Error("Código y nombre son obligatorios.");
      const cost = parseAmount(newDraft.cost || "0");
      const priceRetail = parseAmount(newDraft.priceRetail || "0");
      const minStock = parseAmount(newDraft.minStock || "0");
      if (!Number.isFinite(cost) || cost < 0) throw new Error("El costo no puede ser negativo.");
      if (!Number.isFinite(priceRetail) || priceRetail < 0) throw new Error("El precio no puede ser negativo.");

      await createProduct({
        branchId,
        code: newDraft.code.trim(),
        name: newDraft.name.trim(),
        unit: newDraft.unit,
        cost,
        priceRetail,
        minStock,
        categoryId: newDraft.categoryId || undefined
      });
      setNewDraft(emptyDraft());
      setShowNewForm(false);
      setMessage("Producto creado.");
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el producto.");
    }
  }

  function startEdit(product: Product) {
    setEditingId(product.id);
    setEditDraft(draftFromProduct(product));
    setEditLink(draftLinkFromProduct(product));
  }

  async function handleUpdate() {
    try {
      if (!branchId || !editingId) return;
      if (!editDraft.code.trim() || !editDraft.name.trim()) throw new Error("Código y nombre son obligatorios.");
      const cost = parseAmount(editDraft.cost || "0");
      const priceRetail = parseAmount(editDraft.priceRetail || "0");
      const minStock = parseAmount(editDraft.minStock || "0");
      if (!Number.isFinite(cost) || cost < 0) throw new Error("El costo no puede ser negativo.");
      if (!Number.isFinite(priceRetail) || priceRetail < 0) throw new Error("El precio no puede ser negativo.");

      // Bloque "Stock": se valida antes de guardar nada.
      const original = productById.get(editingId);
      const wantedSourceId = editLink.linked ? editLink.sourceId : null;
      if (editLink.linked && !wantedSourceId) throw new Error("Elegí de qué producto descuenta el stock.");
      const wantedSource = wantedSourceId ? productById.get(wantedSourceId) : undefined;
      const factor = needsFactor(editDraft.unit, wantedSource) ? quantityNumber(editLink.factor) : 1;
      if (wantedSourceId && (!Number.isFinite(factor) || factor <= 0)) {
        throw new Error(`Indicá cuántos ${UNIT_LABELS[wantedSource!.unit]} descuenta cada ${UNIT_LABELS[editDraft.unit]}.`);
      }
      const linkChanged =
        wantedSourceId !== (original?.stockSourceId ?? null) ||
        (wantedSourceId !== null && factor !== (original?.stockFactor ?? 1));

      await updateProduct({
        branchId,
        id: editingId,
        code: editDraft.code.trim(),
        name: editDraft.name.trim(),
        unit: editDraft.unit,
        cost,
        priceRetail,
        minStock,
        active: editDraft.active,
        categoryId: editDraft.categoryId || undefined
      });
      let linkMessage = "";
      if (linkChanged) {
        const result = await setProductStockSource({
          productId: editingId,
          sourceId: wantedSourceId,
          factor,
          moveStock: editLink.moveStock
        });
        if (wantedSource) {
          linkMessage = ` Ahora descuenta stock de ${wantedSource.name}.`;
          if (result.moved !== 0) linkMessage += ` Se pasaron ${formatQty(result.moved)} ${UNIT_LABELS[wantedSource.unit]} a ${wantedSource.name}.`;
        } else {
          linkMessage = " Ahora tiene su propio stock.";
        }
      }
      setEditingId(null);
      setMessage("Producto actualizado." + linkMessage);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo actualizar el producto.");
      await reload();
    }
  }

  function openPresentations(product: Product) {
    setPresentationsOfId(presentationsOfId === product.id ? null : product.id);
    setLinkSearch("");
    setLinkSelected({});
    setLinkMoveStock(true);
  }

  async function handleLinkPresentations(principal: Product) {
    const ids = Object.keys(linkSelected);
    if (ids.length === 0) {
      setMessage("Marcá al menos un producto para vincular.");
      return;
    }
    const plan: { product: Product; factor: number }[] = [];
    for (const id of ids) {
      const product = productById.get(id);
      if (!product) continue;
      const factor = needsFactor(product.unit, principal) ? quantityNumber(linkSelected[id]) : 1;
      if (!Number.isFinite(factor) || factor <= 0) {
        setMessage(`Indicá cuántos ${UNIT_LABELS[principal.unit]} descuenta cada ${UNIT_LABELS[product.unit]} de ${product.name}.`);
        return;
      }
      plan.push({ product, factor });
    }
    setLinkBusy(true);
    let done = 0;
    let moved = 0;
    try {
      for (const item of plan) {
        const result = await setProductStockSource({
          productId: item.product.id,
          sourceId: principal.id,
          factor: item.factor,
          moveStock: linkMoveStock
        });
        done += 1;
        moved += result.moved;
      }
      setLinkSelected({});
      setLinkSearch("");
      setMessage(
        `${done === 1 ? "Se vinculó 1 presentación" : `Se vincularon ${done} presentaciones`} a ${principal.name}.` +
          (moved !== 0 ? ` Se pasaron ${formatQty(moved)} ${UNIT_LABELS[principal.unit]} a ${principal.name}.` : "")
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : "No se pudo vincular.";
      setMessage(done > 0 ? `Se vincularon ${done}, pero falló una: ${reason}` : reason);
    } finally {
      setLinkBusy(false);
      await reload();
    }
  }

  async function handleUnlinkPresentation(product: Product) {
    if (!window.confirm(`¿Desvincular "${product.name}"? Va a volver a tener su propio stock (empieza en 0).`)) return;
    try {
      await setProductStockSource({ productId: product.id, sourceId: null, factor: 1, moveStock: false });
      setMessage(`"${product.name}" ahora tiene su propio stock.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo desvincular.");
    } finally {
      await reload();
    }
  }

  function startAdjustStock(product: Product) {
    setAdjustingId(product.id);
    setAdjustCounted(String(product.stock));
    setAdjustReason("");
  }

  async function handleAdjustStock() {
    try {
      if (!branchId || !adjustingId) return;
      const counted = quantityNumber(adjustCounted);
      if (!Number.isFinite(counted) || counted < 0) throw new Error("La cantidad contada no puede ser negativa.");
      if (!adjustReason.trim()) throw new Error("Ingresá un motivo (ej. conteo mensual, merma).");

      const result = await adjustProductStock({ branchId, productId: adjustingId, countedQuantity: counted, reason: adjustReason.trim() });
      setAdjustingId(null);
      setMessage(
        result.delta === 0
          ? "El stock contado coincide con el registrado, no hubo ajuste."
          : `Stock ajustado: ${result.delta > 0 ? "+" : ""}${result.delta}.`
      );
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo ajustar el stock.");
    }
  }

  function renderStockBlock(product: Product) {
    const variants = presentationsOf(product.id);
    const source = editLink.sourceId ? productById.get(editLink.sourceId) : undefined;
    const wasLinked = Boolean(product.stockSourceId);
    return (
      <div>
        <strong>Stock</strong>
        {variants.length > 0 ? (
          <p className="muted" style={{ margin: "6px 0 0" }}>
            Es el producto principal de {variants.map((v) => v.name).join(", ")}: tiene su propio stock y ellas descuentan de acá.
          </p>
        ) : (
          <div style={{ marginTop: 6 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input type="radio" checked={!editLink.linked} onChange={() => setEditLink({ ...editLink, linked: false })} />
              Tiene su propio stock
              {!editLink.linked && !product.stockSourceId && (
                <button
                  type="button"
                  className="secondary"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    setEditingId(null);
                    openPresentations(product);
                  }}
                >
                  Vincularle ofertas o mayorista (mismo stock, otro precio)
                </button>
              )}
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
              <input type="radio" checked={editLink.linked} onChange={() => setEditLink({ ...editLink, linked: true })} />
              Descuenta stock de otro producto (misma mercadería, otro precio)
            </label>
            {editLink.linked && (
              <div style={{ margin: "8px 0 0 24px", display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}>
                <select value={editLink.sourceId} onChange={(e) => setEditLink({ ...editLink, sourceId: e.target.value })}>
                  <option value="">Elegí el producto principal…</option>
                  {sourceOptionsFor(product).map((p) => (
                    <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                  ))}
                </select>
                {source && needsFactor(editDraft.unit, source) && (
                  <span>
                    Cada {UNIT_LABELS[editDraft.unit]} descuenta{" "}
                    <input
                      type="text"
                      inputMode="decimal"
                      className="num"
                      value={editLink.factor}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setEditLink({ ...editLink, factor: e.target.value })}
                      style={{ width: 70 }}
                    />{" "}
                    {UNIT_LABELS[source.unit]} de {source.name}
                  </span>
                )}
                {source && !wasLinked && product.stock !== 0 && (
                  <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" checked={editLink.moveStock} onChange={(e) => setEditLink({ ...editLink, moveStock: e.target.checked })} />
                    Sumar a {source.name} el stock que tiene hoy este producto ({formatQty(product.stock)} {UNIT_LABELS[product.unit]})
                  </label>
                )}
                {source && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Al venderlo o comprarlo, el stock se mueve en {source.name}. Stock de {source.name}: {formatQty(source.stock)} {UNIT_LABELS[source.unit]}.
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderPresentationsPanel(principal: Product) {
    const variants = presentationsOf(principal.id).sort(compareByCode);
    const q = linkSearch.trim().toLowerCase();
    const candidates = products
      .filter((p) => p.id !== principal.id && !p.stockSourceId && presentationsOf(p.id).length === 0 && (p.active ?? true))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))
      .sort(compareByCode)
      .slice(0, 40);
    const selectedIds = Object.keys(linkSelected);
    const selectedWithStock = selectedIds.map((id) => productById.get(id)).filter((p): p is Product => Boolean(p) && p!.stock !== 0);
    return (
      <div>
        <strong>Se vende también como</strong>
        <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12 }}>
          Productos con otro código y otro precio (ofertas, mayorista, cajón) que descuentan stock de {principal.name}.
          Stock de {principal.name}: {formatQty(principal.stock)} {UNIT_LABELS[principal.unit]}.
        </p>
        {variants.length === 0 && <p className="muted">Todavía no tiene presentaciones vinculadas.</p>}
        {variants.map((v) => (
          <div key={v.id} className="list-row">
            <span>
              {v.code} · {v.name} — {formatMoney(v.priceRetail)}
              {v.unit !== principal.unit && (
                <span className="muted"> ({formatQty(v.stockFactor ?? 1)} {UNIT_LABELS[principal.unit]} por {UNIT_LABELS[v.unit]})</span>
              )}
            </span>
            <button className="secondary" onClick={() => handleUnlinkPresentation(v)}>Desvincular</button>
          </div>
        ))}

        <div style={{ marginTop: 12 }}>
          <strong>Vincular presentaciones</strong>
          <input
            placeholder="Buscar por nombre o código"
            value={linkSearch}
            onChange={(e) => setLinkSearch(e.target.value)}
            style={{ display: "block", width: "100%", maxWidth: 360, margin: "6px 0" }}
          />
          <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #e5e5e5", borderRadius: 6, padding: 6 }}>
            {candidates.map((p) => {
              const checked = p.id in linkSelected;
              return (
                <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = { ...linkSelected };
                        if (e.target.checked) next[p.id] = "1";
                        else delete next[p.id];
                        setLinkSelected(next);
                      }}
                    />
                    {p.code} · {p.name} — {formatMoney(p.priceRetail)}
                  </label>
                  {checked && needsFactor(p.unit, principal) && (
                    <span style={{ fontSize: 12 }}>
                      cada {UNIT_LABELS[p.unit]} descuenta{" "}
                      <input
                        type="text"
                        inputMode="decimal"
                        className="num"
                        value={linkSelected[p.id]}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setLinkSelected({ ...linkSelected, [p.id]: e.target.value })}
                        style={{ width: 60 }}
                      />{" "}
                      {UNIT_LABELS[principal.unit]}
                    </span>
                  )}
                </div>
              );
            })}
            {candidates.length === 0 && <p className="muted">No hay productos para mostrar.</p>}
          </div>
          {selectedWithStock.length > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input type="checkbox" checked={linkMoveStock} onChange={(e) => setLinkMoveStock(e.target.checked)} />
              Sumar a {principal.name} el stock que tienen hoy los productos marcados (
              {selectedWithStock.map((p) => `${p.name}: ${formatQty(p.stock)}`).join(", ")})
            </label>
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button disabled={linkBusy} onClick={() => handleLinkPresentations(principal)}>
              {linkBusy ? "Vinculando…" : `Vincular ${selectedIds.length || ""}`.trim()}
            </button>
            <button className="secondary" onClick={() => setPresentationsOfId(null)}>Cerrar</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">STOCK</p>
          <h1>Productos, costos y márgenes</h1>
          <p className="muted">Costo, margen y precio de venta por producto — se usa en Compras y en Rentabilidad.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}

      <section className="panel">
        <div className="panel-title">
          <h2>Productos</h2>
          <span>{loading ? "Cargando…" : `${visibleProducts.length} productos`}</span>
        </div>

        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
          <input
            type="search"
            name="stock-product-search"
            autoComplete="off"
            placeholder="Buscar producto por nombre o código…"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setProductSearch("");
            }}
            style={{ flex: "1 1 260px", minWidth: 220 }}
          />
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">Todas las categorías</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button className="secondary" onClick={() => setShowCategoryManager((v) => !v)}>
            {showCategoryManager ? "Ocultar categorías" : "Gestionar categorías"}
          </button>
          {/* Con balanza por cable (Estándar y Full) la lista CSV va adentro de su panel; en Básico queda acá. */}
          {!planAllows(profile, "estandar") && (
            <button className="secondary" onClick={() => downloadScaleExportCsv(products, categories)}>
              Descargar lista para balanza
            </button>
          )}
          <ScaleSyncPanel products={products} onDownloadCsv={() => downloadScaleExportCsv(products, categories)} />
          {(SHOW_SYSTEL_PANEL || SYSTEL_PILOT_COMPANIES.has(profile?.company_id ?? "")) && <SystelPanel products={products} />}
        </div>

        <PriceTools products={products} categories={categories} onApplied={reload} />

        {showCategoryManager && (
          <div className="panel" style={{ marginBottom: 16, padding: 14 }}>
            {categories.map((category, index) => (
              <div key={category.id} className="list-row">
                {renamingCategoryId === category.id ? (
                  <>
                    <input value={renameCategoryName} onChange={(e) => setRenameCategoryName(e.target.value)} style={{ flex: 1, marginRight: 8 }} />
                    <span>
                      <button onClick={handleRenameCategory}>Guardar</button>{" "}
                      <button className="secondary" onClick={() => setRenamingCategoryId(null)}>Cancelar</button>
                    </span>
                  </>
                ) : (
                  <>
                    <span>{category.name}</span>
                    <span>
                      <button
                        className="secondary"
                        disabled={index === 0}
                        onClick={() => handleMoveCategory(category, "up")}
                        title="Subir"
                      >
                        ↑
                      </button>{" "}
                      <button
                        className="secondary"
                        disabled={index === categories.length - 1}
                        onClick={() => handleMoveCategory(category, "down")}
                        title="Bajar"
                      >
                        ↓
                      </button>{" "}
                      <button className="secondary" onClick={() => startRenameCategory(category)}>Renombrar</button>{" "}
                      <button className="danger" onClick={() => handleDeleteCategory(category)}>Borrar</button>
                    </span>
                  </>
                )}
              </div>
            ))}
            {categories.length === 0 && <p className="muted">Todavía no hay categorías.</p>}
            <div className="cash-banner-form" style={{ marginTop: 10 }}>
              <input placeholder="Nueva categoría" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} />
              <button onClick={handleCreateCategory}>+ Agregar categoría</button>
            </div>
          </div>
        )}

        {showNewForm ? (
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 16 }}>
            <input placeholder="Código" value={newDraft.code} onChange={(e) => setNewDraft({ ...newDraft, code: e.target.value })} style={{ width: 100 }} />
            <input placeholder="Nombre" value={newDraft.name} onChange={(e) => setNewDraft({ ...newDraft, name: e.target.value })} />
            <select value={newDraft.categoryId} onChange={(e) => setNewDraft({ ...newDraft, categoryId: e.target.value })}>
              <option value="">Sin categoría</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select value={newDraft.unit} onChange={(e) => setNewDraft({ ...newDraft, unit: e.target.value as Product["unit"] })}>
              <option value="kg">kg</option>
              <option value="unit">unidad</option>
              <option value="box">caja</option>
            </select>
            <input
              type="text"
              inputMode="decimal"
              placeholder="Costo"
              value={newDraft.cost}
              onChange={(e) => onCostOrMarginChange(newDraft, setNewDraft, "cost")(e.target.value)}
              style={{ width: 100 }}
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Margen %"
              value={newDraft.margin}
              onChange={(e) => onCostOrMarginChange(newDraft, setNewDraft, "margin")(e.target.value)}
              style={{ width: 90 }}
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Precio venta"
              value={newDraft.priceRetail}
              onChange={(e) => onPriceChange(newDraft, setNewDraft)(e.target.value)}
              style={{ width: 100 }}
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Stock mínimo"
              value={newDraft.minStock}
              onChange={(e) => setNewDraft({ ...newDraft, minStock: e.target.value })}
              style={{ width: 100 }}
            />
            <button onClick={handleCreate}>Guardar producto</button>
            <button className="secondary" onClick={() => { setShowNewForm(false); setNewDraft(emptyDraft()); }}>Cancelar</button>
          </div>
        ) : (
          <button className="secondary" style={{ marginBottom: 16 }} onClick={() => setShowNewForm(true)}>
            + Agregar producto
          </button>
        )}

        <table className="data-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Producto</th>
              <th>Categoría</th>
              <th>Unidad</th>
              <th className="num">Costo</th>
              <th className="num">Margen</th>
              <th className="num">Venta</th>
              <th className="num">Stock</th>
              <th className="num">Mínimo</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groupedProducts.map((group) => (
              <Fragment key={group.key}>
                <tr>
                  <td colSpan={11} style={{ fontWeight: 700, background: "#f7f7f8", padding: "8px 10px" }}>
                    {group.label} <span className="muted" style={{ fontWeight: 400 }}>({group.products.length})</span>
                  </td>
                </tr>
                {group.products.map((product) => (
              <Fragment key={product.id}>
              <tr>
                {editingId === product.id ? (
                  <>
                    <td><input value={editDraft.code} onChange={(e) => setEditDraft({ ...editDraft, code: e.target.value })} style={{ width: 90 }} /></td>
                    <td><input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} /></td>
                    <td>
                      <select value={editDraft.categoryId} onChange={(e) => setEditDraft({ ...editDraft, categoryId: e.target.value })}>
                        <option value="">Sin categoría</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={editDraft.unit} onChange={(e) => setEditDraft({ ...editDraft, unit: e.target.value as Product["unit"] })}>
                        <option value="kg">kg</option>
                        <option value="unit">unidad</option>
                        <option value="box">caja</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="num"
                        value={editDraft.cost}
                        onChange={(e) => onCostOrMarginChange(editDraft, setEditDraft, "cost")(e.target.value)}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="num"
                        value={editDraft.margin}
                        onChange={(e) => onCostOrMarginChange(editDraft, setEditDraft, "margin")(e.target.value)}
                        style={{ width: 70 }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="num"
                        value={editDraft.priceRetail}
                        onChange={(e) => onPriceChange(editDraft, setEditDraft)(e.target.value)}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td className="num">{product.stock}</td>
                    <td>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="num"
                        value={editDraft.minStock}
                        onChange={(e) => setEditDraft({ ...editDraft, minStock: e.target.value })}
                        style={{ width: 70 }}
                      />
                    </td>
                    <td>
                      <select value={editDraft.active ? "1" : "0"} onChange={(e) => setEditDraft({ ...editDraft, active: e.target.value === "1" })}>
                        <option value="1">Activo</option>
                        <option value="0">Inactivo</option>
                      </select>
                    </td>
                    <td>
                      <button onClick={handleUpdate}>Guardar</button>{" "}
                      <button className="secondary" onClick={() => setEditingId(null)}>Cancelar</button>
                    </td>
                  </>
                ) : adjustingId === product.id ? (
                  <>
                    <td>{product.code}</td>
                    <td>{product.name}</td>
                    <td>{categoryName(product.categoryId)}</td>
                    <td>{UNIT_LABELS[product.unit]}</td>
                    <td className="num">{formatMoney(product.cost)}</td>
                    <td className="num">{marginPercent(product.cost, product.priceRetail)}%</td>
                    <td className="num">{formatMoney(product.priceRetail)}</td>
                    <td className="num">
                      <input
                        type="text"
                        inputMode="decimal"
                        className="num"
                        value={adjustCounted}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setAdjustCounted(e.target.value)}
                        style={{ width: 70 }}
                      />
                      <div className="muted" style={{ fontSize: 11 }}>registrado: {product.stock}</div>
                    </td>
                    <td className="num">{product.minStock}</td>
                    <td colSpan={2}>
                      <input
                        placeholder="Motivo (ej. conteo, merma)"
                        value={adjustReason}
                        onChange={(e) => setAdjustReason(e.target.value)}
                        style={{ width: "100%", marginBottom: 6 }}
                      />
                      <button onClick={handleAdjustStock}>Guardar ajuste</button>{" "}
                      <button className="secondary" onClick={() => setAdjustingId(null)}>Cancelar</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{product.code}</td>
                    <td>
                      {product.name}
                      {presentationsOf(product.id).length > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          + {presentationsOf(product.id).length} {presentationsOf(product.id).length === 1 ? "presentación" : "presentaciones"} con otro precio
                        </div>
                      )}
                    </td>
                    <td>{categoryName(product.categoryId)}</td>
                    <td>{UNIT_LABELS[product.unit]}</td>
                    <td className="num">{formatMoney(product.cost)}</td>
                    <td className="num">{marginPercent(product.cost, product.priceRetail)}%</td>
                    <td className="num">{formatMoney(product.priceRetail)}</td>
                    <td className="num">
                      {product.stock} {product.stock <= product.minStock ? "⚠" : ""}
                      {product.stockSourceId && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          usa stock de {productById.get(product.stockSourceId)?.name ?? "otro producto"}
                        </div>
                      )}
                    </td>
                    <td className="num">{product.minStock}</td>
                    <td>{(product.active ?? true) ? "Activo" : "Inactivo"}</td>
                    <td>
                      <button className="secondary" onClick={() => startEdit(product)}>Editar</button>{" "}
                      {product.stockSourceId ? null : (
                        <>
                          <button className="secondary" onClick={() => startAdjustStock(product)}>Ajustar stock</button>
                          {/* Solo en los que ya tienen: para vincular la primera, Editar → bloque "Stock". */}
                          {presentationsOf(product.id).length > 0 && (
                            <>
                              {" "}
                              <button className="secondary" onClick={() => openPresentations(product)}>
                                Presentaciones ({presentationsOf(product.id).length})
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </td>
                  </>
                )}
              </tr>
              {editingId === product.id && (
                <tr>
                  <td colSpan={11} style={{ background: "#fafafa", padding: "10px 14px" }}>
                    {renderStockBlock(product)}
                  </td>
                </tr>
              )}
              {presentationsOfId === product.id && editingId !== product.id && !product.stockSourceId && (
                <tr>
                  <td colSpan={11} style={{ background: "#fafafa", padding: "10px 14px" }}>
                    {renderPresentationsPanel(product)}
                  </td>
                </tr>
              )}
              </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
        {visibleProducts.length === 0 && !loading && <p className="muted">{searchText ? `Ningún producto coincide con "${productSearch.trim()}".` : "No hay productos para mostrar."}</p>}

      </section>
    </>
  );
}
