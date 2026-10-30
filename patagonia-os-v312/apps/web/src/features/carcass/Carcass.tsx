import { useEffect, useMemo, useState } from "react";
import type { CarcassBatch, CarcassCut, CarcassCutTemplate, CarcassFillSource, Product } from "@patagonia/domain";
import { allocateCarcassCost, marginPercent } from "@patagonia/domain";
import { carcassYield } from "./carcass-yield";
import { useCarcass } from "./useCarcass";
import { useCarcassTemplates } from "./useCarcassTemplates";
import { applyCarcassCosts, fillCarcassBatch, listCarcassBatchTotals, markCarcassBatchWeighed, type CarcassBatchTotals } from "./carcass-service";
import { useAuth } from "../auth/AuthProvider";
import { applyDefaultCarcassCuts, listDefaultCarcassCuts, type DefaultCarcassCut } from "./carcass-templates-service";
import { animalTypeLabel, buildTypeChips, carcassNorm, carcassTypeKey, findSameType, initialType } from "./carcass-types";
import { useSuppliers } from "../purchases/useSuppliers";
import { useActiveBranch } from "../branches/BranchProvider";
import { listProductsForBranch } from "../inventory/inventory-service";
import { todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { quantityNumber } from "../sale/quantity";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

function formatKg(value: number) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(value);
}

function shortDate(iso: string) {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

/** Peso de "uno típico" si el negocio no puso el suyo (solo para mostrar los cortes de siempre en kilos). */
const TYPICAL_WEIGHT: Record<string, number> = { mediares: 110, cerdo: 90, pollo: 20 };

function refWeightStorageKey(type: string) {
  return `patagonia-carcass-ref-weight-${type}`;
}

function readRefWeight(type: string): string {
  try {
    return localStorage.getItem(refWeightStorageKey(type)) ?? "";
  } catch {
    return "";
  }
}

const sameKey = (a: string, b: string) => carcassTypeKey(a) === carcassTypeKey(b);

export function Carcass() {
  const { batches, loading, error, reload: reloadBatches, saveBatch, removeBatch, cuts: loadedCuts, cutsLoading, loadCuts, saveCut, removeCut } = useCarcass();
  const { templates, reload: reloadTemplates, save: saveTemplate, remove: removeTemplate } = useCarcassTemplates();
  const { suppliers } = useSuppliers();
  const { branchId } = useActiveBranch();
  const [products, setProducts] = useState<Product[]>([]);
  const [defaults, setDefaults] = useState<DefaultCarcassCut[]>([]);
  const [totals, setTotals] = useState<Map<string, CarcassBatchTotals>>(new Map());

  const [message, setMessage] = useState("");
  const { profile } = useAuth();
  // 'costo_parejo' (migración 170, se prende desde el panel de plataforma): todos los cortes cuestan lo mismo por kilo.
  const evenCost = Boolean(profile?.features?.includes("costo_parejo"));
  const canApplyCosts = profile?.role === "owner" || profile?.role === "admin";
  const [busy, setBusy] = useState(false);

  // Qué se desposta: los botones de arriba.
  const [selectedType, setSelectedType] = useState("");
  const [extraTypes, setExtraTypes] = useState<string[]>([]);
  const [showMore, setShowMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [showTemplates, setShowTemplates] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);

  // Res cargada a mano (sin factura): escondida en "Más opciones".
  const [showBatchForm, setShowBatchForm] = useState(false);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [batchDate, setBatchDate] = useState(todayIso());
  const [supplierId, setSupplierId] = useState("");
  const [totalWeight, setTotalWeight] = useState("");
  const [pricePerKg, setPricePerKg] = useState("");

  const [cutName, setCutName] = useState("");
  const [cutWeight, setCutWeight] = useState("");
  const [cutPrice, setCutPrice] = useState("");

  const [refWeight, setRefWeight] = useState("");
  const [tplName, setTplName] = useState("");
  const [tplKg, setTplKg] = useState("");
  const [tplProductId, setTplProductId] = useState("");

  useEffect(() => {
    if (!branchId) return;
    listProductsForBranch(branchId).then(setProducts).catch(() => setProducts([]));
  }, [branchId]);

  useEffect(() => {
    listDefaultCarcassCuts().then(setDefaults).catch(() => setDefaults([]));
  }, []);

  useEffect(() => {
    listCarcassBatchTotals(batches.map((b) => b.id)).then(setTotals).catch(() => setTotals(new Map()));
  }, [batches]);

  const chips = useMemo(
    () => buildTypeChips(batches.map((b) => b.animalType), [...templates.map((t) => t.animalType), ...extraTypes]),
    [batches, templates, extraTypes]
  );

  // Al abrir: el animal de la última res.
  useEffect(() => {
    if (selectedType || loading) return;
    setSelectedType(initialType(chips, batches[0]?.animalType));
  }, [chips, batches, loading, selectedType]);

  const typeBatches = useMemo(() => batches.filter((b) => sameKey(b.animalType, selectedType)), [batches, selectedType]);
  const typeTemplates = useMemo(
    () => templates.filter((t) => sameKey(t.animalType, selectedType)).sort((a, b) => a.sortOrder - b.sortOrder),
    [templates, selectedType]
  );
  const typeDefaults = useMemo(() => defaults.filter((d) => d.typeKey === carcassTypeKey(selectedType)), [defaults, selectedType]);
  const label = animalTypeLabel(selectedType);

  // Al cambiar de animal: la última res de ese animal.
  useEffect(() => {
    setSelectedId(typeBatches[0]?.id ?? null);
    setShowBatchForm(false);
    setRefWeight(readRefWeight(selectedType));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType]);

  useEffect(() => {
    if (!selectedId && typeBatches.length > 0) setSelectedId(typeBatches[0].id);
  }, [typeBatches, selectedId]);

  useEffect(() => {
    if (selectedId) void loadCuts(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const selectedBatch = typeBatches.find((b) => b.id === selectedId) ?? null;
  // Solo los de la res elegida (al cambiar de res, los de la anterior siguen un momento hasta que llegan los nuevos).
  const cuts = useMemo(() => loadedCuts.filter((c) => c.batchId === selectedId), [loadedCuts, selectedId]);

  // El costo de cada corte pasa solo a Stock (migración 123): se recargan los productos para mostrar el de hoy.
  useEffect(() => {
    if (!branchId || !selectedBatch) return;
    listProductsForBranch(branchId).then(setProducts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuts, selectedBatch?.totalCost]);

  const productsByNorm = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of products) {
      const key = carcassNorm(p.name);
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return map;
  }, [products]);
  const sortedProducts = useMemo(() => [...products].sort((a, b) => a.name.localeCompare(b.name, "es")), [products]);

  /** El producto que se llama igual que el corte, si hay uno solo. */
  function productForName(name: string): Product | undefined {
    const found = productsByNorm.get(carcassNorm(name)) ?? [];
    return found.length === 1 ? found[0] : undefined;
  }

  function totalsFor(batch: CarcassBatch): CarcassBatchTotals | undefined {
    if (batch.id === selectedBatch?.id && !cutsLoading && (cuts.length > 0 || !totals.has(batch.id))) {
      return {
        value: cuts.reduce((s, c) => s + c.lineTotal, 0),
        weight: cuts.reduce((s, c) => s + c.weight, 0),
        cuts: cuts.length,
        unpriced: cuts.filter((c) => c.unitPrice <= 0 && c.weight > 0).length,
        estimated: cuts.filter((c) => c.fromTemplate).length
      };
    }
    return totals.get(batch.id);
  }

  function supplierName(id?: string) {
    return id ? suppliers.find((s) => s.id === id)?.name : undefined;
  }

  async function refreshTotals() {
    setTotals(await listCarcassBatchTotals(batches.map((b) => b.id)).catch(() => totals));
  }

  // ---------- Qué se desposta ----------

  function chooseType(type: string) {
    setSelectedType(type);
    setShowMore(false);
    setAdding(false);
    setMessage("");
  }

  const sameAsNew = newTypeName.trim() ? findSameType(newTypeName, chips.all) : undefined;

  function addType(useExisting: boolean) {
    const name = newTypeName.trim();
    if (!name) return;
    if (useExisting && sameAsNew) {
      chooseType(sameAsNew);
    } else {
      setExtraTypes((prev) => [...prev, name]);
      chooseType(name);
    }
    setNewTypeName("");
  }

  // ---------- Cortes de una res ----------

  const selectedTotals = selectedBatch ? totalsFor(selectedBatch) : undefined;
  const value = selectedTotals?.value ?? 0;
  const ganancia = selectedBatch ? value - selectedBatch.totalCost : 0;
  const realCosts = useMemo(() => (selectedBatch ? allocateCarcassCost(selectedBatch.totalCost, cuts, evenCost ? "average" : "value") : []), [selectedBatch, cuts, evenCost]);
  const costPerKgByProduct = useMemo(() => new Map(realCosts.map((l) => [l.productId, l.costPerKg])), [realCosts]);
  const unpricedCuts = cuts.filter((c) => c.unitPrice <= 0 && c.weight > 0).length;
  const cutsWeight = cuts.reduce((s, c) => s + c.weight, 0);
  const yieldPct = selectedBatch && selectedBatch.totalWeight > 0 ? Math.round((cutsWeight / selectedBatch.totalWeight) * 1000) / 10 : 0;
  // Cortes que repartió el sistema y nadie corrigió; 0 (con cortes) = pesada de verdad, sirve para aprender.
  const estimatedCuts = cuts.filter((c) => c.fromTemplate).length;
  const yieldInfo = selectedBatch ? carcassYield(selectedBatch.totalCost, selectedBatch.totalWeight, cuts) : null;

  async function updateCut(cut: CarcassCut, changes: Partial<Pick<CarcassCut, "weight" | "unitPrice" | "productId">>) {
    if (!selectedBatch) return;
    try {
      await saveCut({
        id: cut.id,
        batchId: selectedBatch.id,
        cutName: cut.cutName,
        productId: changes.productId ?? cut.productId,
        weight: changes.weight ?? cut.weight,
        unitPrice: changes.unitPrice ?? cut.unitPrice
      });
      setMessage("");
      void refreshTotals();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el corte.");
    }
  }

  function handleWeightBlur(cut: CarcassCut, raw: string) {
    const weight = quantityNumber(raw);
    if (!Number.isFinite(weight) || weight < 0) {
      setMessage("Los kilos no son un número válido.");
      return;
    }
    if (Math.abs(weight - cut.weight) < 0.0005) return;
    void updateCut(cut, { weight });
  }

  function handlePriceBlur(cut: CarcassCut, raw: string) {
    const price = parseAmount(raw || "0");
    if (!Number.isFinite(price) || price < 0) {
      setMessage("El precio no es un número válido.");
      return;
    }
    if (Math.abs(price - cut.unitPrice) < 0.005) return;
    void updateCut(cut, { unitPrice: price });
  }

  function handleLinkProduct(cut: CarcassCut, productId: string) {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    void updateCut(cut, { productId, unitPrice: cut.unitPrice > 0 ? cut.unitPrice : product.priceRetail });
  }

  async function handleDeleteCut(cut: CarcassCut) {
    if (!selectedBatch || !window.confirm(`¿Quitar "${cut.cutName}" de esta res?`)) return;
    try {
      await removeCut(cut.id, selectedBatch.id);
      void refreshTotals();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo quitar.");
    }
  }

  async function handleAddCut() {
    if (!selectedBatch) return;
    try {
      const name = cutName.trim();
      if (!name) throw new Error("Escribí el corte.");
      const weight = quantityNumber(cutWeight);
      if (!Number.isFinite(weight) || weight <= 0) throw new Error("Poné los kilos del corte.");
      const product = productForName(name);
      const price = cutPrice.trim() ? parseAmount(cutPrice) : product?.priceRetail ?? NaN;
      if (!Number.isFinite(price) || price < 0) throw new Error(`Poné el precio de venta de "${name}" (no hay un producto de Stock que se llame así).`);
      await saveCut({ batchId: selectedBatch.id, cutName: name, productId: product?.id, weight, unitPrice: price });
      setCutName("");
      setCutWeight("");
      setCutPrice("");
      setMessage(product ? `"${name}" agregado y sumado al stock.` : `"${name}" agregado.`);
      void refreshTotals();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo agregar el corte.");
    }
  }

  // ---------- Res cargada a mano ----------

  /** Reparte una res sin cortes en la base: promedio de las pesadas parecidas o cortes de siempre (con useDefaults,
   * si no hay, primero copia los típicos). */
  async function fillBatch(batchId: string, useDefaults: boolean): Promise<{ cuts: number; source?: CarcassFillSource }> {
    try {
      const result = await fillCarcassBatch(batchId, useDefaults);
      if (useDefaults && typeTemplates.length === 0) await reloadTemplates();
      return result;
    } finally {
      await Promise.all([loadCuts(batchId), reloadBatches()]);
    }
  }

  function fillMessage(result: { cuts: number; source?: CarcassFillSource }) {
    if (result.cuts === 0) return `No hay cortes de siempre de ${label}: cargá los cortes abajo.`;
    if (result.source?.kind === "learned") {
      return `Repartida en ${result.cuts} cortes con el promedio de tus ${result.source.batches} pesadas de ${formatKg(result.source.min)} a ${formatKg(result.source.max)} kg.`;
    }
    return `Repartida en ${result.cuts} cortes con tus cortes de siempre. Si la pesaste, corregí los kilos.`;
  }

  /** Escribe en Stock el costo por kilo de esta res (lo mismo que pasa solo al tocar un corte). */
  async function handleApplyCosts() {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      const r = await applyCarcassCosts(selectedBatch.id);
      if (r.blocked) setMessage(r.blocked);
      else setMessage(r.updated > 0 ? `Listo: se actualizó el costo de ${r.updated} ${r.updated === 1 ? "producto" : "productos"} en Stock.` : "Los costos en Stock ya estaban al día.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron actualizar los costos.");
    } finally {
      setBusy(false);
    }
  }

  async function handleMarkWeighed() {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      await markCarcassBatchWeighed(selectedBatch.id);
      await loadCuts(selectedBatch.id);
      void refreshTotals();
      setMessage("Listo: quedó como pesada. Las próximas de peso parecido se van a repartir con lo que pesaste.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  function openBatchForm(batch?: CarcassBatch) {
    setEditingBatchId(batch?.id ?? null);
    setBatchDate(batch?.batchDate ?? todayIso());
    setSupplierId(batch?.supplierId ?? "");
    setTotalWeight(batch ? String(batch.totalWeight) : "");
    setPricePerKg(batch && batch.totalWeight > 0 ? String(Math.round((batch.totalCost / batch.totalWeight) * 100) / 100) : "");
    setShowBatchForm(true);
  }

  async function handleSaveBatch() {
    try {
      const weight = quantityNumber(totalWeight || "0");
      const price = parseAmount(pricePerKg || "0");
      if (!Number.isFinite(weight) || weight <= 0) throw new Error("Poné el peso total.");
      if (!Number.isFinite(price) || price <= 0) throw new Error("Poné el precio por kg.");
      setBusy(true);
      const result = await saveBatch({
        id: editingBatchId ?? undefined,
        batchDate,
        animalType: selectedType,
        supplierId: supplierId || undefined,
        totalWeight: weight,
        totalCost: weight * price
      });
      setShowBatchForm(false);
      setShowMoreOptions(false);
      setSelectedId(result.id);
      if (!editingBatchId) {
        // Los típicos solos solo la primera vez (igual que una compra): quien ya cargaba a mano sigue igual.
        setMessage(fillMessage(await fillBatch(result.id, typeBatches.length === 0)));
      } else {
        setMessage("Res corregida.");
      }
      void refreshTotals();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteBatch(batch: CarcassBatch) {
    const question = batch.purchaseItemId
      ? "Esta res vino de una compra. Si la quitás, también se anula esa compra (deja de contar en lo que le debés al proveedor) y se borran sus cortes y su stock. No se puede deshacer. ¿Quitarla?"
      : "¿Quitar esta res y sus cortes? No se puede deshacer.";
    if (!window.confirm(question)) return;
    try {
      await removeBatch(batch.id);
      setSelectedId(null);
      setMessage(batch.purchaseItemId ? "Res quitada y su compra anulada." : "Res quitada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo quitar.");
    }
  }

  async function handleRefill() {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      setMessage(fillMessage(await fillBatch(selectedBatch.id, true)));
      void refreshTotals();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo repartir.");
    } finally {
      setBusy(false);
    }
  }

  // ---------- Cortes de siempre ----------

  const refKg = quantityNumber(refWeight) > 0 ? quantityNumber(refWeight) : TYPICAL_WEIGHT[carcassTypeKey(selectedType)] ?? (typeBatches[0]?.totalWeight || 100);
  const pctToKg = (pct: number) => Math.round(((pct / 100) * refKg) * 1000) / 1000;
  const templateSum = typeTemplates.reduce((s, t) => s + t.yieldPercent, 0);
  const templatesWithoutProduct = typeTemplates.filter((t) => !t.productId).length;

  function handleRefWeightChange(value: string) {
    setRefWeight(value);
    try {
      localStorage.setItem(refWeightStorageKey(selectedType), value);
    } catch {
      // sin localStorage no se recuerda, no es grave
    }
  }

  function kgToPct(raw: string): number {
    const kg = quantityNumber(raw);
    if (!Number.isFinite(kg) || kg <= 0) throw new Error("Poné los kilos del corte.");
    const pct = Math.round((kg / refKg) * 10000) / 100;
    if (pct > 100) throw new Error(`Ese corte pesaría más que uno entero (${formatKg(refKg)} kg).`);
    return Math.max(pct, 0.01);
  }

  async function updateTemplate(t: CarcassCutTemplate, changes: { kg?: string; productId?: string }) {
    try {
      const yieldPercent = changes.kg !== undefined ? kgToPct(changes.kg) : t.yieldPercent;
      if (changes.kg !== undefined && Math.abs(yieldPercent - t.yieldPercent) < 0.005) return;
      await saveTemplate({
        id: t.id,
        animalType: t.animalType,
        cutName: t.cutName,
        yieldPercent,
        productId: changes.productId !== undefined ? changes.productId || undefined : t.productId,
        sortOrder: t.sortOrder
      });
      setMessage("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar.");
    }
  }

  async function handleAddTemplate() {
    try {
      const name = tplName.trim();
      if (!name) throw new Error("Escribí el corte.");
      const yieldPercent = kgToPct(tplKg);
      const product = tplProductId ? products.find((p) => p.id === tplProductId) : productForName(name);
      await saveTemplate({
        animalType: typeTemplates[0]?.animalType ?? selectedType,
        cutName: name,
        yieldPercent,
        productId: product?.id,
        sortOrder: (typeTemplates[typeTemplates.length - 1]?.sortOrder ?? 0) + 1
      });
      setTplName("");
      setTplKg("");
      setTplProductId("");
      setMessage("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo agregar.");
    }
  }

  async function handleDeleteTemplate(t: CarcassCutTemplate) {
    if (!window.confirm(`¿Sacar "${t.cutName}" de los cortes de siempre?`)) return;
    try {
      await removeTemplate(t.id);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo sacar.");
    }
  }

  async function handleUseDefaults() {
    setBusy(true);
    try {
      const n = await applyDefaultCarcassCuts(selectedType);
      await reloadTemplates();
      setShowTemplates(true);
      setMessage(n > 0 ? `Listo: ${n} cortes típicos de ${label}. Corregí los kilos o el producto si en tu negocio es distinto.` : "Ya tenías cortes de siempre.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron cargar los cortes típicos.");
    } finally {
      setBusy(false);
    }
  }

  // ---------- Titular ----------

  const latestWithCuts = typeBatches.find((b) => (totalsFor(b)?.cuts ?? 0) > 0);
  const latestTotals = latestWithCuts ? totalsFor(latestWithCuts) : undefined;
  const latestGain = latestWithCuts && latestTotals ? latestTotals.value - latestWithCuts.totalCost : 0;

  const suggestionNames = useMemo(() => {
    const names = new Set<string>();
    typeTemplates.forEach((t) => names.add(t.cutName));
    typeDefaults.forEach((d) => names.add(d.cutName));
    return [...names];
  }, [typeTemplates, typeDefaults]);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">DESPIECE</p>
          <h1>Despiece</h1>
          {latestWithCuts && latestTotals && (
            <p className="carcass-headline">
              Tu última {label.toLowerCase()} ({shortDate(latestWithCuts.batchDate)}) te dejó{" "}
              <strong className={latestGain < 0 ? "num-negative" : "num-positive"}>{formatMoney(latestGain)}</strong>
              {latestTotals.value > 0 && ` (${marginPercent(latestWithCuts.totalCost, latestTotals.value)}%)`}
              {latestTotals.unpriced > 0 && <span className="muted"> · faltan precios de {latestTotals.unpriced} cortes</span>}
            </p>
          )}
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <p className="carcass-question">¿Qué despostás?</p>
      <div className="type-chips">
        {chips.visible.map((type) => (
          <button key={type} type="button" className={`type-chip${sameKey(type, selectedType) ? " active" : ""}`} onClick={() => chooseType(type)}>
            {animalTypeLabel(type)}
          </button>
        ))}
        {chips.more.length > 0 && (
          <span className="type-chip-more">
            <button
              type="button"
              className={`type-chip${chips.more.some((t) => sameKey(t, selectedType)) ? " active" : ""}`}
              onClick={() => setShowMore((v) => !v)}
            >
              {chips.more.find((t) => sameKey(t, selectedType)) ? animalTypeLabel(chips.more.find((t) => sameKey(t, selectedType))!) : "Más"} ▾
            </button>
            {showMore && (
              <span className="type-chip-menu">
                {chips.more.map((type) => (
                  <button key={type} type="button" onClick={() => chooseType(type)}>{animalTypeLabel(type)}</button>
                ))}
              </span>
            )}
          </span>
        )}
        {!adding && (
          <button type="button" className="type-chip add" onClick={() => setAdding(true)}>+ Agregar</button>
        )}
      </div>
      {adding && (
        <div className="form-box carcass-add-type">
          <div className="row-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
            <input
              autoFocus
              autoComplete="off"
              placeholder="Ej. Capón, Cordero"
              value={newTypeName}
              onChange={(e) => setNewTypeName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !sameAsNew) addType(false); }}
              style={{ maxWidth: 260 }}
            />
            {!sameAsNew && <button type="button" disabled={!newTypeName.trim()} onClick={() => addType(false)}>Agregar</button>}
            <button type="button" className="secondary" onClick={() => { setAdding(false); setNewTypeName(""); }}>Cancelar</button>
          </div>
          {sameAsNew && (
            <div className="carcass-same-type">
              Ya tenés <strong>{animalTypeLabel(sameAsNew)}</strong>. ¿Es lo mismo?
              <div className="row-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>
                <button type="button" onClick={() => addType(true)}>Sí, usar {animalTypeLabel(sameAsNew)}</button>
                <button type="button" className="secondary" onClick={() => addType(false)}>No, es otra cosa</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="carcass-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>{label} que entró</h2>
          </div>
          {loading && <p className="muted">Cargando…</p>}
          {!loading && typeBatches.length === 0 && (
            <p className="muted">
              Todavía no hay {label.toLowerCase()}. Cargá la factura en <strong>Compras</strong> y marcá el renglón "Para despostar": aparece acá sola.
            </p>
          )}
          <div className="carcass-batches">
            {typeBatches.map((b) => {
              const t = totalsFor(b);
              const gain = t ? t.value - b.totalCost : 0;
              const supplier = supplierName(b.supplierId);
              return (
                <button key={b.id} type="button" className={`carcass-batch${b.id === selectedId ? " selected" : ""}`} onClick={() => setSelectedId(b.id)}>
                  <span>
                    <strong>{shortDate(b.batchDate)} · {formatKg(b.totalWeight)} kg</strong>
                    <span className="carcass-batch-tags">
                      {supplier && <span className="badge brand">{supplier}</span>}
                      {t && t.cuts > 0 && t.estimated === 0 && <span className="badge ok">Pesada</span>}
                    </span>
                  </span>
                  <span className="num">
                    <strong>{formatMoney(b.totalCost)}</strong>
                    {t && t.cuts > 0 ? (
                      <small className={gain < 0 ? "num-negative" : "num-positive"}>ganás {formatMoney(gain)}</small>
                    ) : (
                      <small className="muted">sin cortes</small>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="carcass-box">
            <div>
              <strong>Cortes de siempre</strong>
              <small className="muted">
                {typeTemplates.length > 0
                  ? `${typeTemplates.length} cortes · uno típico pesa ${formatKg(refKg)} kg`
                  : typeDefaults.length > 0
                    ? `Todavía no los usás. Hay ${typeDefaults.length} cortes típicos listos.`
                    : "Todavía no hay. Cargalos para que cada compra se reparta sola."}
              </small>
            </div>
            <button type="button" className="secondary" onClick={() => setShowTemplates((v) => !v)}>{showTemplates ? "Cerrar" : "Ver"}</button>
          </div>

          <button type="button" className="link-button carcass-more" onClick={() => setShowMoreOptions((v) => !v)}>
            Más opciones {showMoreOptions ? "▾" : "▸"}
          </button>
          {showMoreOptions && !showBatchForm && (
            <div className="row-actions" style={{ justifyContent: "flex-start", marginTop: 6 }}>
              <button type="button" className="secondary" onClick={() => openBatchForm()}>Cargar {label.toLowerCase()} sin factura</button>
            </div>
          )}
          {showBatchForm && (
            <div className="form-box" style={{ marginTop: 10 }}>
              <h3 style={{ margin: "0 0 4px" }}>{editingBatchId ? "Corregir" : `${label} sin factura`}</h3>
              <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>No genera deuda con el proveedor. Si tenés factura, cargala en Compras.</p>
              <div className="form-grid">
                <label>Fecha<input type="date" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} /></label>
                <label>
                  Proveedor
                  <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">Sin proveedor</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label>Peso total (kg)<input type="text" inputMode="decimal" value={totalWeight} onChange={(e) => setTotalWeight(e.target.value)} /></label>
                <label>Precio por kg ($)<input type="text" inputMode="decimal" value={pricePerKg} onChange={(e) => setPricePerKg(e.target.value)} /></label>
              </div>
              <div className="form-actions">
                <button type="button" disabled={busy} onClick={handleSaveBatch}>{busy ? "Guardando…" : "Guardar"}</button>
                <button type="button" className="secondary" onClick={() => setShowBatchForm(false)}>Cancelar</button>
              </div>
            </div>
          )}
        </section>

        <div className="carcass-right">
          {showTemplates && (
            <section className="panel">
              <div className="panel-title">
                <h2>Cortes de siempre · {label}</h2>
                <button type="button" className="secondary" onClick={() => setShowTemplates(false)}>Cerrar</button>
              </div>
              <p className="muted" style={{ marginTop: -6 }}>Cada compra de {label.toLowerCase()} se reparte sola en estos cortes, en proporción a lo que pesa.</p>
              {typeTemplates.length === 0 && typeDefaults.length > 0 && (
                <div className="carcass-box" style={{ marginBottom: 12 }}>
                  <div>
                    <strong>Usar los cortes típicos</strong>
                    <small className="muted">{typeDefaults.map((d) => d.cutName).join(", ")}</small>
                  </div>
                  <button type="button" disabled={busy} onClick={handleUseDefaults}>Usar estos</button>
                </div>
              )}
              <label className="carcass-ref">
                Uno típico pesa
                <input type="text" inputMode="decimal" placeholder={formatKg(refKg)} value={refWeight} onChange={(e) => handleRefWeightChange(e.target.value)} />
                kg
              </label>
              {typeTemplates.length > 0 && (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr><th>Corte</th><th className="num">Kilos</th><th>Producto de Stock</th><th></th></tr>
                    </thead>
                    <tbody>
                      {typeTemplates.map((t) => (
                        <tr key={`${t.id}-${t.yieldPercent}-${t.productId ?? ""}-${refKg}`}>
                          <td>{t.cutName}</td>
                          <td className="num">
                            <input
                              className="carcass-kg"
                              type="text"
                              inputMode="decimal"
                              defaultValue={formatKg(pctToKg(t.yieldPercent))}
                              onFocus={(e) => e.target.select()}
                              onBlur={(e) => void updateTemplate(t, { kg: e.target.value })}
                            />
                          </td>
                          <td>
                            <select value={t.productId ?? ""} onChange={(e) => void updateTemplate(t, { productId: e.target.value })}>
                              <option value="">Sin producto (no suma stock)</option>
                              {sortedProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button type="button" className="danger" aria-label={`Sacar ${t.cutName}`} onClick={() => void handleDeleteTemplate(t)}>✕</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {typeTemplates.length > 0 && (
                <p className="muted" style={{ fontSize: 13 }}>
                  Suman {formatKg(pctToKg(templateSum))} kg de {formatKg(refKg)} ({Math.round(templateSum * 10) / 10}%). El resto es hueso, grasa y merma.
                  {templatesWithoutProduct > 0 && <> <strong>{templatesWithoutProduct} sin producto:</strong> no suman stock ni tienen precio.</>}
                </p>
              )}
              <div className="carcass-add-row">
                <input autoComplete="off" list="carcass-cut-names" placeholder="Corte" value={tplName} onChange={(e) => setTplName(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Kilos" value={tplKg} onChange={(e) => setTplKg(e.target.value)} />
                <select value={tplProductId} onChange={(e) => setTplProductId(e.target.value)}>
                  <option value="">Producto (el que se llame igual)</option>
                  {sortedProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button type="button" onClick={() => void handleAddTemplate()}>Agregar</button>
              </div>
            </section>
          )}

          {!showTemplates && !selectedBatch && (
            <section className="panel">
              <p className="muted">Tocá una compra de la izquierda para ver cuánto te dejó.</p>
            </section>
          )}

          {!showTemplates && selectedBatch && (
            <section className="panel print-area">
              <div className="panel-title">
                <h2>
                  {label} del {shortDate(selectedBatch.batchDate)} · {formatKg(selectedBatch.totalWeight)} kg
                  {supplierName(selectedBatch.supplierId) && <span className="muted" style={{ fontWeight: 500 }}> · {supplierName(selectedBatch.supplierId)}</span>}
                </h2>
                <div className="row-actions no-print">
                  {!selectedBatch.purchaseItemId && (
                    <button type="button" className="secondary" onClick={() => { setShowMoreOptions(true); openBatchForm(selectedBatch); }}>Corregir</button>
                  )}
                  {/* También la que vino de una compra (171): se anula esa compra y se borra de todos lados. */}
                  <button type="button" className="danger" onClick={() => void handleDeleteBatch(selectedBatch)}>Quitar</button>
                  <button type="button" className="secondary" onClick={() => window.print()}>Imprimir</button>
                </div>
              </div>

              <div className="kpi-grid carcass-kpis">
                <div className="kpi-card"><span>Pagaste</span><strong>{formatMoney(selectedBatch.totalCost)}</strong></div>
                <div className="kpi-card"><span>Vale vendido</span><strong>{cutsLoading ? "…" : formatMoney(value)}</strong></div>
                <div className="kpi-card">
                  <span>Ganás</span>
                  <strong className={ganancia < 0 ? "num-negative" : "num-positive"}>{cutsLoading ? "…" : formatMoney(ganancia)}</strong>
                  {value > 0 && <small>{marginPercent(selectedBatch.totalCost, value)}%</small>}
                </div>
              </div>

              {!cutsLoading && yieldInfo && (
                <p className="muted" style={{ margin: "8px 0" }}>
                  Aprovechás {formatKg(yieldInfo.usableKg)} kg de {formatKg(selectedBatch.totalWeight)} ({String(yieldInfo.usablePct).replace(".", ",")}%):
                  el kilo aprovechable te sale <strong>{formatMoney(yieldInfo.avgCostPerKg)}</strong>{evenCost ? "" : " en promedio"}.
                  {evenCost
                    ? " Todos los cortes te cuestan eso por kilo (el hueso y la grasa sin precio son merma); cada uno deja su margen."
                    : " Cada corte paga según lo que vale (columna \"Te cuesta el kg\"), así todos dejan el mismo margen."}
                </p>
              )}

              {unpricedCuts > 0 && (
                <div className="message warning no-print">
                  {unpricedCuts === 1 ? "1 corte no tiene" : `${unpricedCuts} cortes no tienen`} precio: elegí su producto de Stock en la tabla (o poné el precio), si no "Ganás" queda más bajo de lo real.
                </div>
              )}
              {cuts.length > 0 && estimatedCuts === 0 && (
                <p className="carcass-note ok no-print">✓ Pesada de verdad: las próximas de peso parecido se reparten con lo que pesaste.</p>
              )}
              {estimatedCuts > 0 && (
                <div className="carcass-note no-print">
                  <span>
                    {selectedBatch.fillSource?.kind === "learned"
                      ? `Repartida con el promedio de tus ${selectedBatch.fillSource.batches} pesadas de ${formatKg(selectedBatch.fillSource.min)} a ${formatKg(selectedBatch.fillSource.max)} kg.`
                      : "Repartida con tus cortes de siempre."}{" "}
                    Si la pesaste, corregí los kilos y tocá <strong>Listo, la pesé</strong>: así las próximas salen más exactas.
                  </span>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void handleMarkWeighed()}>Listo, la pesé</button>
                </div>
              )}

              {cuts.length === 0 && !cutsLoading && (
                <div className="carcass-box no-print" style={{ marginBottom: 12 }}>
                  <div>
                    <strong>Sin cortes</strong>
                    <small className="muted">{typeTemplates.length > 0 || typeDefaults.length > 0 ? "Repartila con los cortes de siempre o cargalos abajo." : "Cargá los cortes abajo."}</small>
                  </div>
                  {(typeTemplates.length > 0 || typeDefaults.length > 0) && (
                    <button type="button" disabled={busy} onClick={() => void handleRefill()}>{busy ? "Repartiendo…" : "Repartir"}</button>
                  )}
                </div>
              )}

              {cuts.length > 0 && (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr><th>Corte</th><th className="num">Kilos</th><th className="num">Precio venta</th><th className="num">Te cuesta el kg</th><th className="num">Margen</th><th className="no-print"></th></tr>
                    </thead>
                    <tbody>
                      {cuts.map((cut) => {
                        const costKg = cut.productId ? costPerKgByProduct.get(cut.productId) : undefined;
                        return (
                          <tr key={`${cut.id}-${cut.weight}-${cut.unitPrice}-${cut.productId ?? ""}`}>
                            <td>
                              {cut.cutName}
                              {!cut.productId && (
                                <select className="carcass-link no-print" defaultValue="" onChange={(e) => handleLinkProduct(cut, e.target.value)}>
                                  <option value="" disabled>Elegí el producto…</option>
                                  {sortedProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                              )}
                            </td>
                            <td className="num">
                              <input
                                className="carcass-kg"
                                type="text"
                                inputMode="decimal"
                                defaultValue={formatKg(cut.weight)}
                                onFocus={(e) => e.target.select()}
                                onBlur={(e) => handleWeightBlur(cut, e.target.value)}
                              />
                            </td>
                            <td className="num">
                              <input
                                className="carcass-price"
                                type="text"
                                inputMode="decimal"
                                defaultValue={cut.unitPrice > 0 ? String(cut.unitPrice) : ""}
                                placeholder="$"
                                onFocus={(e) => e.target.select()}
                                onBlur={(e) => handlePriceBlur(cut, e.target.value)}
                              />
                            </td>
                            <td className="num">{costKg !== undefined && cut.unitPrice > 0 ? formatMoney(costKg) : <span className="muted">—</span>}</td>
                            <td className="num">
                              {costKg !== undefined && costKg > 0 && cut.unitPrice > 0 ? (
                                <span className={cut.unitPrice < costKg ? "num-negative" : undefined}>{marginPercent(costKg, cut.unitPrice)}%</span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td className="no-print">
                              <div className="row-actions">
                                <button type="button" className="danger" aria-label={`Quitar ${cut.cutName}`} onClick={() => void handleDeleteCut(cut)}>✕</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      <tr>
                        <td colSpan={6} className="muted" style={{ fontSize: 13 }}>
                          Rindió {formatKg(cutsWeight)} de {formatKg(selectedBatch.totalWeight)} kg ({yieldPct}%)
                          {canApplyCosts && (
                            <button type="button" className="secondary no-print" style={{ marginLeft: 10 }} disabled={busy} onClick={() => void handleApplyCosts()}>
                              Actualizar costos en Stock
                            </button>
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              <div className="carcass-add-row no-print">
                <input autoComplete="off" list="carcass-cut-names" placeholder="Corte" value={cutName} onChange={(e) => setCutName(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Kilos" value={cutWeight} onChange={(e) => setCutWeight(e.target.value)} />
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={productForName(cutName) ? `$ ${productForName(cutName)!.priceRetail}` : "Precio $/kg"}
                  value={cutPrice}
                  onChange={(e) => setCutPrice(e.target.value)}
                />
                <button type="button" onClick={() => void handleAddCut()}>Agregar corte</button>
              </div>
            </section>
          )}
        </div>
      </div>

      <datalist id="carcass-cut-names">
        {suggestionNames.map((name) => <option key={name} value={name} />)}
      </datalist>
    </>
  );
}
