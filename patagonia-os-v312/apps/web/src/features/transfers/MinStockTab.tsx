import { useEffect, useMemo, useState } from "react";
import { addDaysIso, todayIso } from "../shifts/format";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listSalesByProduct } from "../sale/pos-shift-service";
import { parseQuantity } from "../sale/quantity";
import { formatQty, perDayFromSales, type TransferUnit } from "./transfer-logic";
import { listBranchMinStock, setBranchMinStock } from "./transfers-service";
import type { TransfersContext } from "./Transfers";

// Mínimo de stock de cada local (dueño/administrador). Vacío = usa el mínimo general del producto (Stock).
// Los atajos solo completan la tabla: no se guarda nada hasta "Guardar cambios".

interface Row {
  id: string;
  name: string;
  code: string;
  unit: TransferUnit;
  generalMin: number;
}

const SHOWN = 80;
const key = (branchId: string, productId: string) => `${branchId}|${productId}`;
const text = (n: number | undefined) => (n === undefined ? "" : String(n).replace(".", ","));

function plain(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function MinStockTab({ ctx }: { ctx: TransfersContext }) {
  const [products, setProducts] = useState<Row[]>([]);
  const [saved, setSaved] = useState<Map<string, number>>(new Map());
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [onlyWithMin, setOnlyWithMin] = useState(false);
  const [copyFrom, setCopyFrom] = useState("");
  const [copyTo, setCopyTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    const [list, mins] = await Promise.all([listProductsForBranch(ctx.activeBranchId), listBranchMinStock()]);
    setProducts(
      list
        .filter((p) => (p.active ?? true) && !p.stockSourceId)
        .map((p) => ({ id: p.id, name: p.name, code: p.code, unit: p.unit, generalMin: p.minStock }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    const flat = new Map<string, number>();
    for (const [branchId, m] of mins) for (const [productId, v] of m) flat.set(key(branchId, productId), v);
    setSaved(flat);
    setDraft({});
  }

  useEffect(() => {
    setLoading(true);
    void load()
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los mínimos."))
      .finally(() => setLoading(false));
    // Se carga una vez por local activo.
  }, [ctx.activeBranchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = (b: string, p: string) => draft[key(b, p)] ?? text(saved.get(key(b, p)));
  const changed = Object.entries(draft).filter(([k, v]) => {
    const n = parseQuantity(v);
    const old = saved.get(k);
    return v.trim() === "" ? old !== undefined : !Number.isFinite(n) || n !== old;
  });

  const shown = useMemo(() => {
    const q = plain(query);
    return products
      .filter((p) => !q || plain(p.name).includes(q) || plain(p.code) === q)
      .filter((p) => !onlyWithMin || ctx.branches.some((b) => value(b.id, p.id) !== ""))
      .slice(0, SHOWN);
    // value lee saved y draft.
  }, [products, query, onlyWithMin, saved, draft, ctx.branches]); // eslint-disable-line react-hooks/exhaustive-deps

  function copy() {
    setError("");
    if (!copyFrom || !copyTo || copyFrom === copyTo) return setError("Elegí de qué local y a qué local copiar.");
    const next = { ...draft };
    for (const p of products) next[key(copyTo, p.id)] = value(copyFrom, p.id);
    setDraft(next);
    ctx.notify(`Se copiaron los mínimos de ${ctx.branchName(copyFrom)} a ${ctx.branchName(copyTo)}. Revisalos y tocá "Guardar cambios".`);
  }

  async function fromSales() {
    setError("");
    setBusy(true);
    try {
      const to = todayIso();
      const next = { ...draft };
      for (const b of ctx.branches) {
        const perDay = perDayFromSales(await listSalesByProduct(b.id, addDaysIso(to, -28), addDaysIso(to, -1)), 28);
        for (const p of products) {
          const d = perDay.get(p.id) ?? 0;
          if (d > 0) next[key(b.id, p.id)] = String(Math.ceil(d * 3));
        }
      }
      setDraft(next);
      ctx.notify('Se calculó un mínimo de 3 días de venta (últimas 4 semanas) para cada local que vende cada producto. Revisalos y tocá "Guardar cambios".');
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron leer las ventas.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError("");
    const bad = changed.find(([, v]) => v.trim() !== "" && (!Number.isFinite(parseQuantity(v)) || parseQuantity(v) < 0));
    if (bad) return setError("Hay un mínimo que no es un número.");
    const byBranch = new Map<string, Array<{ productId: string; minStock: number | null }>>();
    for (const [k, v] of changed) {
      const [branchId, productId] = k.split("|");
      const list = byBranch.get(branchId) ?? [];
      list.push({ productId, minStock: v.trim() === "" ? null : parseQuantity(v) });
      byBranch.set(branchId, list);
    }
    setBusy(true);
    try {
      for (const [branchId, lines] of byBranch) {
        for (let i = 0; i < lines.length; i += 500) await setBranchMinStock(branchId, lines.slice(i, i + 500));
      }
      ctx.notify(`Listo: se guardaron ${changed.length} mínimo${changed.length === 1 ? "" : "s"}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar los mínimos.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-main panel">
      <div className="ws-head">
        <div>
          <h2>Mínimo de stock de cada local</h2>
          <p className="muted">Si un local baja de su mínimo, aparece en sus alertas y en la sugerencia de su pedido. Vacío = usa el mínimo general del producto (Stock).</p>
        </div>
        <button className="charge-button ws-go" disabled={busy || changed.length === 0} onClick={() => void save()}>
          {busy ? "Guardando…" : changed.length > 0 ? `Guardar cambios (${changed.length})` : "Guardar cambios"}
        </button>
      </div>
      {error && <div className="message warning">{error}</div>}

      <div className="ws-form">
        <div className="ws-form-row">
          <input className="ws-grow" placeholder="Buscar producto por nombre o código…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="transfers-check">
            <input type="checkbox" checked={onlyWithMin} onChange={(e) => setOnlyWithMin(e.target.checked)} /> Solo los que tienen mínimo
          </label>
        </div>
        <div className="ws-form-row transfers-shortcuts">
          <span className="muted">Atajos:</span>
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">Copiar de…</option>
            {ctx.branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select value={copyTo} onChange={(e) => setCopyTo(e.target.value)}>
            <option value="">…a</option>
            {ctx.branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={copy}>Copiar</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void fromSales()}>
            Calcular con lo que vende cada local (3 días de venta)
          </button>
        </div>
      </div>

      {loading ? (
        <p className="muted">Cargando…</p>
      ) : (
        <div className="ws-box">
          <div className="table-scroll ws-scroll">
            <table className="data-table no-stack transfers-min">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="num">General</th>
                  {ctx.branches.map((b) => (
                    <th key={b.id} className="num">{b.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.name}</b> <span className="muted">({p.code})</span>
                    </td>
                    <td className="num muted">{p.generalMin > 0 ? formatQty(p.generalMin, p.unit) : "—"}</td>
                    {ctx.branches.map((b) => {
                      const k = key(b.id, p.id);
                      return (
                        <td key={b.id} className="num">
                          <input
                            className={`tr-qty tr-min${draft[k] !== undefined && changed.some(([c]) => c === k) ? " tr-changed" : ""}`}
                            type="text"
                            inputMode="decimal"
                            aria-label={`Mínimo de ${p.name} en ${b.name}`}
                            value={value(b.id, p.id)}
                            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {products.length > shown.length && <p className="muted transfers-pad">Se muestran {shown.length} productos: buscá para ver otros.</p>}
        </div>
      )}
    </section>
  );
}
