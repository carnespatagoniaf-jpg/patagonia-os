import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { addDaysIso, todayIso } from "../shifts/format";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listSalesByProduct } from "../sale/pos-shift-service";
import { quantityNumber } from "../sale/quantity";
import { fetchProductNames } from "../products/product-names";
import { effectiveMin, fillToMinimum, formatQty, splitByWeights, type TransferUnit } from "../transfers/transfer-logic";
import { listBranchMinStock, listTransferBranches, type TransferBranch } from "../transfers/transfers-service";

// Compras → "Repartir a los locales" (plan Empresa, migración 192). La compra entró a un local (la Planta); acá se
// dice cuánto va a cada local y se arma un envío por local en "Pedidos para preparar" de ese local, que sigue el
// camino de siempre (despachar con remito → en viaje → lo recibe el local). No mueve stock por sí solo.

interface Line {
  productId: string;
  name: string;
  unit: TransferUnit;
  bought: number;
  already: number;
}

export function PurchaseDistribute({ purchaseId, branchId, onDone }: { purchaseId: string; branchId: string; onDone: (text: string) => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [branches, setBranches] = useState<TransferBranch[]>([]);
  const [grid, setGrid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase) return;
    const db = supabase;
    let cancelled = false;
    void (async () => {
      const [{ data: items }, { data: prev }, all] = await Promise.all([
        db.from("purchase_items").select("product_id,quantity").eq("purchase_id", purchaseId),
        db.from("branch_transfers").select("status,branch_transfer_items(product_id,sent_qty)").eq("purchase_id", purchaseId),
        listTransferBranches()
      ]);
      const bought = new Map<string, number>();
      for (const i of (items ?? []) as Array<{ product_id: string | null; quantity: number | string }>) {
        if (i.product_id) bought.set(i.product_id, (bought.get(i.product_id) ?? 0) + Number(i.quantity));
      }
      const already = new Map<string, number>();
      for (const t of (prev ?? []) as Array<{ status: string; branch_transfer_items: Array<{ product_id: string; sent_qty: number | string | null }> | null }>) {
        if (t.status === "cancelado") continue;
        for (const it of t.branch_transfer_items ?? []) already.set(it.product_id, (already.get(it.product_id) ?? 0) + Number(it.sent_qty ?? 0));
      }
      const names = await fetchProductNames(bought.keys());
      if (cancelled) return;
      setLines([...bought].map(([productId, q]) => ({ productId, name: names.get(productId)?.name ?? "Producto", unit: names.get(productId)?.unit ?? "kg", bought: q, already: already.get(productId) ?? 0 })));
      setBranches(all.filter((b) => b.id !== branchId));
    })().catch((err) => !cancelled && setError(err instanceof Error ? err.message : "No se pudo leer la compra."));
    return () => {
      cancelled = true;
    };
  }, [purchaseId, branchId]);

  const k = (b: string, p: string) => `${b}|${p}`;
  const qty = (b: string, p: string) => quantityNumber(grid[k(b, p)] ?? "");
  const left = (l: Line) => Math.round((l.bought - l.already - branches.reduce((a, b) => a + qty(b.id, l.productId), 0)) * 1000) / 1000;
  const shipments = useMemo(() => branches.filter((b) => lines.some((l) => qty(b.id, l.productId) > 0)).length, [branches, lines, grid]); // eslint-disable-line react-hooks/exhaustive-deps

  function fill(values: Map<string, number[]>) {
    const next: Record<string, string> = {};
    for (const l of lines) {
      const v = values.get(l.productId) ?? [];
      branches.forEach((b, i) => {
        if ((v[i] ?? 0) > 0) next[k(b.id, l.productId)] = String(v[i]);
      });
    }
    setGrid(next);
  }

  async function bySales() {
    setError("");
    setBusy(true);
    try {
      const to = todayIso();
      const sales = await Promise.all(branches.map((b) => listSalesByProduct(b.id, addDaysIso(to, -28), addDaysIso(to, -1)).catch(() => [])));
      const values = new Map<string, number[]>();
      for (const l of lines) {
        const weights = sales.map((rows) => rows.filter((r) => r.productId === l.productId).reduce((a, r) => a + r.quantity, 0));
        values.set(l.productId, splitByWeights(l.bought - l.already, weights));
      }
      fill(values);
    } finally {
      setBusy(false);
    }
  }

  async function toMinimum() {
    setError("");
    setBusy(true);
    try {
      const [mins, stocks] = await Promise.all([listBranchMinStock(), Promise.all(branches.map((b) => listProductsForBranch(b.id)))]);
      const values = new Map<string, number[]>();
      for (const l of lines) {
        const needs = branches.map((b, i) => {
          const p = stocks[i].find((x) => x.id === l.productId);
          return p ? effectiveMin(p.minStock, mins.get(b.id)?.get(l.productId)) - Math.max(p.stock, 0) : 0;
        });
        values.set(l.productId, fillToMinimum(l.bought - l.already, needs));
      }
      fill(values);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setError("");
    const over = lines.find((l) => left(l) < -0.0005);
    if (over) return setError(`De ${over.name} estás repartiendo más de lo que compraste.`);
    if (shipments === 0) return setError("Poné cuánto va a cada local.");
    if (!supabase) return;
    const plan = branches.map((b) => ({ branch_id: b.id, items: lines.map((l) => ({ product_id: l.productId, quantity: qty(b.id, l.productId) })).filter((i) => i.quantity > 0) }));
    setBusy(true);
    const { data, error: rpcError } = await supabase.rpc("distribute_purchase", { p_purchase_id: purchaseId, p_plan: plan });
    setBusy(false);
    if (rpcError) return setError(rpcError.message);
    onDone(`Listo: se armaron ${data} envíos. Están en "Entre locales" → "Pedidos para preparar" del local de la compra, para despachar con su remito.`);
  }

  if (lines.length === 0 && !error) return <p className="muted">Cargando la compra…</p>;

  return (
    <div className="ws-form">
      <p className="ws-field-label">Repartir a los locales (se arma un envío por local; la compra queda en este local hasta despacharlos)</p>
      {error && <div className="message warning">{error}</div>}
      <div className="table-scroll">
        <table className="data-table no-stack transfers-min">
          <thead>
            <tr>
              <th>Producto</th>
              <th className="num">Compraste</th>
              {branches.map((b) => (
                <th key={b.id} className="num">{b.name}</th>
              ))}
              <th className="num">Queda acá</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.productId}>
                <td>
                  <b>{l.name}</b>
                  {l.already > 0 && <span className="cell-sub">ya repartido {formatQty(l.already, l.unit)}</span>}
                </td>
                <td className="num">{formatQty(l.bought, l.unit)}</td>
                {branches.map((b) => (
                  <td key={b.id} className="num">
                    <input className="tr-qty tr-min" type="text" inputMode="decimal" value={grid[k(b.id, l.productId)] ?? ""} onChange={(e) => setGrid((g) => ({ ...g, [k(b.id, l.productId)]: e.target.value }))} />
                  </td>
                ))}
                <td className={`num${left(l) < 0 ? " down" : ""}`}><b>{formatQty(left(l), l.unit)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <span className="muted">Atajos:</span>
        <button type="button" className="secondary" disabled={busy} onClick={() => void bySales()}>Según lo que vende cada local</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void toMinimum()}>Completar hasta el mínimo de cada local</button>
        <span className="spacer" />
        <button className="charge-button" disabled={busy || shipments === 0} onClick={() => void submit()}>
          {busy ? "Un momento…" : `Crear ${shipments} envío${shipments === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
