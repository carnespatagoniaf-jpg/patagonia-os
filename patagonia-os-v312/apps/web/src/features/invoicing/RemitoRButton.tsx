import { useEffect, useState } from "react";
import { CUSTOMER_CONDITION_LABEL, voucherNumberLabel } from "./invoicing-view";
import { CONSUMER_ID_THRESHOLD, validateRemitoIssue, type Remito, type RemitoIssueForm } from "./remito-r";
import { getChargeRemito, getLastCustomerRemito, issueRemito, listRemitoCais } from "./remito-service";
import { getCustomerTaxData } from "./invoicing-service";
import { RemitoRPrint } from "./RemitoRPaper";

const CONDITIONS: RemitoIssueForm["condition"][] = ["responsable_inscripto", "monotributo", "exento", "consumidor_final"];

const emptyForm = (): RemitoIssueForm => ({
  condition: "consumidor_final",
  doc: "",
  address: "",
  thirdPartyCarrier: false,
  carrierName: "",
  carrierCuit: "",
  carrierAddress: ""
});

/**
 * Clientes → botón "Remito R" de una venta a cuenta (plan Full, migraciones 147
 * y 148). Si la venta ya tiene remito, lo vuelve a imprimir; si no, pide los
 * datos del Anexo V de la RG 1415 (destinatario y transportista) y lo emite con
 * el próximo número del CAI.
 */
export function RemitoRButton({ chargeId, customerId, amount }: { chargeId: string; customerId: string; amount: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<RemitoIssueForm>(emptyForm());
  const [deliveryAddress, setDeliveryAddress] = useState("");
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
        return;
      }
      // Se proponen los datos que ya tiene el cliente (factura o remito anterior).
      const [tax, last] = await Promise.all([getCustomerTaxData(customerId), getLastCustomerRemito(customerId).catch(() => null)]);
      setForm({
        ...emptyForm(),
        condition: (tax.taxCondition ?? (last?.receiver.taxCondition as RemitoIssueForm["condition"] | null) ?? "consumidor_final"),
        doc: tax.taxId || last?.receiver.taxId || "",
        address: last?.receiver.address ?? ""
      });
      setOpen(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo buscar el remito.");
    } finally {
      setBusy(false);
    }
  }

  async function handleIssue() {
    const error = validateRemitoIssue(form, amount);
    if (error) {
      setMessage(error);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const remito = await issueRemito({
        chargeId,
        receiverCondition: form.condition,
        receiverDoc: form.doc,
        receiverAddress: form.address,
        deliveryAddress,
        carrier: form.thirdPartyCarrier ? { name: form.carrierName, cuit: form.carrierCuit, address: form.carrierAddress } : null,
        notes,
        showValues
      });
      setIssued(remito);
      setOpen(false);
      setPrinting(remito);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo emitir el remito.");
    } finally {
      setBusy(false);
    }
  }

  const isConsumer = form.condition === "consumidor_final";
  const needsIdentity = !isConsumer || amount >= CONSUMER_ID_THRESHOLD;

  return (
    <>
      <button className="secondary" disabled={busy} onClick={() => void handleClick()} title={issued ? `Remito ${voucherNumberLabel(issued.pointOfSale, issued.number)}` : "Remito oficial con CAI"}>
        {busy ? "…" : issued ? `Remito R ${issued.number}` : "Remito R"}
      </button>{" "}
      {open && (
        <div style={{ display: "grid", gap: 6, marginTop: 6, padding: 8, border: "1px solid #e3e6ea", borderRadius: 8, maxWidth: 400, background: "#fff" }}>
          <strong style={{ fontSize: 13 }}>Emitir Remito R</strong>
          <label style={{ fontSize: 13 }}>
            Condición del cliente frente al IVA
            <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value as RemitoIssueForm["condition"] })}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>{CUSTOMER_CONDITION_LABEL[c]}</option>
              ))}
            </select>
          </label>
          {needsIdentity ? (
            <>
              <input value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })} inputMode="numeric" placeholder={isConsumer ? "CUIT, CUIL o DNI del cliente" : "CUIT del cliente (11 números)"} />
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Domicilio comercial del cliente" />
            </>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>A consumidor final por menos de $5.000 sale "A CONSUMIDOR FINAL", sin datos del cliente.</span>
          )}
          <input value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} placeholder="Lugar de entrega, si es otro (opcional)" />
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={form.thirdPartyCarrier} onChange={(e) => setForm({ ...form, thirdPartyCarrier: e.target.checked })} /> Lo lleva un transportista (no es transporte propio)
          </label>
          {form.thirdPartyCarrier && (
            <>
              <input value={form.carrierName} onChange={(e) => setForm({ ...form, carrierName: e.target.value })} placeholder="Nombre o razón social del transportista" />
              <input value={form.carrierCuit} onChange={(e) => setForm({ ...form, carrierCuit: e.target.value })} inputMode="numeric" placeholder="CUIT del transportista (11 números)" />
              <input value={form.carrierAddress} onChange={(e) => setForm({ ...form, carrierAddress: e.target.value })} placeholder="Domicilio comercial del transportista" />
            </>
          )}
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
      {message && <div style={{ fontSize: 12, color: "#8b1e1e", maxWidth: 400 }}>{message}</div>}
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
