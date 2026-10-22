import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { formatMoney } from "../shifts/format";
import { CUSTOMER_CONDITION_LABEL, arDateLabel, formatCuit, voucherNumberLabel } from "./invoicing-view";
import { REMITO_R_CODE, remitoQuantityLabel, type Remito } from "./remito-r";

const ISSUER_CONDITION: Record<string, string> = { monotributo: "Responsable Monotributo", responsable_inscripto: "IVA Responsable Inscripto" };

function Copy({ remito, copy }: { remito: Remito; copy: "ORIGINAL" | "DUPLICADO" }) {
  const r = remito;
  const cell = { border: "1px solid #000", padding: "6px 8px" } as const;
  return (
    <div style={{ color: "#000", fontSize: 12, pageBreakAfter: copy === "ORIGINAL" ? "always" : undefined, marginBottom: 24 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", border: "1px solid #000" }}>
        <div style={{ padding: 8 }}>
          {r.issuer.tradeName && <div style={{ fontSize: 18, fontWeight: 800 }}>{r.issuer.tradeName}</div>}
          <div style={{ fontWeight: 700 }}>{r.issuer.businessName}</div>
          {r.issuer.address && <div>{r.issuer.address}</div>}
          <div>{ISSUER_CONDITION[r.issuer.taxCondition ?? ""] ?? r.issuer.taxCondition ?? ""}</div>
        </div>
        <div style={{ borderLeft: "1px solid #000", borderRight: "1px solid #000", padding: "4px 14px", textAlign: "center" }}>
          <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1 }}>R</div>
          <div style={{ fontSize: 10 }}>Cód. {REMITO_R_CODE}</div>
        </div>
        <div style={{ padding: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 15 }}>REMITO · {copy}</div>
          <div>N.º {voucherNumberLabel(r.pointOfSale, r.number)}</div>
          <div>Fecha: {arDateLabel(r.issuedOn)}</div>
          <div>CUIT: {formatCuit(r.issuer.cuit)}</div>
          {r.issuer.grossIncomeNumber && <div>Ingresos Brutos: {r.issuer.grossIncomeNumber}</div>}
          {r.issuer.activityStart && <div>Inicio de actividades: {arDateLabel(r.issuer.activityStart)}</div>}
        </div>
      </div>
      <div style={{ textAlign: "center", fontWeight: 700, border: "1px solid #000", borderTop: 0, padding: 4 }}>DOCUMENTO NO VÁLIDO COMO FACTURA</div>

      <div style={{ border: "1px solid #000", borderTop: 0, padding: 8 }}>
        <div>
          <strong>Señor/es:</strong> {r.receiver.name}
          {r.receiver.number !== null && ` (cliente N.º ${r.receiver.number})`}
        </div>
        <div>
          {r.receiver.taxId && <>CUIT/DNI: {formatCuit(r.receiver.taxId)} · </>}
          Condición frente al IVA: {CUSTOMER_CONDITION_LABEL[(r.receiver.taxCondition ?? "consumidor_final") as keyof typeof CUSTOMER_CONDITION_LABEL] ?? r.receiver.taxCondition}
        </div>
        <div>
          Lugar de entrega: {r.deliveryAddress ?? ([r.receiver.locality, r.receiver.province].filter(Boolean).join(", ") || "—")}
        </div>
        {r.carrier && <div>Transporte: {r.carrier}</div>}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: "right", width: 90 }}>Cantidad</th>
            <th style={{ ...cell, textAlign: "left" }}>Descripción</th>
            {r.showValues && <th style={{ ...cell, textAlign: "right", width: 110 }}>Precio unit.</th>}
            {r.showValues && <th style={{ ...cell, textAlign: "right", width: 110 }}>Importe</th>}
          </tr>
        </thead>
        <tbody>
          {r.items.map((it, i) => (
            <tr key={i}>
              <td style={{ ...cell, textAlign: "right" }}>{remitoQuantityLabel(it)}</td>
              <td style={cell}>{it.code ? `${it.code} · ` : ""}{it.description}</td>
              {r.showValues && <td style={{ ...cell, textAlign: "right" }}>{formatMoney(it.unitPrice)}</td>}
              {r.showValues && <td style={{ ...cell, textAlign: "right" }}>{formatMoney(it.lineTotal)}</td>}
            </tr>
          ))}
          {r.showValues && (
            <tr>
              <td style={cell} colSpan={3}><strong>Total</strong></td>
              <td style={{ ...cell, textAlign: "right" }}><strong>{formatMoney(r.total)}</strong></td>
            </tr>
          )}
        </tbody>
      </table>
      {r.notes && <p style={{ margin: "8px 0 0" }}>Observaciones: {r.notes}</p>}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 24, marginTop: 36 }}>
        <div style={{ flex: 1, borderTop: "1px solid #000", paddingTop: 4, textAlign: "center" }}>Recibí conforme: firma</div>
        <div style={{ flex: 1, borderTop: "1px solid #000", paddingTop: 4, textAlign: "center" }}>Aclaración y DNI</div>
        <div style={{ flex: 1, borderTop: "1px solid #000", paddingTop: 4, textAlign: "center" }}>Fecha</div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 18, marginTop: 14, fontWeight: 700 }}>
        <span>C.A.I. N.º {r.cai}</span>
        <span>Fecha de vencimiento: {arDateLabel(r.caiDue)}</span>
      </div>
      {r.status === "anulado" && <div style={{ textAlign: "center", fontSize: 28, fontWeight: 900, marginTop: 8 }}>ANULADO</div>}
    </div>
  );
}

/** Remito R en papel A4: original (para el cliente) y duplicado (para el negocio). */
export function RemitoRPaper({ remito }: { remito: Remito }) {
  return (
    <>
      <Copy remito={remito} copy="ORIGINAL" />
      <Copy remito={remito} copy="DUPLICADO" />
    </>
  );
}

/** Imprime el remito sin tocar el resto de la pantalla (portal + .print-area) y avisa al terminar. */
export function RemitoRPrint({ remito, onDone }: { remito: Remito; onDone: () => void }) {
  // En un ref para que un onDone nuevo en cada render no vuelva a abrir el diálogo de impresión.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const t = window.setTimeout(() => {
      window.print();
      doneRef.current();
    }, 50);
    return () => window.clearTimeout(t);
  }, [remito]);
  return createPortal(
    <div className="print-area" style={{ padding: 16, background: "#fff" }}>
      <RemitoRPaper remito={remito} />
    </div>,
    document.body
  );
}
