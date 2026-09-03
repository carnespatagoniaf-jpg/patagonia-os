import { useEffect, useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { carcassCutLineTotal, carcassTemplateCutWeight, marginPercent } from "@patagonia/domain";
import { useCarcass } from "./useCarcass";
import { useCarcassTemplates } from "./useCarcassTemplates";
import { useSuppliers } from "../purchases/useSuppliers";
import { useActiveBranch } from "../branches/BranchProvider";
import { listProductsForBranch } from "../inventory/inventory-service";
import { todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

const ANIMAL_TYPES = ["Vaca / media res", "Cerdo", "Pollo", "Mocho", "Otro"];

export function Carcass() {
  const { batches, loading, error, saveBatch, removeBatch, cuts, cutsLoading, loadCuts, saveCut, removeCut } = useCarcass();
  const { templates, save: saveTemplate, remove: removeTemplate } = useCarcassTemplates();
  const { suppliers } = useSuppliers();
  const { branchId } = useActiveBranch();
  const [products, setProducts] = useState<Product[]>([]);

  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [showBatchForm, setShowBatchForm] = useState(false);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [batchDate, setBatchDate] = useState(todayIso());
  const [animalType, setAnimalType] = useState(ANIMAL_TYPES[0]);
  const [supplierId, setSupplierId] = useState("");
  const [totalWeight, setTotalWeight] = useState("");
  const [pricePerKg, setPricePerKg] = useState("");

  const [cutName, setCutName] = useState("");
  const [cutWeight, setCutWeight] = useState("");
  const [cutPrice, setCutPrice] = useState("");
  const [cutProductId, setCutProductId] = useState("");
  const [editingCutId, setEditingCutId] = useState<string | null>(null);

  const [showTemplates, setShowTemplates] = useState(false);
  const [templateAnimalType, setTemplateAnimalType] = useState(ANIMAL_TYPES[0]);
  const [newTplCutName, setNewTplCutName] = useState("");
  const [newTplYield, setNewTplYield] = useState("");
  const [newTplProductId, setNewTplProductId] = useState("");
  const [generatingCuts, setGeneratingCuts] = useState(false);

  useEffect(() => {
    if (selectedId) void loadCuts(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!branchId) return;
    listProductsForBranch(branchId).then(setProducts).catch(() => setProducts([]));
  }, [branchId]);

  const selectedBatch = batches.find((b) => b.id === selectedId) ?? null;

  const cutsTotal = useMemo(() => cuts.reduce((sum, c) => sum + c.lineTotal, 0), [cuts]);
  const previewCutTotal = carcassCutLineTotal({
    weight: Number.isFinite(Number(cutWeight)) ? Number(cutWeight || "0") : 0,
    unitPrice: Number.isFinite(parseAmount(cutPrice || "0")) ? parseAmount(cutPrice || "0") : 0
  });

  const weightValue = Number(totalWeight || "0");
  const pricePerKgValue = parseAmount(pricePerKg || "0");
  const computedTotalCost = Number.isFinite(weightValue) && Number.isFinite(pricePerKgValue) ? weightValue * pricePerKgValue : 0;

  function resetBatchForm() {
    setEditingBatchId(null);
    setBatchDate(todayIso());
    setAnimalType(ANIMAL_TYPES[0]);
    setSupplierId("");
    setTotalWeight("");
    setPricePerKg("");
    setShowBatchForm(false);
  }

  function startEditBatch(batchId: string) {
    const batch = batches.find((b) => b.id === batchId);
    if (!batch) return;
    setEditingBatchId(batchId);
    setBatchDate(batch.batchDate);
    setAnimalType(batch.animalType);
    setSupplierId(batch.supplierId ?? "");
    setTotalWeight(String(batch.totalWeight));
    setPricePerKg(batch.totalWeight > 0 ? String(Math.round((batch.totalCost / batch.totalWeight) * 100) / 100) : "");
    setShowBatchForm(true);
  }

  async function generateCutsFromTemplate(batchId: string, forAnimalType: string, forTotalWeight: number) {
    const templateRows = templates.filter((t) => t.animalType === forAnimalType);
    if (templateRows.length === 0) return 0;

    setGeneratingCuts(true);
    try {
      for (const t of templateRows) {
        const product = t.productId ? products.find((p) => p.id === t.productId) : undefined;
        await saveCut({
          batchId,
          cutName: t.cutName,
          productId: t.productId,
          weight: carcassTemplateCutWeight(forTotalWeight, t.yieldPercent),
          unitPrice: product?.priceRetail ?? 0
        });
      }
      return templateRows.length;
    } finally {
      setGeneratingCuts(false);
    }
  }

  async function handleSaveBatch() {
    try {
      if (!Number.isFinite(weightValue) || weightValue <= 0) throw new Error("Ingresá el peso total.");
      if (!Number.isFinite(pricePerKgValue) || pricePerKgValue < 0) throw new Error("Ingresá el precio por kg.");
      const result = await saveBatch({
        id: editingBatchId ?? undefined,
        batchDate,
        animalType,
        supplierId: supplierId || undefined,
        totalWeight: weightValue,
        totalCost: computedTotalCost
      });
      const wasEditing = !!editingBatchId;
      resetBatchForm();
      setSelectedId(result.id);

      if (!wasEditing) {
        const generated = await generateCutsFromTemplate(result.id, animalType, weightValue);
        await loadCuts(result.id);
        setMessage(
          generated > 0
            ? `Res cargada y ${generated} cortes generados desde la plantilla de "${animalType}" — revisá los pesos con la balanza real.`
            : `Res cargada. No hay plantilla de cortes para "${animalType}" todavía (podés cargar una en "Plantillas de despiece").`
        );
      } else {
        setMessage("Res actualizada.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar la res.");
    }
  }

  async function handleDeleteBatch(id: string) {
    if (!window.confirm("¿Seguro que querés eliminar esta res? Se borran también sus cortes cargados. No se puede deshacer.")) return;
    try {
      await removeBatch(id);
      if (selectedId === id) setSelectedId(null);
      setMessage("Res eliminada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo eliminar.");
    }
  }

  async function handleSaveCut() {
    try {
      if (!selectedBatch) return;
      if (!cutName.trim()) throw new Error("Ingresá el nombre del corte.");
      const weight = Number(cutWeight);
      const price = parseAmount(cutPrice);
      if (!Number.isFinite(weight) || weight <= 0) throw new Error("Ingresá el peso del corte.");
      if (!Number.isFinite(price) || price < 0) throw new Error("Ingresá el precio de venta.");

      await saveCut({
        id: editingCutId ?? undefined,
        batchId: selectedBatch.id,
        cutName: cutName.trim(),
        productId: cutProductId || undefined,
        weight,
        unitPrice: price
      });
      setCutName("");
      setCutWeight("");
      setCutPrice("");
      setCutProductId("");
      setEditingCutId(null);
      setMessage(cutProductId ? "Corte guardado y sumado al stock." : "Corte guardado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el corte.");
    }
  }

  function startEditCut(cutId: string) {
    const cut = cuts.find((c) => c.id === cutId);
    if (!cut) return;
    setEditingCutId(cutId);
    setCutName(cut.cutName);
    setCutWeight(String(cut.weight));
    setCutPrice(String(cut.unitPrice));
    setCutProductId(cut.productId ?? "");
  }

  async function handleDeleteCut(cutId: string) {
    if (!window.confirm("¿Seguro que querés eliminar este corte? No se puede deshacer.")) return;
    try {
      if (!selectedBatch) return;
      await removeCut(cutId, selectedBatch.id);
      setMessage("Corte eliminado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo eliminar.");
    }
  }

  async function handleGenerateCutsForSelectedBatch() {
    if (!selectedBatch) return;
    if (cuts.length > 0) {
      if (!window.confirm("Esta res ya tiene cortes cargados. ¿Agregar igual los de la plantilla? Puede duplicar cortes.")) return;
    }
    const generated = await generateCutsFromTemplate(selectedBatch.id, selectedBatch.animalType, selectedBatch.totalWeight);
    setMessage(
      generated > 0
        ? `${generated} cortes generados desde la plantilla — revisá los pesos con la balanza real.`
        : `No hay plantilla de cortes para "${selectedBatch.animalType}" todavía.`
    );
  }

  const templatesForType = templates.filter((t) => t.animalType === templateAnimalType);
  const templateYieldSum = templatesForType.reduce((sum, t) => sum + t.yieldPercent, 0);

  async function handleAddTemplateCut() {
    try {
      if (!newTplCutName.trim()) throw new Error("Ingresá el nombre del corte.");
      const yieldPercent = Number(newTplYield);
      if (!Number.isFinite(yieldPercent) || yieldPercent <= 0 || yieldPercent > 100) throw new Error("Ingresá un % de rendimiento válido.");
      await saveTemplate({
        animalType: templateAnimalType,
        cutName: newTplCutName.trim(),
        yieldPercent,
        productId: newTplProductId || undefined,
        sortOrder: templatesForType.length
      });
      setNewTplCutName("");
      setNewTplYield("");
      setNewTplProductId("");
      setMessage("Corte agregado a la plantilla.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo agregar el corte a la plantilla.");
    }
  }

  async function handleDeleteTemplateCut(id: string) {
    if (!window.confirm("¿Seguro que querés quitar este corte de la plantilla?")) return;
    try {
      await removeTemplate(id);
      setMessage("Corte quitado de la plantilla.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo quitar.");
    }
  }

  const cutsWeightTotal = cuts.reduce((sum, c) => sum + c.weight, 0);
  const yieldSoFar = selectedBatch && selectedBatch.totalWeight > 0 ? Math.round((cutsWeightTotal / selectedBatch.totalWeight) * 1000) / 10 : 0;

  const gananciaTotal = selectedBatch ? cutsTotal - selectedBatch.totalCost : 0;
  const margenTotal = selectedBatch ? marginPercent(selectedBatch.totalCost, cutsTotal) : 0;

  function handlePrint() {
    window.print();
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">DESPIECE</p>
          <h1>Despiece y rendimiento</h1>
          <p className="muted">Cargá el peso y precio por kg de la res completa, y el peso/precio de venta de cada corte, para ver la ganancia real de esa compra.</p>
        </div>
        <button className="secondary" onClick={() => setShowTemplates((v) => !v)}>
          {showTemplates ? "Ocultar plantillas" : "Plantillas de despiece"}
        </button>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      {showTemplates && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-title">
            <h2>Plantilla de cortes esperados</h2>
          </div>
          <p className="muted" style={{ marginTop: -8, marginBottom: 14 }}>
            Cargá una vez, por tipo de animal, qué cortes esperás y qué % del peso total representa cada uno. Al cargar una res nueva de ese tipo, se generan solos con el peso proporcional — vos después los ajustás con la balanza real. El % no tiene que sumar 100: el resto es hueso, grasa y merma normal.
          </p>
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
            <select value={templateAnimalType} onChange={(e) => setTemplateAnimalType(e.target.value)}>
              {ANIMAL_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          <table className="data-table">
            <thead>
              <tr><th>Corte</th><th className="num">% del peso</th><th>Producto (stock)</th><th></th></tr>
            </thead>
            <tbody>
              {templatesForType.map((t) => (
                <tr key={t.id}>
                  <td>{t.cutName}</td>
                  <td className="num">{t.yieldPercent}%</td>
                  <td>{t.productId ? (products.find((p) => p.id === t.productId)?.name ?? "Sí") : "-"}</td>
                  <td><button className="danger" onClick={() => handleDeleteTemplateCut(t.id)}>Quitar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {templatesForType.length === 0 && <p className="muted">Todavía no hay cortes en la plantilla de "{templateAnimalType}".</p>}
          {templatesForType.length > 0 && (
            <p className="muted" style={{ marginTop: 8 }}>
              Suma de la plantilla: {templateYieldSum}% del peso total — el {Math.round((100 - templateYieldSum) * 10) / 10}% restante queda como merma esperada (hueso, grasa, descarte).
            </p>
          )}

          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 16 }}>
            <input placeholder="Corte (ej. Bola de lomo)" value={newTplCutName} onChange={(e) => setNewTplCutName(e.target.value)} />
            <input type="number" min="0" max="100" step="0.1" placeholder="% del peso" value={newTplYield} onChange={(e) => setNewTplYield(e.target.value)} style={{ width: 120 }} />
            <select value={newTplProductId} onChange={(e) => setNewTplProductId(e.target.value)}>
              <option value="">Sin producto (no suma stock)</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name}</option>
              ))}
            </select>
            <button onClick={handleAddTemplateCut}>Agregar a la plantilla</button>
          </div>
        </section>
      )}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Reses cargadas</h2>
            <span>{loading ? "Cargando…" : `${batches.length}`}</span>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>Fecha</th><th>Tipo</th><th className="num">Peso</th><th className="num">$/kg</th><th className="num">Compra</th><th></th></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{b.batchDate}</td>
                  <td>{b.animalType}</td>
                  <td className="num">{b.totalWeight} kg</td>
                  <td className="num">{formatMoney(b.totalWeight > 0 ? b.totalCost / b.totalWeight : 0)}</td>
                  <td className="num">{formatMoney(b.totalCost)}</td>
                  <td>
                    {selectedId === b.id ? (
                      <button className="secondary" disabled>Seleccionado</button>
                    ) : (
                      <button className="secondary" onClick={() => setSelectedId(b.id)}>Ver</button>
                    )}{" "}
                    <button className="secondary" onClick={() => startEditBatch(b.id)}>Editar</button>{" "}
                    <button className="danger" onClick={() => handleDeleteBatch(b.id)}>Quitar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {batches.length === 0 && !loading && <p className="muted">Todavía no cargaste ninguna res.</p>}

          {showBatchForm ? (
            <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 16 }}>
              <input type="date" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} />
              <select value={animalType} onChange={(e) => setAnimalType(e.target.value)}>
                {ANIMAL_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Proveedor (opcional)…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <input type="number" min="0" step="0.001" placeholder="Peso total (kg)" value={totalWeight} onChange={(e) => setTotalWeight(e.target.value)} />
              <input type="text" inputMode="decimal" placeholder="Precio por kg ($)" value={pricePerKg} onChange={(e) => setPricePerKg(e.target.value)} />
              <button onClick={handleSaveBatch}>{editingBatchId ? "Guardar cambio" : "Guardar res"}</button>
              <button className="secondary" onClick={resetBatchForm}>Cancelar</button>
            </div>
          ) : (
            <button className="secondary" style={{ marginTop: 16 }} onClick={() => setShowBatchForm(true)}>
              + Agregar res
            </button>
          )}
          {showBatchForm && (
            <p className="muted" style={{ marginTop: 10 }}>Costo total calculado: {formatMoney(computedTotalCost)}</p>
          )}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Resumen</h2>
          </div>
          {!selectedBatch && <p className="muted">Elegí una res para ver el detalle.</p>}
          {selectedBatch && (
            <div className="kpi-grid">
              <div className="kpi-card">
                <span>Compra</span>
                <strong>{formatMoney(selectedBatch.totalCost)}</strong>
              </div>
              <div className="kpi-card">
                <span>Venta (cortes)</span>
                <strong>{cutsLoading ? "…" : formatMoney(cutsTotal)}</strong>
              </div>
              <div className="kpi-card">
                <span>Ganancia</span>
                <strong className={gananciaTotal < 0 ? "num-negative" : "num-positive"}>{formatMoney(gananciaTotal)}</strong>
              </div>
              <div className="kpi-card">
                <span>Margen</span>
                <strong className={margenTotal < 0 ? "num-negative" : "num-positive"}>{margenTotal}%</strong>
              </div>
              <div className="kpi-card">
                <span>Rendimiento cargado</span>
                <strong>{cutsWeightTotal} kg de {selectedBatch.totalWeight} kg ({yieldSoFar}%)</strong>
              </div>
            </div>
          )}
        </section>
      </div>

      {selectedBatch && (
        <section className="panel print-area" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Cortes de {selectedBatch.animalType} — {selectedBatch.batchDate}</h2>
            <div className="no-print" style={{ display: "flex", gap: 8 }}>
              <button className="secondary" disabled={generatingCuts} onClick={handleGenerateCutsForSelectedBatch}>
                {generatingCuts ? "Generando…" : "Generar cortes desde plantilla"}
              </button>
              <button className="secondary" onClick={handlePrint}>Imprimir</button>
            </div>
          </div>
          <p className="muted print-only-header">
            Compra {formatMoney(selectedBatch.totalCost)} · Venta {formatMoney(cutsTotal)} · Ganancia {formatMoney(gananciaTotal)} ({margenTotal}%)
          </p>
          <div className="cash-banner-form no-print" style={{ flexWrap: "wrap", marginBottom: 4 }}>
            <input placeholder="Corte (ej. Asado)" value={cutName} onChange={(e) => setCutName(e.target.value)} />
            <input type="number" min="0" step="0.001" placeholder="Peso (kg)" value={cutWeight} onChange={(e) => setCutWeight(e.target.value)} />
            <input type="text" inputMode="decimal" placeholder="Precio venta ($/kg)" value={cutPrice} onChange={(e) => setCutPrice(e.target.value)} />
            <select value={cutProductId} onChange={(e) => setCutProductId(e.target.value)}>
              <option value="">Sin producto (no suma stock)</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name}</option>
              ))}
            </select>
            <button onClick={handleSaveCut}>{editingCutId ? "Guardar cambio" : "Agregar corte"}</button>
            {editingCutId && (
              <button className="secondary" onClick={() => { setEditingCutId(null); setCutName(""); setCutWeight(""); setCutPrice(""); setCutProductId(""); }}>Cancelar</button>
            )}
          </div>
          <p className="muted no-print" style={{ marginBottom: 14 }}>
            Subtotal de este corte: {formatMoney(previewCutTotal)}
            {" · "}Si el corte no tiene producto asociado, no suma stock — creá el producto en Stock primero si querés que este corte lo alimente.
          </p>

          <table className="data-table">
            <thead>
              <tr><th>Corte</th><th className="num">Peso</th><th className="num">Precio/kg</th><th className="num">Subtotal</th><th>Stock</th><th className="no-print"></th></tr>
            </thead>
            <tbody>
              {cuts.map((cut) => (
                <tr key={cut.id}>
                  <td>{cut.cutName}</td>
                  <td className="num">{cut.weight} kg</td>
                  <td className="num">{formatMoney(cut.unitPrice)}</td>
                  <td className="num">{formatMoney(cut.lineTotal)}</td>
                  <td>{cut.productId ? (products.find((p) => p.id === cut.productId)?.name ?? "Sí") : "-"}</td>
                  <td className="no-print">
                    <button className="secondary" onClick={() => startEditCut(cut.id)}>Editar</button>{" "}
                    <button className="danger" onClick={() => handleDeleteCut(cut.id)}>Quitar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cuts.length === 0 && !cutsLoading && <p className="muted">Todavía no cargaste ningún corte.</p>}
        </section>
      )}
    </>
  );
}
