import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { formatMoney } from "../shifts/format";
import { arDateLabel, formatCuit, voucherNumberLabel } from "./invoicing-view";
import { ISSUER_LEGEND, RECEIVER_LEGEND, REMITO_R_CODE, receiverIdentified, remitoQuantityLabel, type Remito } from "./remito-r";

// Remito R según el Anexo V de la RG 1415. Los números entre corchetes de los
// comentarios son los puntos de ese anexo. Autoimpresor responsable inscripto o
// exento: no lleva los datos de la imprenta (I, a, 10 y 11; ver V.8).

const docLabel = (doc: string) => {
  const digits = doc.replace(/\D/g, "");
  return digits.length === 11 ? `CUIT: ${formatCuit(digits)}` : `DNI: ${digits}`;
};

function Copy({ remito, copy }: { remito: Remito; copy: "ORIGINAL" | "DUPLICADO" }) {
  const r = remito;
  const cell = { border: "1px solid #000", padding: "6px 8px" } as const;
  const identified = receiverIdentified(r);
  return (
    <div style={{ color: "#000", fontSize: 12, pageBreakAfter: copy === "ORIGINAL" ? "always" : undefined, marginBottom: 24 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", border: "1px solid #000" }}>
        <div style={{ padding: 8 }}>
          {r.issuer.tradeName && <div style={{ fontSize: 18, fontWeight: 800 }}>{r.issuer.tradeName}</div>}
          {/* [I.a.1] [I.a.2] [I.a.5] */}
          <div style={{ fontWeight: 700 }}>{r.issuer.businessName}</div>
          <div>Domicilio comercial: {r.issuer.address}</div>
          <div style={{ fontWeight: 700 }}>{ISSUER_LEGEND[r.issuer.taxCondition ?? ""] ?? r.issuer.taxCondition}</div>
        </div>
        {/* [I.a.8] */}
        <div style={{ borderLeft: "1px solid #000", borderRight: "1px solid #000", padding: "4px 14px", textAlign: "center" }}>
          <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1 }}>R</div>
          <div style={{ fontSize: 10 }}>COD. {REMITO_R_CODE}</div>
        </div>
        <div style={{ padding: 8 }}>
          {/* [I.b] [I.a.6] [I.c] [I.a.3] [I.a.4] [I.a.7] */}
          <div style={{ fontWeight: 800, fontSize: 15 }}>REMITO · {copy}</div>
          <div>N° {voucherNumberLabel(r.pointOfSale, r.number)}</div>
          <div>Fecha de emisión: {arDateLabel(r.issuedOn)}</div>
          <div>CUIT: {formatCuit(r.issuer.cuit)}</div>
          <div>Ingresos Brutos: {r.issuer.grossIncomeNumber}</div>
          {r.issuer.activityStart && <div>Fecha de inicio de actividades: {arDateLabel(r.issuer.activityStart)}</div>}
        </div>
      </div>
      {/* [I.a.9] */}
      <div style={{ textAlign: "center", fontWeight: 700, border: "1px solid #000", borderTop: 0, padding: 4 }}>DOCUMENTO NO VALIDO COMO FACTURA</div>

      {/* [II] Destinatario de los bienes */}
      <div style={{ border: "1px solid #000", borderTop: 0, padding: 8 }}>
        {identified ? (
          <>
            <div>
              <strong>Destinatario:</strong> {r.receiver.name}
            </div>
            {r.receiver.address && <div>Domicilio comercial: {r.receiver.address}</div>}
            {r.receiver.taxId && <div>{docLabel(r.receiver.taxId)}</div>}
            <div style={{ fontWeight: 700 }}>{RECEIVER_LEGEND[r.receiver.taxCondition ?? "consumidor_final"] ?? r.receiver.taxCondition}</div>
          </>
        ) : (
          <div style={{ fontWeight: 700 }}>{RECEIVER_LEGEND.consumidor_final}</div>
        )}
        {r.deliveryAddress && <div>Lugar de entrega: {r.deliveryAddress}</div>}
      </div>

      {/* [IV] Transportista: solo cuando lleva un tercero */}
      {r.carrier && (
        <div style={{ border: "1px solid #000", borderTop: 0, padding: 8 }}>
          <strong>Transportista:</strong> {r.carrier.name}
          {r.carrier.cuit && <> · CUIT: {formatCuit(r.carrier.cuit)}</>}
          {r.carrier.address && <> · Domicilio comercial: {r.carrier.address}</>}
        </div>
      )}

      {/* [III] Descripción, contenido y cantidad de los bienes transportados */}
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

      {/* [I.a.12] [I.a.13] */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 18, marginTop: 14, fontWeight: 700 }}>
        <span>CAI N° {r.cai}</span>
        <span>Fecha de Vto. {arDateLabel(r.caiDue)}</span>
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
