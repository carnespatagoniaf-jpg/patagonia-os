import { useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { formatMoney } from "../shifts/format";
import { WASTE_REASON_LABELS } from "../shifts/period-result";
import type { ScaleConfig } from "./scale-barcode";
import { describeScaleTicket } from "./scale-control";
import { isWeightScaleEnabled, readScaleWeight } from "./scale-weight";
import { parseQuantity } from "./quantity";
import type { PosShift } from "./pos-shift-service";
import { useActiveBranch } from "../branches/BranchProvider";
import { listShiftWastes, registerStockWaste, voidStockWaste, type StockWaste, type WasteReason } from "./waste-service";

const REASONS: WasteReason[] = ["vencido", "mal_estado", "roto", "otro"];
const qtyText = (unit: string | null, n: number) =>
  unit === "kg" ? `${n.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg` : `${n.toLocaleString("es-AR", { maximumFractionDigits: 3 })} u.`;
const time = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

/**
 * Mostrador → "Decomiso" (migración 151, plan Full): lo que se tira se pesa y se
 * anota en la caja. El peso sale de escanear la etiqueta de la balanza, de leer
 * la balanza por cable o se escribe. Descuenta el stock y queda en Reportes → Merma.
 */
export function WasteForm({ visible, shift, products, scaleConfig, canVoid, onMessage, onClose }: {
  visible: boolean;
  shift: PosShift;
  products: Product[];
  scaleConfig: ScaleConfig;
  /** Anular un decomiso: solo dueño/admin (el servidor lo vuelve a controlar). */
  canVoid: boolean;
  onMessage: (message: string) => void;
  onClose: () => void;
}) {
  const { branchId } = useActiveBranch();
  const [code, setCode] = useState("");
  const [search, setSearch] = useState("");
  const [productId, setProductId] = useState<string | null>(null);
  const [quantityText, setQuantityText] = useState("");
  const [barcode, setBarcode] = useState<string | null>(null);
  const [reason, setReason] = useState<WasteReason | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wastes, setWastes] = useState<StockWaste[]>([]);
  const codeRef = useRef<HTMLInputElement>(null);

  const product = products.find((p) => p.id === productId) ?? null;
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || product) return [];
    return products.filter((p) => p.active !== false && (p.name.toLowerCase().includes(q) || p.code === q)).slice(0, 8);
  }, [search, products, product]);

  async function reload() {
    if (!isSupabaseConfigured) return;
    try {
      setWastes(await listShiftWastes(shift.id));
    } catch {
      // informativo
    }
  }

  useEffect(() => {
    if (!visible) return;
    void reload();
    setTimeout(() => codeRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, shift.id]);

  if (!visible) return null;

  function reset() {
    setCode("");
    setSearch("");
    setProductId(null);
    setQuantityText("");
    setBarcode(null);
    setReason(null);
    setNotes("");
    setError("");
  }

  function readCode() {
    setError("");
    const result = describeScaleTicket(code, scaleConfig, products);
    if (!result || result.kind !== "label") {
      setError(result?.kind === "total" ? "Ese es un ticket de total: escaneá la etiqueta del producto." : "Ese código no es una etiqueta de la balanza (o el producto no está cargado).");
      return;
    }
    setProductId(result.product.id);
    setBarcode(code.trim());
    if (result.weightKg) setQuantityText(String(result.weightKg).replace(".", ","));
    setCode("");
  }

  async function readWeight() {
    setError("");
    try {
      const reading = await readScaleWeight();
      if (!(reading.frame.weightKg > 0)) {
        setError("La balanza marca 0: poné la mercadería arriba y volvé a leer.");
        return;
      }
      setQuantityText(String(reading.frame.weightKg).replace(".", ","));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo leer el peso de la balanza.");
    }
  }

  async function save() {
    setError("");
    if (!product) { setError("Elegí qué producto se tira."); return; }
    const quantity = parseQuantity(quantityText);
    if (!(quantity > 0)) { setError(product.unit === "kg" ? "Poné cuántos kilos se tiran." : "Poné cuántas unidades se tiran."); return; }
    if (!reason) { setError("Elegí el motivo."); return; }
    if (reason === "otro" && !notes.trim()) { setError("Contá qué pasó (motivo \"Otro\")."); return; }
    if (!isSupabaseConfigured || !branchId) { setError("En modo demostración no se guarda."); return; }
    setBusy(true);
    try {
      await registerStockWaste({ branchId, productId: product.id, quantity, reason, notes, posShiftId: shift.id, barcode });
      onMessage(`Decomiso anotado: ${qtyText(product.unit, quantity)} de ${product.name} (${WASTE_REASON_LABELS[reason].toLowerCase()}). Se descontó del stock.`);
      reset();
      await reload();
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo anotar el decomiso.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVoid(w: StockWaste) {
    if (!window.confirm(`¿Anular el decomiso de ${w.productName}? Vuelve al stock.`)) return;
    setBusy(true);
    try {
      await voidStockWaste(w.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo anular.");
    } finally {
      setBusy(false);
    }
  }

  const active = wastes.filter((w) => !w.voided);
  const value = active.reduce((sum, w) => sum + w.quantity * w.unitCost, 0);

  return (
    <div style={{ marginTop: 14, background: "#fff8f0", borderRadius: 12, padding: 12 }}>
      <strong>Decomiso: mercadería que se tira</strong>
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
        Pesala en la balanza y escaneá la etiqueta, o elegí el producto y poné los kilos. Se descuenta del stock y queda en Reportes → Merma.
      </p>

      <div style={{ display: "flex", gap: 6 }}>
        <input
          ref={codeRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); readCode(); } }}
          placeholder="Escaneá la etiqueta de la balanza"
          style={{ flex: 1 }}
        />
        <button className="secondary" onClick={readCode} disabled={!code.trim()}>Leer</button>
      </div>

      {product ? (
        <p style={{ margin: "8px 0 0" }}>
          <strong>{product.code} · {product.name}</strong>{" "}
          <button className="secondary" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => { setProductId(null); setBarcode(null); }}>Cambiar</button>
        </p>
      ) : (
        <>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="…o buscá el producto (nombre o código)" style={{ marginTop: 8, width: "100%" }} />
          {matches.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {matches.map((p) => (
                <button key={p.id} className="secondary" onClick={() => { setProductId(p.id); setSearch(""); }}>{p.code} · {p.name}</button>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
        <input
          type="text"
          inputMode="decimal"
          value={quantityText}
          onChange={(e) => setQuantityText(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder={product && product.unit !== "kg" ? "Unidades" : "Kilos (ej.: 1,250)"}
          style={{ width: 150 }}
        />
        {isWeightScaleEnabled() && (!product || product.unit === "kg") && (
          <button className="secondary" onClick={() => void readWeight()}>Leer peso de la balanza</button>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {REASONS.map((r) => (
          <button key={r} className={reason === r ? undefined : "secondary"} onClick={() => setReason(r)}>{WASTE_REASON_LABELS[r]}</button>
        ))}
      </div>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={reason === "otro" ? "¿Qué pasó? (obligatorio)" : "Detalle (opcional)"} style={{ marginTop: 8, width: "100%" }} />

      {product && parseQuantity(quantityText) > 0 && (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
          Se tira {qtyText(product.unit, parseQuantity(quantityText))}
          {canVoid && product.cost > 0 && <> · a costo {formatMoney(parseQuantity(quantityText) * product.cost)}</>}
        </p>
      )}
      {error && <p style={{ color: "#a52424", margin: "6px 0 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Anotar decomiso"}</button>
        <button className="secondary" disabled={busy} onClick={() => { reset(); onClose(); }}>Cerrar</button>
      </div>

      {wastes.length > 0 && (
        <>
          <p className="muted" style={{ margin: "14px 0 6px", fontWeight: 700, fontSize: 12, textTransform: "uppercase" }}>
            Decomisos de esta caja{canVoid && value > 0 ? ` · ${formatMoney(value)} a costo` : ""}
          </p>
          <table className="data-table">
            <tbody>
              {wastes.map((w) => (
                <tr key={w.id} style={w.voided ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                  <td>{time(w.createdAt)}</td>
                  <td>
                    {w.productName}
                    <div className="muted" style={{ fontSize: 12 }}>{WASTE_REASON_LABELS[w.reason]}{w.notes ? ` · ${w.notes}` : ""}</div>
                  </td>
                  <td className="num">{qtyText(w.unit, w.quantity)}</td>
                  <td>{canVoid && !w.voided && <button className="secondary" disabled={busy} onClick={() => void handleVoid(w)}>Anular</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
