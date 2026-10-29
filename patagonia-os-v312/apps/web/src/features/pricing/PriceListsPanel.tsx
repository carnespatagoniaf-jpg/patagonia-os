import { useState } from "react";
import { deletePriceList, savePriceList } from "./price-lists-service";
import { ruleLabel, type PriceList } from "./price-lists";

type RuleKind = "retail_minus" | "retail_plus" | "cost_plus";

function ruleKindOf(list: Pick<PriceList, "base" | "pct">): RuleKind {
  if (list.base === "cost") return "cost_plus";
  return list.pct < 0 ? "retail_minus" : "retail_plus";
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "";
}

/**
 * Stock → "Listas de precios" (dueño/administrador): Mayorista y otras. Cada lista es una regla
 * (minorista − %, minorista + % o costo + %); en cada producto se puede escribir otro precio a mano.
 */
export function PriceListsPanel({ lists, onChanged, onMessage }: { lists: PriceList[]; onChanged: () => Promise<void> | void; onMessage: (text: string) => void }) {
  const [editingId, setEditingId] = useState<string | "new" | null>(lists.length === 0 ? "new" : null);
  const [name, setName] = useState(lists.length === 0 ? "Mayorista" : "");
  const [kind, setKind] = useState<RuleKind>("retail_minus");
  const [pct, setPct] = useState("");
  const [busy, setBusy] = useState(false);

  function startEdit(list: PriceList | null) {
    setEditingId(list ? list.id : "new");
    setName(list ? list.name : lists.length === 0 ? "Mayorista" : "");
    setKind(list ? ruleKindOf(list) : "retail_minus");
    setPct(list ? String(Math.abs(list.pct)).replace(".", ",") : "");
  }

  async function handleSave() {
    const value = Number(pct.trim().replace("%", "").replace(",", "."));
    if (!name.trim()) return onMessage("Poné un nombre a la lista (ej. Mayorista).");
    if (!Number.isFinite(value) || value < 0 || (kind === "retail_minus" && value >= 100)) return onMessage("Escribí el porcentaje (ej. 10).");
    const current = editingId && editingId !== "new" ? lists.find((l) => l.id === editingId) : undefined;
    setBusy(true);
    try {
      await savePriceList({
        id: current?.id,
        name: name.trim(),
        base: kind === "cost_plus" ? "cost" : "retail",
        pct: kind === "retail_minus" ? -value : value,
        active: current?.active ?? true
      });
      setEditingId(null);
      onMessage(`Lista "${name.trim()}" guardada. Los precios de cada producto se calculan solos; si alguno necesita otro, se escribe en Editar.`);
      await onChanged();
    } catch (err) {
      onMessage(errorText(err) || "No se pudo guardar la lista.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(list: PriceList) {
    setBusy(true);
    try {
      await savePriceList({ ...list, active: !list.active });
      onMessage(list.active ? `"${list.name}" desactivada: se cobra a minorista.` : `"${list.name}" activa de nuevo.`);
      await onChanged();
    } catch (err) {
      onMessage(errorText(err) || "No se pudo cambiar la lista.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(list: PriceList) {
    if (!window.confirm(`¿Borrar la lista "${list.name}"? Los clientes que la tenían vuelven a minorista y se pierden los precios escritos a mano en ella.`)) return;
    setBusy(true);
    try {
      await deletePriceList(list.id);
      onMessage(`Lista "${list.name}" borrada.`);
      await onChanged();
    } catch (err) {
      onMessage(errorText(err) || "No se pudo borrar la lista.");
    } finally {
      setBusy(false);
    }
  }

  const preview = (() => {
    const value = Number(pct.trim().replace("%", "").replace(",", "."));
    if (!Number.isFinite(value) || pct.trim() === "") return "";
    const signed = kind === "retail_minus" ? -value : value;
    const base = kind === "cost_plus" ? "cost" : "retail";
    const example = base === "cost" ? Math.round(6000 * (1 + signed / 100)) : Math.round(8100 * (1 + signed / 100));
    return base === "cost"
      ? `Ejemplo: costo $6.000 → $${example.toLocaleString("es-AR")}`
      : `Ejemplo: minorista $8.100 → $${example.toLocaleString("es-AR")}`;
  })();

  return (
    <div className="form-box">
      <h3 style={{ margin: "0 0 4px" }}>Listas de precios</h3>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
        El precio minorista es el de siempre. Una lista (por ejemplo Mayorista) calcula sola el precio de cada producto con una regla. A los clientes mayoristas se les marca la lista en Clientes, y en Mostrador se elige con el botón Minorista / Mayorista. Las presentaciones (ofertas, x 2 kg) se cobran a su precio.
      </p>
      {lists.length > 0 && (
        <div className="table-scroll" style={{ marginBottom: 10 }}>
          <table className="data-table no-stack">
            <thead>
              <tr><th>Lista</th><th>Precio</th><th>Estado</th><th></th></tr>
            </thead>
            <tbody>
              {lists.map((list) => (
                <tr key={list.id}>
                  <td>{list.name}</td>
                  <td>{ruleLabel(list)}</td>
                  <td>{list.active ? "Activa" : <span className="badge">Desactivada</span>}</td>
                  <td>
                    <div className="row-actions">
                      <button className="secondary" disabled={busy} onClick={() => startEdit(list)}>Editar</button>
                      <button className="secondary" disabled={busy} onClick={() => void handleToggle(list)}>{list.active ? "Desactivar" : "Activar"}</button>
                      <button className="link-button" disabled={busy} onClick={() => void handleDelete(list)}>Borrar</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editingId ? (
        <>
          <div className="form-grid">
            <label>Nombre<input id="price-list-name" value={name} placeholder="Mayorista" onChange={(e) => setName(e.target.value)} /></label>
            <label>
              Se calcula
              <select id="price-list-kind" value={kind} onChange={(e) => setKind(e.target.value as RuleKind)}>
                <option value="retail_minus">Minorista menos un %</option>
                <option value="retail_plus">Minorista más un %</option>
                <option value="cost_plus">Costo más un %</option>
              </select>
            </label>
            <label>
              Porcentaje %
              <input id="price-list-pct" type="text" inputMode="decimal" placeholder="ej. 10" value={pct} onChange={(e) => setPct(e.target.value)} />
            </label>
          </div>
          {preview && <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{preview} (redondeado a pesos).</p>}
          <div className="form-actions">
            <button disabled={busy} onClick={() => void handleSave()}>Guardar lista</button>
            <button className="secondary" disabled={busy} onClick={() => setEditingId(null)}>Cancelar</button>
          </div>
        </>
      ) : (
        <button className="secondary" onClick={() => startEdit(null)}>+ Nueva lista</button>
      )}
    </div>
  );
}
