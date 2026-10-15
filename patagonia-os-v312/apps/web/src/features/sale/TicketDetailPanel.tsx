import { useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import { checkTicketDetail, quantityFor, type DetailRow } from "./ticket-detail";

/**
 * "¿Qué productos lleva este ticket?" (Mostrador). Aparece al escanear el código del TOTAL de una balanza que no
 * imprime un código por producto (Kretz Aura de fábrica). La cajera elige cada producto del papel y copia su
 * importe; Patagonia calcula los kilos, controla que sumen exacto el total y carga los productos (el stock baja al
 * cobrar). Si no se puede, "Cobrar solo el total" deja todo como antes (sin bajar stock).
 */
export function TicketDetailPanel({ total, products, onConfirm, onTotalOnly, onCancel }: {
  total: number;
  products: Product[];
  onConfirm: (rows: DetailRow[]) => void;
  onTotalOnly: () => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<{ text: string; amount: string }[]>([{ text: "", amount: "" }, { text: "", amount: "" }]);
  const active = useMemo(() => products.filter((p) => p.active !== false), [products]);
  const label = (p: Product) => `${p.code} · ${p.name}`;
  const find = (text: string): Product | null => {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    return active.find((p) => label(p).toLowerCase() === t || p.code.toLowerCase() === t) ?? null;
  };
  const inputs = rows.map((r) => ({ product: find(r.text), amount: parseAmount(r.amount || "0") || 0 }));
  const check = checkTicketDetail(total, inputs);
  const set = (i: number, patch: Partial<{ text: string; amount: string }>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="pos-manual-card" style={{ display: "grid", gap: 10, border: "2px solid #8b1e1e" }}>
      <strong>Ticket de la balanza de {formatMoney(total)}: ¿qué productos lleva?</strong>
      <span className="muted" style={{ fontSize: 13 }}>Elegí cada producto del papel y copiá su importe (el número de la derecha). Así se cobra igual y baja el stock.</span>
      <datalist id="ticket-detail-products">
        {active.map((p) => <option key={p.id} value={label(p)} />)}
      </datalist>
      {rows.map((r, i) => {
        const product = inputs[i].product;
        const qty = product && inputs[i].amount > 0 ? quantityFor(product, inputs[i].amount) : null;
        return (
          <div key={i} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              list="ticket-detail-products"
              placeholder="Producto (código o nombre)"
              value={r.text}
              onChange={(e) => set(i, { text: e.target.value })}
              style={{ flex: "1 1 220px", minWidth: 180, borderColor: r.text && !product ? "#b45309" : undefined }}
              autoFocus={i === 0}
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Importe $"
              value={r.amount}
              onChange={(e) => set(i, { amount: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (check.ok) onConfirm(check.rows);
                else if (i === rows.length - 1) setRows([...rows, { text: "", amount: "" }]);
              }}
              style={{ width: 120 }}
            />
            <span className="muted" style={{ fontSize: 13, minWidth: 90 }}>
              {qty !== null && product ? (product.unit === "kg" ? `${qty.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : `${qty} u.`) : r.text && !product ? "elegí de la lista" : ""}
            </span>
          </div>
        );
      })}
      <div>
        <button className="secondary" onClick={() => setRows([...rows, { text: "", amount: "" }])}>+ Otro producto</button>
      </div>
      <span style={{ fontWeight: 700, color: check.ok ? "#176329" : "#8a4b00" }}>{check.ok ? `✓ Suma justo ${formatMoney(total)}` : check.reason}</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button disabled={!check.ok} onClick={() => check.ok && onConfirm(check.rows)}>Cargar productos</button>
        <button className="secondary" onClick={onTotalOnly}>Cobrar solo el total (no baja stock)</button>
        <button className="secondary" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}
