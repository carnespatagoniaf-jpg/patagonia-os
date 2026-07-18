import { useEffect, useMemo, useState } from "react";
import { carcassCutLineTotal, marginPercent } from "@patagonia/domain";
import { useCarcass } from "./useCarcass";
import { useSuppliers } from "../purchases/useSuppliers";
import { todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

const ANIMAL_TYPES = ["Vaca / media res", "Cerdo", "Pollo", "Mocho", "Otro"];

export function Carcass() {
  const { batches, loading, error, saveBatch, removeBatch, cuts, cutsLoading, loadCuts, saveCut, removeCut } = useCarcass();
  const { suppliers } = useSuppliers();

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
  const [editingCutId, setEditingCutId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId) void loadCuts(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

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
      setMessage(wasEditing ? "Res actualizada." : "Res cargada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar la res.");
    }
  }

  async function handleDeleteBatch(id: string) {
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

      await saveCut({ id: editingCutId ?? undefined, batchId: selectedBatch.id, cutName: cutName.trim(), weight, unitPrice: price });
      setCutName("");
      setCutWeight("");
      setCutPrice("");
      setEditingCutId(null);
      setMessage("Corte guardado.");
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
  }

  async function handleDeleteCut(cutId: string) {
    try {
      if (!selectedBatch) return;
      await removeCut(cutId, selectedBatch.id);
      setMessage("Corte eliminado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo eliminar.");
    }
  }

  const gananciaTotal = selectedBatch ? cutsTotal - selectedBatch.totalCost : 0;
  const margenTotal = selectedBatch ? marginPercent(selectedBatch.totalCost, cutsTotal) : 0;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">DESPIECE</p>
          <h1>Despiece y rendimiento</h1>
          <p className="muted">Cargá el peso y precio por kg de la res completa, y el peso/precio de venta de cada corte, para ver la ganancia real de esa compra.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

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
            </div>
          )}
        </section>
      </div>

      {selectedBatch && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Cortes de {selectedBatch.animalType} — {selectedBatch.batchDate}</h2>
          </div>
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 4 }}>
            <input placeholder="Corte (ej. Asado)" value={cutName} onChange={(e) => setCutName(e.target.value)} />
            <input type="number" min="0" step="0.001" placeholder="Peso (kg)" value={cutWeight} onChange={(e) => setCutWeight(e.target.value)} />
            <input type="text" inputMode="decimal" placeholder="Precio venta ($/kg)" value={cutPrice} onChange={(e) => setCutPrice(e.target.value)} />
            <button onClick={handleSaveCut}>{editingCutId ? "Guardar cambio" : "Agregar corte"}</button>
            {editingCutId && (
              <button className="secondary" onClick={() => { setEditingCutId(null); setCutName(""); setCutWeight(""); setCutPrice(""); }}>Cancelar</button>
            )}
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>Subtotal de este corte: {formatMoney(previewCutTotal)}</p>

          <table className="data-table">
            <thead>
              <tr><th>Corte</th><th className="num">Peso</th><th className="num">Precio/kg</th><th className="num">Subtotal</th><th></th></tr>
            </thead>
            <tbody>
              {cuts.map((cut) => (
                <tr key={cut.id}>
                  <td>{cut.cutName}</td>
                  <td className="num">{cut.weight} kg</td>
                  <td className="num">{formatMoney(cut.unitPrice)}</td>
                  <td className="num">{formatMoney(cut.lineTotal)}</td>
                  <td>
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
