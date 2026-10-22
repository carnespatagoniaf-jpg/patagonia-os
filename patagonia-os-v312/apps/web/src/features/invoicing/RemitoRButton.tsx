import { useEffect, useState } from "react";
import { voucherNumberLabel } from "./invoicing-view";
import type { Remito } from "./remito-r";
import { getChargeRemito, issueRemito, listRemitoCais } from "./remito-service";
import { RemitoRPrint } from "./RemitoRPaper";

/**
 * Clientes → botón "Remito R" de una venta a cuenta (plan Full, migración 147).
 * Si la venta ya tiene remito, lo vuelve a imprimir; si no, pide los datos de
 * entrega y lo emite con el próximo número del CAI.
 */
export function RemitoRButton({ chargeId }: { chargeId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [carrier, setCarrier] = useState("");
  const [notes, setNotes] = useState("");
  const [showValues, setShowValues] = useState(false);
  const [printing, setPrinting] = useState<Remito | null>(null);
  const [issued, setIssued] = useState<Remito | null>(null);

  async function handleClick() {
    setBusy(true);
    setMessage("");
    try {
      const existing = issued ?? (await getChargeRemito(chargeId));
      if (existing) {
        setIssued(existing);
        setPrinting(existing);
      } else {
        setOpen(true);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo buscar el remito.");
    } finally {
      setBusy(false);
    }
  }

  async function handleIssue() {
    setBusy(true);
    setMessage("");
    try {
      const remito = await issueRemito({ chargeId, deliveryAddress, carrier, notes, showValues });
      setIssued(remito);
      setOpen(false);
      setPrinting(remito);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo emitir el remito.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="secondary" disabled={busy} onClick={() => void handleClick()} title={issued ? `Remito ${voucherNumberLabel(issued.pointOfSale, issued.number)}` : "Remito oficial con CAI"}>
        {busy ? "…" : issued ? `Remito R ${issued.number}` : "Remito R"}
      </button>{" "}
      {open && (
        <div style={{ display: "grid", gap: 6, marginTop: 6, padding: 8, border: "1px solid #e3e6ea", borderRadius: 8, maxWidth: 380, background: "#fff" }}>
          <strong style={{ fontSize: 13 }}>Emitir Remito R</strong>
          <input value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} placeholder="Lugar de entrega (si no, la localidad del cliente)" />
          <input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Transporte / patente (opcional)" />
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observaciones (opcional)" />
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={showValues} onChange={(e) => setShowValues(e.target.checked)} /> Mostrar precios en el remito
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <button disabled={busy} onClick={() => void handleIssue()}>Emitir e imprimir</button>
            <button className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>Toma el próximo número del CAI. Si te equivocás, se anula desde Facturas → Remito R.</span>
        </div>
      )}
      {message && <div style={{ fontSize: 12, color: "#8b1e1e", maxWidth: 380 }}>{message}</div>}
      {printing && <RemitoRPrint remito={printing} onDone={() => setPrinting(null)} />}
    </>
  );
}

// Una consulta por carga de pantalla, no una por fila.
let caiCheck: Promise<boolean> | null = null;

/** Clientes muestra "Remito R" solo con plan Full y algún CAI activo cargado en Facturas. */
export function useRemitoREnabled(planOk: boolean): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!planOk) return;
    caiCheck ??= listRemitoCais()
      .then((cais) => cais.some((c) => c.active))
      .catch(() => false);
    let cancelled = false;
    void caiCheck.then((ok) => {
      if (!cancelled) setEnabled(ok);
    });
    return () => {
      cancelled = true;
      caiCheck = null;
    };
  }, [planOk]);
  return enabled;
}
