import {
  CUSTOMER_CONDITION_LABEL,
  invoiceDraftError,
  invoiceLetterFor,
  type CustomerCondition,
  type InvoiceDraft,
  type IssuerCondition
} from "./invoicing-view";

/**
 * "El cliente pide factura" en Mostrador (y en Facturas → Ventas sin factura).
 * Cerrado ocupa una línea; al tildarlo pide solo lo necesario y avisa qué letra sale.
 */
export function InvoiceRequestFields({
  issuer,
  draft,
  total,
  onChange
}: {
  issuer: IssuerCondition;
  draft: InvoiceDraft;
  total: number;
  onChange: (draft: InvoiceDraft) => void;
}) {
  const letter = invoiceLetterFor(issuer, draft.customerCondition);
  const error = invoiceDraftError(issuer, draft, total);
  return (
    <div style={{ display: "grid", gap: 8, margin: "10px 0" }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 700 }}>
        <input type="checkbox" checked={draft.wanted} onChange={(e) => onChange({ ...draft, wanted: e.target.checked })} />
        El cliente pide factura
        {draft.wanted && <span className="setting-status ok">Factura {letter}</span>}
      </label>
      {draft.wanted && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={draft.customerCondition}
            onChange={(e) => onChange({ ...draft, customerCondition: e.target.value as CustomerCondition })}
          >
            {(Object.keys(CUSTOMER_CONDITION_LABEL) as CustomerCondition[]).map((c) => (
              <option key={c} value={c}>{CUSTOMER_CONDITION_LABEL[c]}</option>
            ))}
          </select>
          <input
            name="invoice-customer-doc"
            autoComplete="off"
            inputMode="numeric"
            placeholder={letter === "A" ? "CUIT del cliente" : "CUIT o DNI (opcional)"}
            value={draft.doc}
            onChange={(e) => onChange({ ...draft, doc: e.target.value })}
            style={{ width: 180 }}
          />
          <input
            name="invoice-customer-name"
            autoComplete="off"
            placeholder="Nombre o razón social (opcional)"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            style={{ width: 240 }}
          />
          {error && <span style={{ color: "#8b1e1e", fontSize: 13, fontWeight: 700 }}>{error}</span>}
        </div>
      )}
    </div>
  );
}
