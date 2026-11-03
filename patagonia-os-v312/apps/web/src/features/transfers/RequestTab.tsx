import { useEffect, useMemo, useRef, useState } from "react";
import { addDaysIso, todayIso } from "../shifts/format";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listSalesByProduct } from "../sale/pos-shift-service";
import { parseQuantity } from "../sale/quantity";
import { ProductSearch, type PickableProduct } from "./ProductSearch";
import { buildSuggestions, formatQty, perDayFromSales, qtyTotals, totalsLabel, type TransferUnit } from "./transfer-logic";
import { listBranchMinStock, requestTransfer } from "./transfers-service";
import type { TransfersContext } from "./Transfers";

// Paso 1: el local pide lo que le falta. Arranca con lo que está debajo de su mínimo (el del local o, si no
// tiene, el general del producto) y la cantidad sugerida para volver al mínimo.

interface Line {
  productId: string;
  name: string;
  code: string | null;
  unit: TransferUnit;
  stock: number;
  min: number | null;
  perDay: number | null;
  suggested: number | null;
  qty: string;
}

const SALES_DAYS = 28;
const fromKey = (branchId: string) => `patagonia-transfer-from-${branchId}`;

function defaultFrom(ctx: TransfersContext): string {
  try {
    const stored = window.localStorage.getItem(fromKey(ctx.activeBranchId));
    if (stored && stored !== ctx.activeBranchId && ctx.branches.some((b) => b.id === stored)) return stored;
  } catch {
    // Sin almacenamiento: se elige solo.
  }
  const others = ctx.branches.filter((b) => b.id !== ctx.activeBranchId);
  return (others.find((b) => /planta|dep[oó]sito|central/i.test(b.name)) ?? others[0])?.id ?? "";
}

export function RequestTab({ ctx, onDone }: { ctx: TransfersContext; onDone: () => void }) {
  const [fromId, setFromId] = useState(() => defaultFrom(ctx));
  const [neededBy, setNeededBy] = useState(addDaysIso(todayIso(), 1));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [catalog, setCatalog] = useState<PickableProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const perDayRef = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const to = todayIso();
    void Promise.all([
      listProductsForBranch(ctx.activeBranchId),
      listBranchMinStock().catch(() => new Map<string, Map<string, number>>()),
      // Solo encargado/dueño ven las ventas por producto; el cajero pide sin ese dato.
      listSalesByProduct(ctx.activeBranchId, addDaysIso(to, -SALES_DAYS), addDaysIso(to, -1)).catch(() => null)
    ])
      .then(([products, mins, sales]) => {
        if (cancelled) return;
        const own = products.filter((p) => (p.active ?? true) && !p.stockSourceId);
        const perDay = sales ? perDayFromSales(sales, SALES_DAYS) : null;
        const suggestions = buildSuggestions(
          own.map((p) => ({ productId: p.id, name: p.name, code: p.code, unit: p.unit, stock: p.stock, productMin: p.minStock, active: p.active ?? true, isPresentation: !!p.stockSourceId })),
          mins.get(ctx.activeBranchId) ?? new Map(),
          perDay
        );
        setLines(suggestions.map((s) => ({ ...s, qty: String(s.suggested) })));
        setCatalog(own.map((p) => ({ id: p.id, name: p.name, code: p.code, unit: p.unit, stock: p.stock })));
        perDayRef.current = perDay;
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "No se pudieron cargar los productos."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ctx.activeBranchId]);

  const inList = useMemo(() => new Set(lines.map((l) => l.productId)), [lines]);
  const parsed = lines.map((l) => ({ ...l, n: parseQuantity(l.qty) }));
  const totals = qtyTotals(parsed.map((l) => ({ unit: l.unit, qty: Number.isFinite(l.n) ? l.n : 0 })));
  const others = ctx.branches.filter((b) => b.id !== ctx.activeBranchId);

  function add(p: PickableProduct) {
    setLines((list) => [...list, { productId: p.id, name: p.name, code: p.code, unit: p.unit, stock: p.stock ?? 0, min: null, perDay: perDayRef.current?.get(p.id) ?? (perDayRef.current ? 0 : null), suggested: null, qty: "" }]);
  }

  async function submit() {
    setError("");
    if (!fromId) return setError("Elegí a qué local le pedís.");
    const bad = parsed.find((l) => l.qty.trim() !== "" && (!Number.isFinite(l.n) || l.n < 0));
    if (bad) return setError(`Revisá la cantidad de ${bad.name}.`);
    const send = parsed.filter((l) => Number.isFinite(l.n) && l.n > 0);
    if (send.length === 0) return setError("Poné la cantidad de al menos un producto.");
    setBusy(true);
    try {
      await requestTransfer({ fromBranchId: fromId, toBranchId: ctx.activeBranchId, neededBy, notes, lines: send.map((l) => ({ productId: l.productId, quantity: l.n })) });
      try {
        window.localStorage.setItem(fromKey(ctx.activeBranchId), fromId);
      } catch {
        // Recordarlo es solo una comodidad.
      }
      ctx.notify(`Listo: le pediste ${send.length} producto${send.length === 1 ? "" : "s"} a ${ctx.branchName(fromId)}. Lo ven en "Pedidos para preparar".`);
      await ctx.reload();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo mandar el pedido.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-main panel">
      <div className="ws-head">
        <div>
          <h2>Nuevo pedido de {ctx.branchName(ctx.activeBranchId)}</h2>
          <p className="muted">Ya cargamos lo que está debajo del mínimo. Cambiá las cantidades o sumá productos.</p>
        </div>
        <div className="ws-form-row">
          <label className="ws-field">
            Le pedís a
            <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
              {!fromId && <option value="">Elegí…</option>}
              {others.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
          <label className="ws-field">
            Para cuándo
            <input type="date" value={neededBy} min={todayIso()} onChange={(e) => setNeededBy(e.target.value)} />
          </label>
        </div>
      </div>

      {error && <div className="message warning">{error}</div>}
      {loading ? (
        <p className="muted">Cargando los productos del local…</p>
      ) : (
        <>
          {lines.length === 0 && <p className="muted">No hay productos debajo del mínimo. Buscá abajo lo que quieras pedir.</p>}
          {lines.length > 0 && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="num">Tenés</th>
                    <th className="num hide-sm">Mínimo del local</th>
                    <th className="num hide-sm">Vendés por día</th>
                    <th className="num">Te sugerimos</th>
                    <th className="num">Pedís</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.productId}>
                      <td>
                        <b>{l.name}</b> {l.code && <span className="muted">({l.code})</span>}
                        {l.suggested === null && <span className="badge">lo sumaste vos</span>}
                      </td>
                      <td className={`num${l.min !== null && l.stock < l.min ? " down" : ""}`}>{formatQty(l.stock, l.unit)}</td>
                      <td className="num hide-sm">{l.min !== null ? formatQty(l.min, l.unit) : "—"}</td>
                      <td className="num hide-sm">{l.perDay !== null ? formatQty(Math.round(l.perDay * 10) / 10, l.unit) : "—"}</td>
                      <td className="num">{l.suggested !== null ? formatQty(l.suggested, l.unit) : "—"}</td>
                      <td className="num">
                        <input
                          className={`tr-qty${l.suggested !== null && l.qty !== String(l.suggested) ? " tr-changed" : ""}`}
                          type="text"
                          inputMode="decimal"
                          value={l.qty}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setLines((list) => list.map((x, i) => (i === idx ? { ...x, qty: e.target.value } : x)))}
                        />
                      </td>
                      <td className="num">
                        <button type="button" className="link-button" aria-label={`Sacar ${l.name}`} onClick={() => setLines((list) => list.filter((_, i) => i !== idx))}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="ws-form">
            <ProductSearch products={catalog} exclude={inList} placeholder="Sumar otro producto por nombre o código…" onPick={add} />
          </div>
          <div className="ws-form-total">
            <span>
              {totals.products} producto{totals.products === 1 ? "" : "s"} <b>{totalsLabel(totals)}</b>
            </span>
            <input className="ws-grow" placeholder={`Nota para ${ctx.branchName(fromId)} (opcional)`} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
            <button className="charge-button ws-go" disabled={busy || totals.products === 0} onClick={() => void submit()}>
              {busy ? "Mandando…" : `Mandar pedido a ${ctx.branchName(fromId)}`}
            </button>
          </div>
          <p className="muted transfers-help">
            La sugerencia es lo que falta para llegar al mínimo del local, redondeado para arriba.
            {lines.some((l) => l.perDay !== null) && ` "Vendés por día" es el promedio de las últimas ${SALES_DAYS / 7} semanas de este local.`}
          </p>
        </>
      )}
    </section>
  );
}
