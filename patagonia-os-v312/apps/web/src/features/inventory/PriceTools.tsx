import { useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { useAuth } from "../auth/AuthProvider";
import { formatMoney } from "../shifts/format";
import { bulkUpdateProductPrices } from "./inventory-service";
import type { ProductCategory } from "./product-categories-service";
import { LOW_MARGIN_ALERT, buildPricePlan, lowMarginProducts, validatePlanOptions, type PriceMode, type PriceRounding } from "./price-tools";

interface Props {
  products: Product[];
  categories: ProductCategory[];
  onApplied: () => Promise<void> | void;
}

const ROUNDING_OPTIONS: { value: PriceRounding; label: string }[] = [
  { value: 0, label: "Sin redondeo" },
  { value: 10, label: "A $10" },
  { value: 50, label: "A $50" },
  { value: 100, label: "A $100" }
];

/** Herramienta de inflación: sube/baja precios por porcentaje o los lleva a un
 * margen mínimo, con vista previa de cada cambio antes de guardar. */
export function PriceTools({ products, categories, onApplied }: Props) {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PriceMode>("percent");
  const [percentText, setPercentText] = useState("");
  const [marginText, setMarginText] = useState("30");
  const [rounding, setRounding] = useState<PriceRounding>(100);
  const [alsoCost, setAlsoCost] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const options = useMemo(
    () => ({
      mode,
      percent: Number(percentText.replace(",", ".")),
      targetMargin: Number(marginText.replace(",", ".")),
      rounding,
      alsoCost,
      categoryId
    }),
    [mode, percentText, marginText, rounding, alsoCost, categoryId]
  );
  const validation = validatePlanOptions(options);
  const plan = useMemo(() => buildPricePlan(products, options), [products, options]);
  const lowMargin = useMemo(() => lowMarginProducts(products), [products]);

  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) return null;

  async function apply() {
    if (plan.length === 0 || busy) return;
    const scope = categoryId ? `la categoría "${categories.find((c) => c.id === categoryId)?.name ?? ""}"` : "todos los productos activos";
    const what = mode === "percent"
      ? `${Number(percentText.replace(",", ".")) > 0 ? "subir" : "bajar"} ${Math.abs(Number(percentText.replace(",", ".")))}%${alsoCost ? " (precio y costo)" : ""}`
      : `llevar al margen mínimo de ${marginText}%`;
    if (!window.confirm(`Vas a ${what} el precio de ${plan.length} productos de ${scope}. Los cambios quedan registrados en Auditoría. ¿Aplicar?`)) return;

    setBusy(true);
    setMessage("");
    try {
      const result = await bulkUpdateProductPrices(plan.map((r) => ({ id: r.id, priceRetail: r.newPrice, cost: r.newCost })));
      await onApplied();
      setMessage(`Listo: se actualizaron ${result.updated} productos.`);
      setPercentText("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron actualizar los precios.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <button className="secondary" onClick={() => setOpen((v) => !v)}>
        {open ? "Ocultar actualización de precios" : "Actualizar precios (inflación)"}
        {!open && lowMargin.length > 0 && <span className="price-tools-badge">{lowMargin.length} con margen bajo</span>}
      </button>

      {open && (
        <div className="price-tools">
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
            {lowMargin.length > 0
              ? `${lowMargin.length} productos tienen un margen menor al ${LOW_MARGIN_ALERT}% sobre el costo.`
              : `Ningún producto tiene un margen menor al ${LOW_MARGIN_ALERT}%.`}{" "}
            Mirá la vista previa antes de aplicar: se muestra exactamente lo que se va a guardar.
          </p>

          <div className="price-tools-modes">
            <label><input type="radio" checked={mode === "percent"} onChange={() => setMode("percent")} /> Subir o bajar un porcentaje</label>
            <label><input type="radio" checked={mode === "margin"} onChange={() => setMode("margin")} /> Llevar al margen mínimo (solo sube los que están por debajo)</label>
          </div>

          <div className="cash-banner-form" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            {mode === "percent" ? (
              <label className="field" style={{ width: 150 }}>
                <span>Porcentaje (%)</span>
                <input type="text" inputMode="decimal" placeholder="Ej. 8 o -5" value={percentText} onChange={(e) => setPercentText(e.target.value)} />
              </label>
            ) : (
              <label className="field" style={{ width: 150 }}>
                <span>Margen mínimo (%)</span>
                <input type="text" inputMode="decimal" value={marginText} onChange={(e) => setMarginText(e.target.value)} />
              </label>
            )}
            <label className="field" style={{ width: 200 }}>
              <span>Productos</span>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Todos los activos</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ width: 150 }}>
              <span>Redondeo</span>
              <select value={rounding} onChange={(e) => setRounding(Number(e.target.value) as PriceRounding)}>
                {ROUNDING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            {mode === "percent" && (
              <label className="price-tools-check">
                <input type="checkbox" checked={alsoCost} onChange={(e) => setAlsoCost(e.target.checked)} /> Subir también el costo
              </label>
            )}
          </div>

          {validation && (percentText || mode === "margin") && <p className="price-tools-warning">{validation}</p>}

          {!validation && (
            <>
              <p style={{ margin: "12px 0 6px", fontWeight: 700 }}>
                {plan.length === 0 ? "Con estas opciones no cambia ningún producto." : `Vista previa: ${plan.length} productos cambian`}
              </p>
              {plan.length > 0 && (
                <div className="price-tools-preview">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Producto</th>
                        <th className="num">Precio actual</th>
                        <th className="num">Precio nuevo</th>
                        <th className="num">Margen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.map((row) => (
                        <tr key={row.id}>
                          <td>{row.code} · {row.name}</td>
                          <td className="num">{formatMoney(row.oldPrice)}</td>
                          <td className="num"><strong>{formatMoney(row.newPrice)}</strong></td>
                          <td className="num">{row.oldMargin}% → {row.newMargin}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button className="price-tools-apply" disabled={plan.length === 0 || busy} onClick={() => void apply()}>
                {busy ? "Aplicando…" : plan.length > 0 ? `Aplicar ${plan.length} cambios` : "Aplicar"}
              </button>
            </>
          )}

          {message && <p className="message" style={{ marginTop: 12 }}>{message}</p>}
        </div>
      )}
    </div>
  );
}
