import { useState } from "react";
import { checkPriceListPin } from "./price-lists-service";
import type { PriceList } from "./price-lists";

/**
 * Mostrador: "Minorista / Mayorista" para la venta que se está armando. Pasar a una lista a mano
 * pide el PIN de anular si la empresa tiene uno (es un descuento). Volver a Minorista no pide nada.
 * Sin conexión no se puede comprobar el PIN: se deja pasar y queda registrado en la venta.
 */
export function PriceListToggle({ lists, value, onChange, disabled }: { lists: PriceList[]; value: string | null; onChange: (listId: string | null) => void; disabled?: boolean }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function choose(listId: string | null) {
    setError("");
    if (listId === null || listId === value) {
      setAsking(null);
      onChange(listId);
      return;
    }
    setBusy(true);
    try {
      const r = await checkPriceListPin(asking === listId ? pin : null);
      if (r.ok) {
        setAsking(null);
        setPin("");
        onChange(listId);
      } else if ((r as { need_pin?: boolean }).need_pin) {
        setAsking(listId);
      } else {
        setError(r.error ?? "PIN incorrecto.");
      }
    } catch {
      if (!navigator.onLine) {
        setAsking(null);
        onChange(listId);
      } else {
        setError("No se pudo comprobar el PIN. Probá de nuevo.");
      }
    } finally {
      setBusy(false);
    }
  }

  const askingList = lists.find((l) => l.id === asking);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
      <span className="muted" style={{ fontSize: 13 }}>Precio:</span>
      <div role="group" aria-label="Precio de esta venta" style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
        <button type="button" className={value === null ? "" : "secondary"} aria-pressed={value === null} disabled={disabled || busy} onClick={() => void choose(null)}>
          Minorista
        </button>
        {lists.map((l) => (
          <button key={l.id} type="button" className={value === l.id ? "" : "secondary"} aria-pressed={value === l.id} disabled={disabled || busy} onClick={() => void choose(l.id)}>
            {l.name}
          </button>
        ))}
      </div>
      {askingList && (
        <form
          style={{ display: "flex", gap: 6, alignItems: "center" }}
          onSubmit={(e) => {
            e.preventDefault();
            void choose(askingList.id);
          }}
        >
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            placeholder={`PIN para ${askingList.name}`}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            style={{ width: 150 }}
          />
          <button type="submit" disabled={busy || !pin.trim()}>Confirmar</button>
          <button type="button" className="secondary" onClick={() => { setAsking(null); setPin(""); setError(""); }}>Cancelar</button>
        </form>
      )}
      {error && <span style={{ color: "var(--danger, #b42318)", fontSize: 13 }}>{error}</span>}
    </div>
  );
}
