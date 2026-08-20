import { useEffect, useState } from "react";
import type { Product } from "@patagonia/domain";
import { marginPercent, priceFromMargin } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { adjustProductStock, createProduct, listProductsForBranch, updateProduct } from "./inventory-service";
import {
  createProductCategory,
  deleteProductCategory,
  listProductCategories,
  updateProductCategory,
  type ProductCategory
} from "./product-categories-service";
import { parseAmount } from "../../lib/money";

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

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");

  const [showNewForm, setShowNewForm] = useState(false);
  const [newDraft, setNewDraft] = useState<DraftProduct>(emptyDraft());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftProduct>(emptyDraft());

  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustCounted, setAdjustCounted] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
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

  const visibleProducts = categoryFilter ? products.filter((p) => p.categoryId === categoryFilter) : products;

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

  async function handleDeleteCategory(category: ProductCategory) {
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
      setEditingId(null);
      setMessage("Producto actualizado.");
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo actualizar el producto.");
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
      const counted = Number(adjustCounted);
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
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">Todas las categorías</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button className="secondary" onClick={() => setShowCategoryManager((v) => !v)}>
            {showCategoryManager ? "Ocultar categorías" : "Gestionar categorías"}
          </button>
        </div>

        {showCategoryManager && (
          <div className="panel" style={{ marginBottom: 16, padding: 14 }}>
            {categories.map((category) => (
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
            {visibleProducts.map((product) => (
              <tr key={product.id}>
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
                        type="number"
                        min="0"
                        step={product.unit === "kg" ? "0.001" : "1"}
                        className="num"
                        value={adjustCounted}
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
                    <td>{product.name}</td>
                    <td>{categoryName(product.categoryId)}</td>
                    <td>{UNIT_LABELS[product.unit]}</td>
                    <td className="num">{formatMoney(product.cost)}</td>
                    <td className="num">{marginPercent(product.cost, product.priceRetail)}%</td>
                    <td className="num">{formatMoney(product.priceRetail)}</td>
                    <td className="num">{product.stock} {product.stock <= product.minStock ? "⚠" : ""}</td>
                    <td className="num">{product.minStock}</td>
                    <td>{(product.active ?? true) ? "Activo" : "Inactivo"}</td>
                    <td>
                      <button className="secondary" onClick={() => startEdit(product)}>Editar</button>{" "}
                      <button className="secondary" onClick={() => startAdjustStock(product)}>Ajustar stock</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {visibleProducts.length === 0 && !loading && <p className="muted">No hay productos para mostrar.</p>}

        {showNewForm ? (
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 16 }}>
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
          <button className="secondary" style={{ marginTop: 16 }} onClick={() => setShowNewForm(true)}>
            + Agregar producto
          </button>
        )}
      </section>
    </>
  );
}
