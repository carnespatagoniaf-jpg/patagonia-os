import { Fragment, useEffect, useState } from "react";
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
  reorderProductCategory,
  updateProductCategory,
  type ProductCategory
} from "./product-categories-service";
import { parseAmount } from "../../lib/money";
import { downloadScaleExportCsv } from "./scale-export";
import {
  checkScaleCompatibility,
  connectScalePort,
  deleteScalePlu,
  describeResponseCode,
  getScaleSerialSettings,
  isScalePortPaired,
  isScaleSerialSupported,
  planScaleSync,
  readScalePlu,
  saveScaleSerialSettings,
  sendScalePing,
  syncOneProductToScale,
  syncProductsToScale,
  type ScaleSerialSettings
} from "./scale-serial";

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

  const [showScalePanel, setShowScalePanel] = useState(false);
  const [scaleSettings, setScaleSettings] = useState<ScaleSerialSettings>(getScaleSerialSettings());
  const [scalePortReady, setScalePortReady] = useState(false);
  const [scaleBusy, setScaleBusy] = useState(false);
  const [scaleSyncProgress, setScaleSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [scaleLog, setScaleLog] = useState("");
  const [scaleTestCode, setScaleTestCode] = useState("");
  const [showScalePreview, setShowScalePreview] = useState(false);

  useEffect(() => {
    void isScalePortPaired().then(setScalePortReady);
  }, []);

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
  const scaleSyncPlan = planScaleSync(products);

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

  function updateScaleSettings(patch: Partial<ScaleSerialSettings>) {
    const next = { ...scaleSettings, ...patch };
    setScaleSettings(next);
    saveScaleSerialSettings(next);
  }

  async function handleConnectScale() {
    setScaleBusy(true);
    setScaleLog("");
    try {
      await connectScalePort();
      setScalePortReady(true);
      setScaleLog("Puerto conectado. Ahora probá la conexión antes de sincronizar productos.");
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "No se pudo conectar con el puerto.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handlePingScale() {
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await sendScalePing();
      setScaleLog(
        result.ok
          ? `La balanza respondió: ${result.rawResponseHex || "(sin bytes)"} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`
          : "La balanza no respondió nada -- revisá el cable, o probá otra velocidad de puerto."
      );
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló la prueba de conexión.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleCheckCompatibility() {
    setScaleBusy(true);
    setScaleLog("Probando compatibilidad… esto carga y borra un producto de prueba en la balanza, no toca productos reales.");
    try {
      const result = await checkScaleCompatibility();
      const details = [
        `Conexión: ${result.pingOk ? "OK" : "sin respuesta"}.`,
        result.writeResponseCode ? `Escritura de prueba: código "${result.writeResponseCode}".` : "",
        result.readResponseCode ? `Relectura: código "${result.readResponseCode}".` : ""
      ].filter(Boolean).join(" ");
      setScaleLog(`${result.compatible ? "✅" : "❌"} ${result.message} ${details}`);
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló la prueba de compatibilidad.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleSyncScale() {
    setScaleBusy(true);
    setScaleLog("");
    setScaleSyncProgress({ done: 0, total: 0 });
    try {
      const result = await syncProductsToScale(products, categories, (done, total) => setScaleSyncProgress({ done, total }));
      const okCount = result.responseCodeCounts["01"] ?? 0;
      const failedCount = result.attempted - okCount;
      const codesSummary = Object.entries(result.responseCodeCounts)
        .filter(([code]) => code !== "01")
        .map(([code, count]) => `${count} con código "${code}" (${describeResponseCode(code)})`)
        .join(", ");
      const parts = [`${okCount} enviados con éxito de ${result.attempted} intentados.`];
      if (failedCount > 0 && codesSummary) parts.push(`Fallidos: ${codesSummary}.`);
      if (result.failed.length) {
        parts.push(
          "Detalle: " +
            result.failed.map((f) => `${f.product.name} (${f.product.code}, código "${f.responseCode}")`).join(", ") +
            "."
        );
      }
      if (result.skipped.length) parts.push(`${result.skipped.length} sin código numérico (no se enviaron).`);
      if (result.noResponse.length) parts.push(`${result.noResponse.length} sin ninguna respuesta.`);
      if (result.transportErrors.length) {
        parts.push(`${result.transportErrors.length} con error de conexión (${result.transportErrors[0].message}) -- probá enviar de nuevo, capaz fue un hipo del cable.`);
      }
      setScaleLog(parts.join(" "));
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló el envío a la balanza.");
    } finally {
      setScaleBusy(false);
      setScaleSyncProgress(null);
    }
  }

  async function handleSendOneProduct() {
    const product = products.find((p) => p.code === scaleTestCode.trim());
    if (!product) {
      setScaleLog(`No encontré ningún producto con código "${scaleTestCode.trim()}".`);
      return;
    }
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await syncOneProductToScale(product, categories);
      setScaleLog(
        `Mandé "${product.name}" (código ${product.code}, $${product.priceRetail}). Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`
      );
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló el envío del producto.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleReadPlu() {
    if (!scaleTestCode.trim()) {
      setScaleLog("Ingresá un código de PLU para leer.");
      return;
    }
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await readScalePlu(scaleTestCode.trim());
      setScaleLog(
        `Leí PLU ${scaleTestCode.trim()}. Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}. Datos como texto: "${result.rawDataAscii}"`
      );
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló la lectura del PLU.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleDeletePlu() {
    const code = scaleTestCode.trim();
    if (!code) {
      setScaleLog("Ingresá un código de PLU para borrar.");
      return;
    }
    if (!window.confirm(`¿Seguro que querés borrar el PLU ${code} de la balanza? Esto borra el registro de la balanza (no de Patagonia OS).`)) return;
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await deleteScalePlu(code);
      setScaleLog(`Borré PLU ${code}. Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`);
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló el borrado del PLU.");
    } finally {
      setScaleBusy(false);
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
          <button className="secondary" onClick={() => downloadScaleExportCsv(products, categories)}>
            Descargar lista para balanza
          </button>
          <button className="secondary" onClick={() => setShowScalePanel((v) => !v)}>
            {showScalePanel ? "Ocultar balanza por cable" : "Balanza por cable (sin iTegra)"}
          </button>
        </div>
        <p className="muted" style={{ margin: "-8px 0 14px", fontSize: 12 }}>
          CSV para importar en el software de PC de la balanza (Kretz Simplex/iTegra) -- formato de prueba, todavía sin confirmar contra el importador real.
        </p>

        {showScalePanel && (
          <div style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 18, marginBottom: 14 }}>
            <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 16 }}>Balanza por cable</p>
            <p className="muted" style={{ margin: "0 0 16px", fontSize: 13 }}>
              Manda los productos directo a la balanza Kretz por cable, sin usar el software de iTegra. Solo funciona en Chrome o Edge.
            </p>
            {!isScaleSerialSupported() && (
              <p style={{ margin: "0 0 14px", color: "#8a4b00", fontWeight: 700 }}>
                Este navegador no soporta esto -- abrí Patagonia OS en Chrome o Edge.
              </p>
            )}

            <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 14, marginBottom: 14 }}>
              <p style={{ margin: "0 0 8px", fontWeight: 700, fontSize: 13, textTransform: "uppercase", color: "#666" }}>1. Conexión</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button disabled={scaleBusy || !isScaleSerialSupported()} onClick={handleConnectScale}>
                  {scalePortReady ? "Volver a elegir puerto" : "Conectar balanza"}
                </button>
                <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={handlePingScale}>
                  Probar conexión
                </button>
                <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={handleCheckCompatibility}>
                  Verificar compatibilidad
                </button>
              </div>
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Si es una balanza que no probamos todavía (no una Report LT), usá "Verificar compatibilidad" antes de mandar productos: carga y borra un producto de prueba para confirmar que entiende el mismo formato, sin arriesgar datos reales.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                <details style={{ display: "inline-block" }}>
                  <summary className="secondary" style={{ display: "inline-block", cursor: "pointer", padding: "10px 14px", border: "1px solid #ccc", borderRadius: 6 }}>
                    Configuración avanzada
                  </summary>
                  <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginTop: 10, fontSize: 14 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      Velocidad
                      <select value={scaleSettings.baudRate} onChange={(e) => updateScaleSettings({ baudRate: Number(e.target.value) })}>
                        {[2400, 4800, 9600, 19200, 38400, 57600, 115200].map((rate) => (
                          <option key={rate} value={rate}>{rate}</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      ID de equipo
                      <input style={{ width: 50 }} value={scaleSettings.equipmentId} onChange={(e) => updateScaleSettings({ equipmentId: e.target.value.slice(0, 2) })} />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      Tipo de equipo
                      <input style={{ width: 40 }} value={scaleSettings.deviceType} onChange={(e) => updateScaleSettings({ deviceType: e.target.value.slice(0, 1).toUpperCase() })} />
                    </label>
                  </div>
                  <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                    Ya configurado para una Report LT (115200 baudios, tipo "C"). Solo tocar esto si conectás un modelo distinto.
                  </p>
                </details>
              </div>
            </div>

            <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 14, marginBottom: 14 }}>
              <p style={{ margin: "0 0 8px", fontWeight: 700, fontSize: 13, textTransform: "uppercase", color: "#666" }}>2. Envío masivo</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={() => setShowScalePreview((v) => !v)}>
                  {showScalePreview ? "Ocultar vista previa" : `Vista previa (${scaleSyncPlan.toSend.length} productos)`}
                </button>
                <button disabled={scaleBusy || !isScaleSerialSupported()} onClick={handleSyncScale}>
                  {scaleBusy && scaleSyncProgress ? `Enviando… ${scaleSyncProgress.done}/${scaleSyncProgress.total}` : "Enviar todos los productos"}
                </button>
              </div>
              {showScalePreview && (
                <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #eef0f3", borderRadius: 6, padding: 10, marginTop: 10, fontSize: 13 }}>
                  <p style={{ margin: "0 0 8px", fontWeight: 700 }}>
                    Se enviarían {scaleSyncPlan.toSend.length} de {products.length} productos
                    {" "}({scaleSyncPlan.skipped.length} salteados, {scaleSyncPlan.inactive.length} inactivos).
                  </p>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left" }}>
                        <th>Código</th>
                        <th>Nombre</th>
                        <th>Precio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scaleSyncPlan.toSend.map((p) => (
                        <tr key={p.id}>
                          <td>{p.code}</td>
                          <td>{p.name}</td>
                          <td>{formatMoney(p.priceRetail)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {scaleSyncPlan.skipped.length > 0 && (
                    <>
                      <p style={{ margin: "10px 0 4px", fontWeight: 700 }}>Salteados (no se envían):</p>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {scaleSyncPlan.skipped.map((s) => (
                          <li key={s.product.id}>{s.product.name} ({s.product.code}) -- {s.reason}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>

            <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 14 }}>
              <p style={{ margin: "0 0 8px", fontWeight: 700, fontSize: 13, textTransform: "uppercase", color: "#666" }}>3. Un solo producto</p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  placeholder="Código del producto (ej. 12)"
                  style={{ width: 200 }}
                  value={scaleTestCode}
                  onChange={(e) => setScaleTestCode(e.target.value)}
                />
                <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={handleSendOneProduct}>
                  Enviar
                </button>
                <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={handleReadPlu}>
                  Leer de la balanza
                </button>
                <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" style={{ color: "#8a1f11" }} onClick={handleDeletePlu}>
                  Borrar de la balanza
                </button>
              </div>
            </div>

            {scaleLog && (
              <p style={{ margin: "14px 0 0", fontSize: 13, whiteSpace: "pre-wrap", background: "#f7f7f8", borderRadius: 6, padding: 10 }}>{scaleLog}</p>
            )}
          </div>
        )}

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
              </Fragment>
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
