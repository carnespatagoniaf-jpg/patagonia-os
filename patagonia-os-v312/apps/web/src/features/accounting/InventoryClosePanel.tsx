import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "../shifts/format";
import { inventorySheet } from "./accounting-export";
import {
  deleteInventorySnapshot,
  listInventorySnapshotItems,
  listInventorySnapshots,
  takeInventorySnapshot,
  type InventorySnapshot
} from "./accounting-service";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return fallback;
}

function todayAr(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

/** Inventario al cierre (migración 156): el stock valorizado a una fecha, guardado para el balance. */
export function InventoryClosePanel({ canTake }: { canTake: boolean }) {
  const [list, setList] = useState<InventorySnapshot[]>([]);
  const [date, setDate] = useState(todayAr());
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const reload = useCallback(async () => {
    try {
      setList(await listInventorySnapshots());
    } catch (err) {
      setMessage(errorText(err, "No se pudieron cargar los inventarios."));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function take() {
    setBusy(true);
    setMessage("");
    try {
      await takeInventorySnapshot(date, label.trim() || null);
      setLabel("");
      setMessage("Inventario guardado.");
      await reload();
    } catch (err) {
      setMessage(errorText(err, "No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  }

  async function download(s: InventorySnapshot) {
    try {
      const items = await listInventorySnapshotItems(s.id);
      const XLSX = await import("xlsx");
      const sheet = inventorySheet(s, items);
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
      ws["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 34 }, { wch: 16 }, { wch: 9 }, { wch: 11 }, { wch: 12 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, sheet.name);
      XLSX.writeFile(wb, `Inventario_${s.takenOn}.xlsx`);
    } catch (err) {
      setMessage(errorText(err, "No se pudo armar el Excel."));
    }
  }

  async function remove(s: InventorySnapshot) {
    if (!window.confirm(`¿Borrar el inventario del ${s.takenOn}? No toca el stock, solo esta foto guardada.`)) return;
    try {
      await deleteInventorySnapshot(s.id);
      await reload();
    } catch (err) {
      setMessage(errorText(err, "No se pudo borrar."));
    }
  }

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Inventario al cierre</h2>
        <span>{list.length} guardados</span>
      </div>
      <p className="setting-help" style={{ marginTop: 0 }}>
        Para el balance, el contador necesita el stock valorizado al día del cierre del ejercicio. Se guarda una foto con la cantidad de cada producto en cada sucursal y su costo.
        Si elegís una fecha pasada, la cantidad es la que había ese día (por los movimientos de stock); el costo es el de hoy.
      </p>
      {canTake && (
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 12 }}>
          <label className="muted" style={{ display: "grid", gap: 2 }}>
            Fecha
            <input type="date" value={date} max={todayAr()} onChange={(e) => setDate(e.target.value)} />
          </label>
          <input placeholder="Nombre (ej. Cierre de ejercicio 2026)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: "1 1 240px" }} />
          <button disabled={busy || !date} onClick={() => void take()}>{busy ? "Guardando…" : "Guardar inventario a esa fecha"}</button>
        </div>
      )}
      {message && <div className="message">{message}</div>}
      {list.length === 0 ? (
        <p className="muted">Todavía no hay inventarios guardados.</p>
      ) : (
        <table className="data-table" style={{ maxWidth: 760 }}>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Nombre</th>
              <th className="num">Productos</th>
              <th className="num">Valor</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td>{s.takenOn.split("-").reverse().join("/")}</td>
                <td>{s.label ?? "—"}</td>
                <td className="num">{s.itemsCount}</td>
                <td className="num"><strong>{formatMoney(s.totalValue)}</strong></td>
                <td>
                  <button className="secondary" onClick={() => void download(s)}>Bajar Excel</button>{" "}
                  {canTake && <button className="link-button" onClick={() => void remove(s)}>Borrar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
