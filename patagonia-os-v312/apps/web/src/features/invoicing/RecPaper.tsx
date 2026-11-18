import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { arDateLabel, formatCuit } from "./invoicing-view";
import { MOVIMIENTO_LABEL, recNumberLabel, type RecRemito } from "./rec-logic";

// Remito Electrónico Cárnico autorizado por ARCA (tipo de comprobante 995).
// Los datos de autorización (número, código, emisión, vencimiento) y la imagen
// del QR son los que devolvió ARCA; el papel solo los muestra.

const qty = (n: number | null) => (n === null ? "" : n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function RecPaper({ remito: r }: { remito: RecRemito }) {
  const cell = { border: "1px solid #000", padding: "5px 8px" } as const;
  const destino =
    r.tipoMovimiento === "REP"
      ? "Reparto (sin destinatario fijo)"
      : r.tipoReceptor === "EM"
        ? "Depósito propio del emisor"
        : "Mercado interno";
  return (
    <div style={{ color: "#000", fontSize: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", border: "1px solid #000" }}>
        <div style={{ padding: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{r.issuer.businessName}</div>
          <div>CUIT: {formatCuit(r.cuitEmisor)}</div>
          {r.issuer.address && <div>Domicilio: {r.issuer.address}</div>}
          {(r.issuer.pointDescription || r.issuer.pointLabel) && <div>Punto de emisión: {r.issuer.pointDescription ?? r.issuer.pointLabel}</div>}
          {r.issuer.categoriaEmisorDesc && <div>Categoría: {r.issuer.categoriaEmisorDesc}</div>}
        </div>
        <div style={{ borderLeft: "1px solid #000", borderRight: "1px solid #000", padding: "4px 14px", textAlign: "center" }}>
          <div style={{ fontSize: 30, fontWeight: 900, lineHeight: 1 }}>R</div>
          <div style={{ fontSize: 10 }}>COD. 995</div>
        </div>
        <div style={{ padding: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 14 }}>REMITO ELECTRÓNICO CÁRNICO</div>
          <div>N° {recNumberLabel(r.pointOfEmission, r.nroRemito)}</div>
          {r.fechaEmision && <div>Fecha de emisión: {arDateLabel(r.fechaEmision)}</div>}
          <div>Movimiento: {MOVIMIENTO_LABEL[r.tipoMovimiento]}</div>
          {r.env === "homo" && <div style={{ fontWeight: 800 }}>PRUEBA (homologación): sin validez</div>}
        </div>
      </div>

      <div style={{ border: "1px solid #000", borderTop: 0, padding: 8 }}>
        <div><strong>Destino:</strong> {destino}</div>
        {r.cuitReceptor && (
          <div>
            <strong>Destinatario:</strong> {r.receptorName ?? ""} · CUIT {formatCuit(r.cuitReceptor)}
          </div>
        )}
        {r.destinoDesc && <div><strong>Domicilio de destino:</strong> {r.destinoDesc}</div>}
        {r.motivo && <div><strong>Motivo del traslado:</strong> {r.motivo}</div>}
      </div>

      <div style={{ border: "1px solid #000", borderTop: 0, padding: 8 }}>
        <strong>Transporte:</strong> {r.transportistaName ? `${r.transportistaName} · ` : ""}CUIT {r.cuitTransportista ? formatCuit(r.cuitTransportista) : "-"}
        {r.cuitConductor && <> · Conductor CUIT/CUIL {formatCuit(r.cuitConductor)}</>}
        <div>
          Patente {r.dominioVehiculo ?? "-"}
          {r.dominioAcoplado && <> · Acoplado {r.dominioAcoplado}</>}
          {r.fechaInicioViaje && <> · Inicio del viaje {arDateLabel(r.fechaInicioViaje)}</>}
          {r.distanciaKm !== null && <> · {qty(r.distanciaKm)} km</>}
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
        <thead>
          <tr>
            <th style={cell}>#</th>
            <th style={cell}>Código ARCA</th>
            <th style={{ ...cell, textAlign: "left" }}>Mercadería</th>
            <th style={cell}>Tropa</th>
            <th style={cell}>Kilos</th>
            <th style={cell}>Unidades</th>
          </tr>
        </thead>
        <tbody>
          {r.items.map((i) => (
            <tr key={i.orden}>
              <td style={{ ...cell, textAlign: "center" }}>{i.orden}</td>
              <td style={{ ...cell, textAlign: "center" }}>{i.codTipoProd}</td>
              <td style={cell}>{i.productName ?? ""}</td>
              <td style={{ ...cell, textAlign: "center" }}>{i.tropa ?? ""}</td>
              <td style={{ ...cell, textAlign: "right" }}>{qty(i.kilos)}</td>
              <td style={{ ...cell, textAlign: "right" }}>{qty(i.unidades)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.notes && <p style={{ margin: "8px 0 0" }}>Observaciones: {r.notes}</p>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, marginTop: 18 }}>
        {r.qrBase64 ? <img src={`data:image/png;base64,${r.qrBase64}`} alt="QR de ARCA" style={{ width: 120, height: 120 }} /> : <span />}
        <div style={{ textAlign: "right", fontWeight: 700 }}>
          <div>Código de autorización: {r.codAutorizacion ?? "-"}</div>
          {r.fechaVencimiento && <div>Vencimiento: {arDateLabel(r.fechaVencimiento)}</div>}
          <div style={{ fontWeight: 400, fontSize: 11 }}>Comprobante autorizado por ARCA</div>
        </div>
      </div>
      {r.status === "anulado" && <div style={{ textAlign: "center", fontSize: 28, fontWeight: 900, marginTop: 8 }}>ANULADO</div>}
    </div>
  );
}

/** Imprime (o guarda como PDF desde el diálogo de impresión) sin tocar el resto de la pantalla. */
export function RecPrint({ remito, onDone }: { remito: RecRemito; onDone: () => void }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const previous = document.title;
    document.title = `Remito ${recNumberLabel(remito.pointOfEmission, remito.nroRemito)}`;
    const t = window.setTimeout(() => {
      window.print();
      document.title = previous;
      doneRef.current();
    }, 150);
    return () => window.clearTimeout(t);
  }, [remito]);
  return createPortal(
    <div className="print-area" style={{ padding: 16, background: "#fff" }}>
      <RecPaper remito={remito} />
    </div>,
    document.body
  );
}
