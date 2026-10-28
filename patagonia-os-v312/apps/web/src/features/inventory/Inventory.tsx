import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { marginPercent } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";
import { adjustProductStock, clearProductPackages, createProduct, deleteProduct, listProductPackages, listProductsForBranch, listProductVatRates, registerProductPackages, setProductActive, setProductsVatRate, setProductStockSource, updateProduct } from "./inventory-service";
import { getFiscalSettings } from "../invoicing/invoicing-service";
import { PRODUCT_VAT_OPTIONS, productVatLabel, vatFromSelect, vatPercentLabel, vatSelectValue } from "./product-vat";
import {
  createProductCategory,
  deleteProductCategory,
  listProductCategories,
  reorderProductCategory,
  updateProductCategory,
  type ProductCategory
} from "./product-categories-service";
import { parseAmount } from "../../lib/money";
import { marginToInput, moneyToInput, onCostOrMargin, onPrice, productWithCode } from "./product-pricing";
import { downloadScaleExportCsv } from "./scale-export";
import { ScaleSyncPanel } from "./ScaleSyncPanel";
import { SystelPanel } from "./systel/SystelPanel";
import { ScaleLinksPanel } from "../scales/sale/ScaleLinksPanel";
import { SYSTEL_PILOT_COMPANIES } from "./systel/systel-pilot";
import { MyScale } from "../scales/MyScale";
import { ScaleSupportTools } from "../scales/ScaleSupportTools";
import { ScaleButton } from "../scales/ScaleButton";

/** Balanzas Systel: módulo nuevo, oculto hasta que el dueño autorice publicarlo. */
const SHOW_SYSTEL_PANEL = false;
/** Laboratorio Systel (balanza de banco): solo en una compilación con VITE_SYSTEL_LAB=1; la de producción no lo trae. */
const SystelLabPanel = import.meta.env.VITE_SYSTEL_LAB === "1" ? lazy(() => import("./systel/SystelLabPanel")) : null;
import { PriceTools } from "./PriceTools";
import { PriceListsPanel } from "../pricing/PriceListsPanel";
import { listPriceLists, setProductListPrices } from "../pricing/price-lists-service";
import { ruleLabel, rulePrice, type PriceList } from "../pricing/price-lists";
import { quantityNumber } from "../sale/quantity";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

const UNIT_LABELS: Record<Product["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };
const PRODUCT_COLS = 8;

interface DraftProduct {
  code: string;
  name: string;
  unit: Product["unit"];
  cost: string;
  margin: string;
  priceRetail: string;
  minStock: string;
  /** Stock que hay hoy (Agregar: stock inicial; Editar: corrige con un ajuste de stock). */
  stock: string;
  /** IVA: "" = el general de Facturas (migración 154). */
  vatRate: string;
  active: boolean;
  categoryId: string;
  /** Precio escrito a mano en cada lista (Mayorista…); "" = sale de la regla de la lista. */
  listPrices: Record<string, string>;
}

/** Cantidad escrita por una persona: en kilos "0,750" = 0,75; en unidades "1.008" = mil ocho (punto de miles). */
function typedCount(unit: Product["unit"], raw: string): number {
  const text = raw.trim();
  return quantityNumber(unit !== "kg" && /^d{1,3}(.d{3})+$/.test(text) ? text.replace(/./g, "") : text);
}

function emptyDraft(): DraftProduct {
  return { code: "", name: "", unit: "kg", cost: "", margin: "", priceRetail: "", minStock: "", stock: "", active: true, categoryId: "", vatRate: "", listPrices: {} };
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
    // Con coma: "17804.35" lo leía parseAmount como 1.780.435 al guardar.
    cost: moneyToInput(p.cost),
    margin: marginToInput(marginPercent(p.cost, p.priceRetail)),
    priceRetail: moneyToInput(p.priceRetail),
    minStock: String(p.minStock),
    stock: String(p.stock),
    active: p.active ?? true,
    categoryId: p.categoryId ?? "",
    vatRate: "",
    listPrices: Object.fromEntries(Object.entries(p.listPrices ?? {}).filter(([, v]) => v.manual).map(([id, v]) => [id, moneyToInput(v.price)]))
  };
}

export function Inventory() {
  const { branchId } = useActiveBranch();
  const { profile } = useAuth();

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");
  // Los dados de baja no se muestran salvo que se pida (siguen existiendo, con su historia).
  const [showInactive, setShowInactive] = useState(false);

  const [showNewForm, setShowNewForm] = useState(false);
  const newNameRef = useRef<HTMLInputElement>(null);
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

  // IVA por producto (migración 154): id → alícuota, null = el general de Facturas.
  const [vatRates, setVatRates] = useState<Record<string, number | null>>({});
  const [generalVatRate, setGeneralVatRate] = useState<number | null>(null);
  /** Paquetes por producto (a pedido: companies.features 'paquetes', migración 157). Solo los que ya se contaron. */
  const showPackages = Boolean(profile?.features?.includes("paquetes"));
  const [packages, setPackages] = useState<Record<string, number>>({});
  // Listas de precios (Mayorista, migración 166). Sin listas, la pantalla queda como siempre.
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [showPriceLists, setShowPriceLists] = useState(false);
  const activeLists = priceLists.filter((l) => l.active);
  const canManageLists = (profile?.role === "owner" || profile?.role === "admin") && planAllows(profile, "full");
  const productCols = PRODUCT_COLS + activeLists.length;


  async function reload() {
    if (!isSupabaseConfigured || !branchId) return;
    setLoading(true);
    try {
      const [list, rates, packs, lists] = await Promise.all([
        listProductsForBranch(branchId, true),
        listProductVatRates().catch(() => ({})),
        showPackages ? listProductPackages(branchId).catch(() => ({})) : Promise.resolve({}),
        listPriceLists().catch(() => [] as PriceList[])
      ]);
      setProducts(list);
      setPriceLists(lists);
      setVatRates(rates);
      setPackages(packs);
    } finally {
      setLoading(false);
    }
  }

  /** Borrar los paquetes de un producto para empezar de nuevo (los kilos no cambian). */
  async function handleClearPackages(product: Product) {
    if (!branchId) return;
    if (!window.confirm(`¿Borrar los paquetes de "${product.name}"? Vuelve a "Contar paquetes" y los cuentan de nuevo. Los kilos no cambian.`)) return;
    try {
      await clearProductPackages(branchId, product.id);
      setPackages((p) => {
        const next = { ...p };
        delete next[product.id];
        return next;
      });
      setMessage(`${product.name}: paquetes borrados.`);
    } catch (err) {
      setMessage(errorText(err) || "No se pudieron borrar los paquetes.");
    }
  }

  /** "Envasé" suma paquetes; "Contar" deja el número que contaron (cada paquete pesa distinto, se cuentan de a uno). */
  async function handlePackages(product: Product, kind: "envasado" | "conteo") {
    if (!branchId) return;
    const text = window.prompt(kind === "envasado" ? `¿Cuántos paquetes de "${product.name}" envasaste?` : `¿Cuántos paquetes de "${product.name}" hay ahora?`);
    if (text === null) return;
    const count = Number(text.trim());
    if (!Number.isInteger(count) || count < 0 || (kind === "envasado" && count === 0)) {
      setMessage("Escribí una cantidad entera de paquetes (por ejemplo 20).");
      return;
    }
    setMessage("");
    try {
      const left = await registerProductPackages({ branchId, productId: product.id, kind, count });
      setPackages((p) => ({ ...p, [product.id]: left }));
      setMessage(`${product.name}: ${left} ${left === 1 ? "paquete" : "paquetes"}.`);
    } catch (err) {
      setMessage(errorText(err) || "No se pudieron guardar los paquetes.");
    }
  }

  /** Los errores de la base (PostgrestError) no son instancias de Error: el motivo viene en .message. */
  function errorText(err: unknown): string {
    if (err instanceof Error) return err.message;
    return typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "";
  }

  /** Dar de baja / reactivar desde la fila (migración 139). */
  async function handleToggleActive(product: Product) {
    const active = !(product.active ?? true);
    if (!active && !window.confirm(`¿Dar de baja "${product.name}"? Deja de aparecer para vender. Su historia queda y lo podés reactivar cuando quieras.`)) return;
    setMessage("");
    try {
      if (isSupabaseConfigured) await setProductActive(product.id, active);
      else setProducts((list) => list.map((p) => (p.id === product.id ? { ...p, active } : p)));
      setMessage(active ? `"${product.name}" vuelve a estar activo.` : `"${product.name}" quedó dado de baja.`);
      if (isSupabaseConfigured) await reload();
    } catch (err) {
      setMessage(errorText(err) || "No se pudo cambiar el producto.");
    }
  }

  /** Eliminar: solo si nunca se usó. Si tiene historia, la base lo rechaza y lo explica. */
  async function handleDelete(product: Product) {
    if (!window.confirm(`¿Eliminar "${product.name}"? Se borra del todo. Solo se puede si nunca se vendió, compró ni tuvo stock.`)) return;
    setMessage("");
    try {
      if (isSupabaseConfigured) await deleteProduct(product.id);
      else setProducts((list) => list.filter((p) => p.id !== product.id));
      setMessage(`"${product.name}" eliminado.`);
      if (isSupabaseConfigured) await reload();
    } catch (err) {
      setMessage(errorText(err) || "No se pudo eliminar el producto.");
    }
  }

  async function reloadCategories() {
    if (!isSupabaseConfigured) return;
    setCategories(await listProductCategories());
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    getFiscalSettings()
      .then((s) => setGeneralVatRate(s ? s.defaultVatRate : null))
      .catch(() => setGeneralVatRate(null));
  }, []);

  /** "Poner IVA a toda la categoría". */
  async function handleCategoryVat(category: ProductCategory, value: string) {
    const ids = products.filter((p) => p.categoryId === category.id).map((p) => p.id);
    if (ids.length === 0) {
      setMessage(`"${category.name}" no tiene productos.`);
      return;
    }
    const rate = vatFromSelect(value);
    const label = rate === null ? "el IVA general" : `IVA ${vatPercentLabel(rate)}`;
    if (!window.confirm(`¿Poner ${label} a los ${ids.length} productos de "${category.name}"?`)) return;
    try {
      const changed = isSupabaseConfigured ? await setProductsVatRate({ productIds: ids, rate }) : ids.length;
      if (!isSupabaseConfigured) setVatRates((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, rate])) }));
      setMessage(`${category.name}: ${changed} productos quedaron con ${label}.`);
      if (isSupabaseConfigured) await reload();
    } catch (err) {
      setMessage(errorText(err) || "No se pudo cambiar el IVA.");
    }
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
  const inactiveCount = products.filter((p) => !(p.active ?? true)).length;
  const visibleProducts = products.filter(
    (p) =>
      (showInactive || (p.active ?? true)) &&
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
    // Costo + margen → el precio de venta sale solo (product-pricing.ts).
    return (value: string) => setDraft(onCostOrMargin(draft, field, value));
  }

  function onPriceChange(draft: DraftProduct, setDraft: (d: DraftProduct) => void) {
    return (value: string) => setDraft(onPrice(draft, value));
  }

  /** Precios a mano por lista escritos en el formulario → lo que hay que mandar (null = vuelve a la regla). */
  function listPriceChanges(draft: DraftProduct, original?: Product): { listId: string; price: number | null }[] {
    const changes: { listId: string; price: number | null }[] = [];
    for (const l of activeLists) {
      const typed = (draft.listPrices[l.id] ?? "").trim();
      const wanted = typed ? parseAmount(typed) : null;
      if (wanted !== null && (!Number.isFinite(wanted) || wanted < 0)) throw new Error(`Precio ${l.name} inválido.`);
      const current = original?.listPrices?.[l.id]?.manual ? original.listPrices[l.id].price : null;
      if (wanted !== current) changes.push({ listId: l.id, price: wanted });
    }
    return changes;
  }

  /** Casilleros de cada lista (Mayorista…) en Agregar/Editar: vacío = sale de la regla. */
  function listPriceInfo(draft: DraftProduct, isPresentation: boolean) {
    const cost = draft.cost.trim() ? parseAmount(draft.cost) : 0;
    const retail = draft.priceRetail.trim() ? parseAmount(draft.priceRetail) : 0;
    return activeLists.map((l) => {
      const ruled = rulePrice(l, Number.isFinite(cost) ? cost : 0, Number.isFinite(retail) ? retail : 0, isPresentation);
      const typed = (draft.listPrices[l.id] ?? "").trim();
      const shown = typed ? parseAmount(typed) : ruled;
      const margin = cost > 0 && Number.isFinite(shown) ? marginPercent(cost, shown) : null;
      return { list: l, ruled, typed, margin };
    });
  }

  function renderListPriceInputs(draft: DraftProduct, setDraft: (d: DraftProduct) => void, isPresentation: boolean) {
    return listPriceInfo(draft, isPresentation).map(({ list: l, ruled }) => (
      <label key={l.id} title={isPresentation ? "Oferta / presentación: sin precio a mano se cobra su precio de venta" : `Vacío = ${ruleLabel(l)}`}>
        Precio {l.name} $
        <input
          type="text"
          inputMode="decimal"
          className="num"
          placeholder={ruled > 0 ? formatMoney(ruled) : "Regla"}
          value={draft.listPrices[l.id] ?? ""}
          onChange={(e) => setDraft({ ...draft, listPrices: { ...draft.listPrices, [l.id]: e.target.value } })}
        />
      </label>
    ));
  }

  /** Debajo del formulario: de dónde sale cada precio de lista y su margen. */
  function renderListPriceHint(draft: DraftProduct, isPresentation: boolean) {
    const info = listPriceInfo(draft, isPresentation);
    if (info.length === 0) return null;
    return (
      <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
        {info
          .map(({ list: l, ruled, typed, margin }) => {
            const how = typed ? "escrito a mano" : isPresentation ? "oferta: se cobra su precio" : `${ruleLabel(l)} = ${formatMoney(ruled)}`;
            return `${l.name}: ${how}${margin !== null ? `, margen ${String(margin).replace(".", ",")}%` : ""}`;
          })
          .join(" · ")}
        {". Dejalo vacío para que se calcule solo; escribí un precio solo si este producto necesita otro."}
      </p>
    );
  }

  async function handleCreate() {
    try {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      if (!newDraft.code.trim() || !newDraft.name.trim()) throw new Error("Código y nombre son obligatorios.");
      const taken = productWithCode(products, newDraft.code);
      if (taken) throw new Error(`El código ${taken.code} ya es de "${taken.name}". Buscalo en la lista para editarlo.`);
      const cost = parseAmount(newDraft.cost || "0");
      const priceRetail = parseAmount(newDraft.priceRetail || "0");
      const minStock = quantityNumber(newDraft.minStock || "0"); // kilos o unidades, no plata: "82,598" = 82,598 kg (real M2 26/10)
      if (!Number.isFinite(cost) || cost < 0) throw new Error("El costo no puede ser negativo.");
      if (!Number.isFinite(priceRetail) || priceRetail < 0) throw new Error("El precio no puede ser negativo.");
      const initialStock = newDraft.stock.trim() ? typedCount(newDraft.unit, newDraft.stock) : 0;
      if (!Number.isFinite(initialStock) || initialStock < 0) throw new Error("El stock no puede ser negativo.");

      const created = await createProduct({
        branchId,
        code: newDraft.code.trim(),
        name: newDraft.name.trim(),
        unit: newDraft.unit,
        cost,
        priceRetail,
        minStock,
        categoryId: newDraft.categoryId || undefined
      });
      const newVat = vatFromSelect(newDraft.vatRate);
      if (newVat !== null) await setProductsVatRate({ codes: [newDraft.code.trim()], rate: newVat });
      const newListPrices = listPriceChanges(newDraft);
      if (newListPrices.length > 0) await setProductListPrices(newListPrices.map((c) => ({ ...c, productId: created.id })));
      if (initialStock > 0) await adjustProductStock({ branchId, productId: created.id, countedQuantity: initialStock, reason: "Stock inicial al crear el producto" });
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
    setEditDraft({ ...draftFromProduct(product), vatRate: vatSelectValue(vatRates[product.id]) });
    setEditLink(draftLinkFromProduct(product));
  }

  async function handleUpdate() {
    try {
      if (!branchId || !editingId) return;
      if (!editDraft.code.trim() || !editDraft.name.trim()) throw new Error("Código y nombre son obligatorios.");
      const taken = productWithCode(products, editDraft.code, editingId);
      if (taken) throw new Error(`El código ${taken.code} ya es de "${taken.name}".`);
      const cost = parseAmount(editDraft.cost || "0");
      const priceRetail = parseAmount(editDraft.priceRetail || "0");
      const minStock = quantityNumber(editDraft.minStock || "0");
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
      // Stock escrito en Editar (antes solo había "Mínimo" y lo usaban como stock; real M2 26/10).
      const wantedStock = !original?.stockSourceId && !editLink.linked && editDraft.stock.trim() ? typedCount(editDraft.unit, editDraft.stock) : null;
      if (wantedStock !== null && (!Number.isFinite(wantedStock) || wantedStock < 0)) throw new Error("El stock no puede ser negativo.");
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
      const wantedVat = vatFromSelect(editDraft.vatRate);
      if (wantedVat !== (vatRates[editingId] ?? null)) await setProductsVatRate({ productIds: [editingId], rate: wantedVat });
      const editListPrices = listPriceChanges(editDraft, original);
      if (editListPrices.length > 0) await setProductListPrices(editListPrices.map((c) => ({ ...c, productId: editingId })));
      let linkMessage = "";
      if (wantedStock !== null && original && wantedStock !== Number(original.stock)) {
        const r = await adjustProductStock({ branchId, productId: editingId, countedQuantity: wantedStock, reason: "Corrección de stock desde Editar" });
        linkMessage += ` Stock: ${formatQty(r.previous)} → ${formatQty(r.counted)} ${UNIT_LABELS[editDraft.unit]}.`;
      }
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
      const product = productById.get(adjustingId);
      // En unidades, "1.008" es mil ocho (punto de miles), no uno coma cero cero ocho.
      const raw = product && product.unit !== "kg" && /^\d{1,3}(\.\d{3})+$/.test(adjustCounted.trim()) ? adjustCounted.trim().replace(/\./g, "") : adjustCounted;
      const counted = quantityNumber(raw);
      if (!Number.isFinite(counted) || counted < 0) throw new Error("La cantidad contada no puede ser negativa.");
      if (!adjustReason.trim()) throw new Error("Ingresá un motivo (ej. conteo mensual, merma).");
      // Real M2 26/10: escribían la cantidad nueva en "Motivo" y el stock quedaba igual, sin aviso.
      if (product && counted === Number(product.stock) && /^\s*[\d.,]+\s*$/.test(adjustReason)) {
        throw new Error(`Escribiste ${adjustReason.trim()} en "Motivo". La cantidad nueva va en el casillero de arriba ("¿Cuánto hay?"); en Motivo poné por qué (ej. conteo).`);
      }

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
        {/* Todo lo de la balanza, guardado en un panel (pedido del dueño 15/10): Mi balanza, la lista para cargar a mano y,
            solo para soporte, las herramientas técnicas (migración 120). */}
        <ScaleButton>
          {planAllows(profile, "estandar") && <MyScale products={products} branchId={branchId} />}
          <div>
            <button className="secondary" onClick={() => downloadScaleExportCsv(products, categories)}>Descargar lista para balanza</button>
          </div>
          {planAllows(profile, "estandar") && (
            <ScaleSupportTools>
              {SYSTEL_PILOT_COMPANIES.has(profile?.company_id ?? "") ? (
                <SystelPanel products={products} pilot extra={<ScaleLinksPanel branchId={branchId} products={products} />} />
              ) : (
                <ScaleSyncPanel products={products} onDownloadCsv={() => downloadScaleExportCsv(products, categories)} />
              )}
              {SHOW_SYSTEL_PANEL && <SystelPanel products={products} />}
              {SystelLabPanel && (
                <Suspense fallback={null}>
                  <SystelLabPanel />
                </Suspense>
              )}
            </ScaleSupportTools>
          )}
        </ScaleButton>
      </header>

      {message && <div className="message">{message}</div>}

      <section className="panel">
        <div className="panel-title">
          <h2>Productos <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}>{loading ? "Cargando…" : `${visibleProducts.length} productos`}</span></h2>
          {!showNewForm && <button onClick={() => setShowNewForm(true)}>+ Agregar producto</button>}
        </div>

        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
          <input
            type="search"
            name="stock-product-search"
            autoComplete="off"
            placeholder="Buscar por nombre o código, o escaneá…"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setProductSearch("");
              // Escanearon un código de barras que no es de ningún producto: se abre "Agregar" con ese código.
              const code = productSearch.trim();
              if (e.key === "Enter" && /^\d{6,}$/.test(code) && !productWithCode(products, code)) {
                e.preventDefault();
                setNewDraft({ ...emptyDraft(), code });
                setShowNewForm(true);
                setProductSearch("");
                setMessage(`El código ${code} no es de ningún producto: completá el nombre y el precio para agregarlo.`);
              }
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
          {canManageLists && (
            <button className="secondary" onClick={() => setShowPriceLists((v) => !v)}>
              {showPriceLists ? "Ocultar listas de precios" : activeLists.length > 0 ? "Listas de precios" : "Precio mayorista"}
            </button>
          )}
          {inactiveCount > 0 && (
            <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Ver dados de baja ({inactiveCount})
            </label>
          )}
        </div>

        <PriceTools products={products} categories={categories} onApplied={reload} />

        {showPriceLists && canManageLists && <PriceListsPanel lists={priceLists} onChanged={reload} onMessage={setMessage} />}

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
                      <select
                        value="-"
                        title="Poner el mismo IVA a todos los productos de esta categoría"
                        onChange={(e) => { if (e.target.value !== "-") void handleCategoryVat(category, e.target.value); }}
                      >
                        <option value="-">IVA de todos…</option>
                        {PRODUCT_VAT_OPTIONS.map((r) => (
                          <option key={r} value={String(r)}>{vatPercentLabel(r)}</option>
                        ))}
                        <option value="">General</option>
                      </select>{" "}
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

        {showNewForm && (
          <div className="form-box">
            <h3 style={{ margin: "0 0 10px" }}>Producto nuevo</h3>
            <div className="form-grid">
              <label title="Escribí el código o escaneá el código de barras del producto con la pistola">
                Código o código de barras
                <input
                  placeholder="Escaneá con la pistola"
                  autoFocus
                  autoComplete="off"
                  value={newDraft.code}
                  onChange={(e) => setNewDraft({ ...newDraft, code: e.target.value })}
                  onKeyDown={(e) => {
                    // La pistola manda el código y un Enter: pasa al nombre.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      newNameRef.current?.focus();
                    }
                  }}
                />
              </label>
              <label className="span-2">Nombre<input ref={newNameRef} value={newDraft.name} onChange={(e) => setNewDraft({ ...newDraft, name: e.target.value })} /></label>
              <label>
                Categoría
                <select value={newDraft.categoryId} onChange={(e) => setNewDraft({ ...newDraft, categoryId: e.target.value })}>
                  <option value="">Sin categoría</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Unidad
                <select value={newDraft.unit} onChange={(e) => setNewDraft({ ...newDraft, unit: e.target.value as Product["unit"] })}>
                  <option value="kg">kg</option>
                  <option value="unit">unidad</option>
                  <option value="box">caja</option>
                </select>
              </label>
              <label>
                Costo $
                <input type="text" inputMode="decimal" value={newDraft.cost} onChange={(e) => onCostOrMarginChange(newDraft, setNewDraft, "cost")(e.target.value)} />
              </label>
              <label>
                Margen %
                <input type="text" inputMode="decimal" placeholder="ej. 35" value={newDraft.margin} onChange={(e) => onCostOrMarginChange(newDraft, setNewDraft, "margin")(e.target.value)} />
              </label>
              <label>
                {activeLists.length > 0 ? "Precio minorista $" : "Precio de venta $"}
                <input type="text" inputMode="decimal" value={newDraft.priceRetail} onChange={(e) => onPriceChange(newDraft, setNewDraft)(e.target.value)} />
              </label>
              {renderListPriceInputs(newDraft, setNewDraft, false)}
              <label>
                IVA
                <select value={newDraft.vatRate} onChange={(e) => setNewDraft({ ...newDraft, vatRate: e.target.value })} title="IVA del producto para la factura">
                  <option value="">{productVatLabel(null, generalVatRate)}</option>
                  {PRODUCT_VAT_OPTIONS.map((r) => (
                    <option key={r} value={String(r)}>{vatPercentLabel(r)}</option>
                  ))}
                </select>
              </label>
              <label>
                {newDraft.unit === "kg" ? "Stock hoy (kg)" : "Stock hoy (unidades)"}
                <input type="text" inputMode="decimal" value={newDraft.stock} onChange={(e) => setNewDraft({ ...newDraft, stock: e.target.value })} />
              </label>
              <label title="Solo para que avise en Inicio cuando quede poco. No es el stock.">
                Mínimo (aviso)
                <input type="text" inputMode="decimal" value={newDraft.minStock} onChange={(e) => setNewDraft({ ...newDraft, minStock: e.target.value })} />
              </label>
            </div>
            {renderListPriceHint(newDraft, false)}
            <div className="form-actions">
              <button onClick={handleCreate}>Guardar producto</button>
              <button className="secondary" onClick={() => { setShowNewForm(false); setNewDraft(emptyDraft()); }}>Cancelar</button>
            </div>
            {(() => {
              const taken = productWithCode(products, newDraft.code);
              return taken ? <p className="message warning" style={{ margin: "8px 0 0" }}>El código {taken.code} ya es de "{taken.name}".</p> : null;
            })()}
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              Código: escribilo o escaneá el código de barras con la pistola (así Mostrador lo encuentra al escanearlo). Precio: poné el costo y el margen (ej. 35) y el precio de venta se calcula solo; o poné el precio y te muestra el margen.
            </p>
          </div>
        )}

        {/* Tabla de productos (rediseño 2026-10-27): 8 columnas para que entre en una notebook de 1366 sin
            scroll. La categoría ya es el título de cada grupo, la unidad va con el stock, el IVA debajo del
            precio y "Inactivo" junto al nombre. Editar y Ajustar stock se abren en un panel debajo de la fila. */}
        <div className="table-scroll">
        <table className="data-table products-table">
          <thead>
            <tr>
              <th className="hide-sm">Código</th>
              <th>Producto</th>
              <th className="num hide-sm">Costo</th>
              <th className="num hide-sm">Margen</th>
              <th className="num">{activeLists.length > 0 ? "Minorista" : "Venta"}</th>
              {activeLists.map((l) => (
                <th key={l.id} className="num">{l.name}</th>
              ))}
              <th className="num">Stock</th>
              <th className="num hide-md" title="Avisa en Inicio cuando el stock queda en este número o menos. No es el stock.">Mínimo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groupedProducts.map((group) => (
              <Fragment key={group.key}>
                <tr className="group-row">
                  <td colSpan={productCols}>
                    {group.label} <span className="muted" style={{ fontWeight: 400 }}>({group.products.length})</span>
                  </td>
                </tr>
                {group.products.map((product) => {
                  const editing = editingId === product.id;
                  const adjusting = adjustingId === product.id;
                  const inactive = !(product.active ?? true);
                  return (
              <Fragment key={product.id}>
              <tr className={editing || adjusting ? "row-editing" : undefined}>
                <td className="hide-sm">{product.code}</td>
                <td>
                  {/* El nombre abre Editar: en pantallas chicas la columna de botones puede quedar fuera de vista. */}
                  <button className="link-button" title="Editar este producto" onClick={() => startEdit(product)}>{product.name}</button>
                  {inactive && <span className="badge" style={{ marginLeft: 6 }}>Inactivo</span>}
                  {presentationsOf(product.id).length > 0 && (
                    <span className="cell-sub">
                      {product.stockSourceId ? (
                        <>+ {presentationsOf(product.id).length} {presentationsOf(product.id).length === 1 ? "presentación" : "presentaciones"} con otro precio</>
                      ) : (
                        <button className="link-button" style={{ fontSize: 12 }} onClick={() => openPresentations(product)}>
                          + {presentationsOf(product.id).length} {presentationsOf(product.id).length === 1 ? "presentación" : "presentaciones"} con otro precio
                        </button>
                      )}
                    </span>
                  )}
                </td>
                <td className="num hide-sm">{formatMoney(product.cost)}</td>
                <td className="num hide-sm">{marginPercent(product.cost, product.priceRetail)}%</td>
                <td className="num">
                  {formatMoney(product.priceRetail)}
                  <span className="cell-sub">IVA {productVatLabel(vatRates[product.id], generalVatRate)}</span>
                </td>
                {activeLists.map((l) => {
                  const lp = product.listPrices?.[l.id];
                  return (
                    <td key={l.id} className="num">
                      {formatMoney(lp?.price ?? product.priceRetail)}
                      {lp?.manual ? <span className="cell-sub">a mano</span> : product.stockSourceId ? <span className="cell-sub">oferta</span> : null}
                    </td>
                  );
                })}
                <td className="num">
                  <span className={product.stock < 0 ? "num-negative" : undefined}>
                    {product.stock} {UNIT_LABELS[product.unit]}
                  </span>
                  {product.stock < 0 || (product.minStock > 0 && product.stock <= product.minStock) ? " ⚠" : ""}
                  {/* Solo productos por kilo (envasados al vacío): en uno por unidad, paquete = unidad y se confundía con el stock (real M2, 24/10). */}
                  {showPackages && !product.stockSourceId && product.unit === "kg" && (
                    <div style={{ fontSize: 12, fontWeight: 500 }}>
                      {packages[product.id] !== undefined ? (
                        <>
                          <strong>{packages[product.id]}</strong> {packages[product.id] === 1 ? "paquete" : "paquetes"}{" "}
                          <button className="link-button" onClick={() => void handlePackages(product, "envasado")}>Envasé</button>{" · "}
                          <button className="link-button" onClick={() => void handlePackages(product, "conteo")}>Contar</button>{" · "}
                          <button className="link-button" onClick={() => void handleClearPackages(product)}>Borrar</button>
                        </>
                      ) : (
                        <button className="link-button" onClick={() => void handlePackages(product, "conteo")}>Contar paquetes</button>
                      )}
                    </div>
                  )}
                  {product.stockSourceId && (
                    <span className="cell-sub">usa stock de {productById.get(product.stockSourceId)?.name ?? "otro producto"}</span>
                  )}
                </td>
                <td className="num hide-md">{product.minStock}</td>
                <td>
                  <div className="row-actions">
                    <button className="secondary" onClick={() => (editing ? setEditingId(null) : startEdit(product))}>{editing ? "Cerrar" : "Editar"}</button>
                    {inactive && <button className="secondary" onClick={() => void handleToggleActive(product)}>Reactivar</button>}
                    {!product.stockSourceId && (
                      <button className="secondary" title="Ajustar el stock con lo que contaste" onClick={() => (adjusting ? setAdjustingId(null) : startAdjustStock(product))}>Ajustar</button>
                    )}
                  </div>
                </td>
              </tr>
              {editing && (
                <tr className="row-editor">
                  <td colSpan={productCols}>
                    <div className="form-grid">
                      <label title="Código o código de barras (se puede escanear)">Código<input value={editDraft.code} onChange={(e) => setEditDraft({ ...editDraft, code: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} /></label>
                      <label className="span-2">Nombre<input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} /></label>
                      <label>
                        Categoría
                        <select value={editDraft.categoryId} onChange={(e) => setEditDraft({ ...editDraft, categoryId: e.target.value })}>
                          <option value="">Sin categoría</option>
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Unidad
                        <select value={editDraft.unit} onChange={(e) => setEditDraft({ ...editDraft, unit: e.target.value as Product["unit"] })}>
                          <option value="kg">kg</option>
                          <option value="unit">unidad</option>
                          <option value="box">caja</option>
                        </select>
                      </label>
                      <label>
                        Costo $
                        <input type="text" inputMode="decimal" className="num" value={editDraft.cost} onChange={(e) => onCostOrMarginChange(editDraft, setEditDraft, "cost")(e.target.value)} />
                      </label>
                      <label>
                        Margen %
                        <input type="text" inputMode="decimal" className="num" value={editDraft.margin} onChange={(e) => onCostOrMarginChange(editDraft, setEditDraft, "margin")(e.target.value)} />
                      </label>
                      <label>
                        {activeLists.length > 0 ? "Precio minorista $" : "Precio de venta $"}
                        <input type="text" inputMode="decimal" className="num" value={editDraft.priceRetail} onChange={(e) => onPriceChange(editDraft, setEditDraft)(e.target.value)} />
                      </label>
                      {renderListPriceInputs(editDraft, setEditDraft, Boolean(product.stockSourceId || editLink.linked))}
                      <label>
                        IVA
                        <select value={editDraft.vatRate} onChange={(e) => setEditDraft({ ...editDraft, vatRate: e.target.value })}>
                          <option value="">{productVatLabel(null, generalVatRate)}</option>
                          {PRODUCT_VAT_OPTIONS.map((r) => (
                            <option key={r} value={String(r)}>{vatPercentLabel(r)}</option>
                          ))}
                        </select>
                      </label>
                      {!product.stockSourceId && (
                        <label title="El stock que hay hoy. Si lo cambiás, queda registrado como ajuste de stock.">
                          Stock hoy ({UNIT_LABELS[editDraft.unit]})
                          <input type="text" inputMode="decimal" className="num" value={editDraft.stock} onFocus={(e) => e.target.select()} onChange={(e) => setEditDraft({ ...editDraft, stock: e.target.value })} />
                        </label>
                      )}
                      <label title="Solo para que avise en Inicio cuando quede poco. No es el stock.">
                        Mínimo (aviso)
                        <input type="text" inputMode="decimal" className="num" value={editDraft.minStock} onChange={(e) => setEditDraft({ ...editDraft, minStock: e.target.value })} />
                      </label>
                      <label>
                        Estado
                        <select value={editDraft.active ? "1" : "0"} onChange={(e) => setEditDraft({ ...editDraft, active: e.target.value === "1" })}>
                          <option value="1">Activo</option>
                          <option value="0">Inactivo</option>
                        </select>
                      </label>
                    </div>
                    {renderListPriceHint(editDraft, Boolean(product.stockSourceId || editLink.linked))}
                    <div className="form-actions">
                      <button onClick={handleUpdate}>Guardar</button>
                      <button className="secondary" onClick={() => setEditingId(null)}>Cancelar</button>
                      <span className="spacer" />
                      {(product.active ?? true) && (
                        <button className="link-button" onClick={() => { setEditingId(null); void handleToggleActive(product); }}>Dar de baja</button>
                      )}
                      <button className="link-button" onClick={() => { setEditingId(null); void handleDelete(product); }}>Eliminar</button>
                    </div>
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #e5e7eb" }}>{renderStockBlock(product)}</div>
                  </td>
                </tr>
              )}
              {adjusting && (
                <tr className="row-editor">
                  <td colSpan={productCols}>
                    <div className="form-grid">
                      <label>
                        ¿Cuánto hay? ({UNIT_LABELS[product.unit]})
                        <input type="text" inputMode="decimal" className="num" autoFocus value={adjustCounted} onFocus={(e) => e.target.select()} onChange={(e) => setAdjustCounted(e.target.value)} />
                      </label>
                      <label className="span-2">
                        Motivo
                        <input placeholder="Ej. conteo, merma" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} />
                      </label>
                      <span className="muted" style={{ alignSelf: "center", fontSize: 13 }}>Registrado: {product.stock} {UNIT_LABELS[product.unit]}</span>
                    </div>
                    <div className="form-actions">
                      <button onClick={handleAdjustStock}>Guardar ajuste</button>
                      <button className="secondary" onClick={() => setAdjustingId(null)}>Cancelar</button>
                    </div>
                  </td>
                </tr>
              )}
              {presentationsOfId === product.id && !editing && !product.stockSourceId && (
                <tr className="row-editor">
                  <td colSpan={productCols}>{renderPresentationsPanel(product)}</td>
                </tr>
              )}
              </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
        {visibleProducts.length === 0 && !loading && <p className="muted">{searchText ? `Ningún producto coincide con "${productSearch.trim()}".` : "No hay productos para mostrar."}</p>}

      </section>
    </>
  );
}
