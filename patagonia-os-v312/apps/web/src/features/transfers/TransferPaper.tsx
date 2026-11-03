import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RemitoRPrint } from "../invoicing/RemitoRPaper";
import type { Remito } from "../invoicing/remito-r";
import { getRemito } from "../invoicing/remito-service";
import { formatMoney } from "../shifts/format";
import { formatQty, qtyTotals, totalsLabel, type Transfer } from "./transfer-logic";

// Remito interno de traslado (cuando no sale el Remito R) y la lista para armar el pedido. A4, original y copia.

const ar = (iso: string | null) => (iso ? new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }) : "");

function Copy({ t, kind, copy, branchName, showCost }: { t: Transfer; kind: "remito" | "lista"; copy: string; branchName: (id: string) => string; showCost: boolean }) {
  const cell = { border: "1px solid #000", padding: "5px 8px" } as const;
  const lines = kind === "remito" ? t.items.filter((i) => (i.sent ?? 0) > 0) : t.items;
  const totals = qtyTotals(lines.map((i) => ({ unit: i.unit, qty: kind === "remito" ? i.sent ?? 0 : i.requested ?? i.sent ?? 0, unitCost: i.unitCost })));
  return (
    <div style={{ color: "#000", fontSize: 12, marginBottom: 28, pageBreakAfter: copy === "ORIGINAL" ? "always" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", border: "1px solid #000", padding: 10 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800 }}>{kind === "remito" ? "REMITO INTERNO DE TRASLADO" : "LISTA PARA ARMAR EL PEDIDO"}</div>
          <div>De <b>{branchName(t.fromBranchId)}</b> a <b>{branchName(t.toBranchId)}</b></div>
          {kind === "remito" && <div>Traslado entre locales propios · Documento no válido como factura</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 800, fontSize: 15 }}>N.º {String(t.number).padStart(6, "0")}</div>
          <div>{kind === "remito" ? `Salió: ${ar(t.dispatchedAt)}` : `Pedido: ${ar(t.requestedAt ?? t.createdAt)}`}</div>
          {t.neededBy && <div>Para el {t.neededBy.split("-").reverse().join("/")}</div>}
          {kind === "remito" && <div>{copy}</div>}
        </div>
      </div>
      {(t.carrier || t.vehicle || t.requestNotes) && (
        <div style={{ border: "1px solid #000", borderTop: 0, padding: 8 }}>
          {t.carrier && <span><b>Lo lleva:</b> {t.carrier} </span>}
          {t.vehicle && <span><b>Patente:</b> {t.vehicle} </span>}
          {t.requestNotes && <div><b>Nota:</b> {t.requestNotes}</div>}
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: "left", width: 70 }}>Código</th>
            <th style={{ ...cell, textAlign: "left" }}>Producto</th>
            {kind === "lista" && <th style={{ ...cell, textAlign: "right", width: 100 }}>Pidió</th>}
            <th style={{ ...cell, textAlign: "right", width: 110 }}>{kind === "lista" ? "Se manda" : "Cantidad"}</th>
            {kind === "remito" && <th style={{ ...cell, textAlign: "right", width: 110 }}>Recibido</th>}
            {showCost && <th style={{ ...cell, textAlign: "right", width: 110 }}>Costo</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((i) => (
            <tr key={i.id}>
              <td style={cell}>{i.code ?? ""}</td>
              <td style={cell}>{i.name}</td>
              {kind === "lista" && <td style={{ ...cell, textAlign: "right" }}>{i.requested !== null ? formatQty(i.requested, i.unit) : "agregado"}</td>}
              <td style={{ ...cell, textAlign: "right" }}>{kind === "remito" ? formatQty(i.sent ?? 0, i.unit) : ""}</td>
              {kind === "remito" && <td style={cell} />}
              {showCost && <td style={{ ...cell, textAlign: "right" }}>{formatMoney((i.sent ?? 0) * (i.unitCost ?? 0))}</td>}
            </tr>
          ))}
          <tr>
            <td style={cell} />
            <td style={cell}><b>Total {totals.products} productos</b></td>
            {kind === "lista" && <td style={{ ...cell, textAlign: "right" }}><b>{totalsLabel(totals)}</b></td>}
            <td style={{ ...cell, textAlign: "right" }}>{kind === "remito" && <b>{totalsLabel(totals)}</b>}</td>
            {kind === "remito" && <td style={cell} />}
            {showCost && <td style={{ ...cell, textAlign: "right" }}><b>{formatMoney(totals.cost)}</b></td>}
          </tr>
        </tbody>
      </table>
      {kind === "remito" && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 24, marginTop: 40 }}>
          <div style={{ flex: 1, borderTop: "1px solid #000", paddingTop: 4, textAlign: "center" }}>Entregó (firma y aclaración)</div>
          <div style={{ flex: 1, borderTop: "1px solid #000", paddingTop: 4, textAlign: "center" }}>Recibió (firma y aclaración)</div>
        </div>
      )}
    </div>
  );
}

/** Imprime sin tocar la pantalla (portal + .print-area, como el Remito R) y avisa al terminar. */
export function TransferPrint({ transfer, kind, branchName, showCost, onDone }: { transfer: Transfer; kind: "remito" | "lista"; branchName: (id: string) => string; showCost: boolean; onDone: () => void }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const t = window.setTimeout(() => {
      window.print();
      doneRef.current();
    }, 50);
    return () => window.clearTimeout(t);
  }, [transfer, kind]);
  return createPortal(
    <div className="print-area" style={{ padding: 16, background: "#fff" }}>
      <Copy t={transfer} kind={kind} copy="ORIGINAL" branchName={branchName} showCost={showCost} />
      {kind === "remito" && <Copy t={transfer} kind={kind} copy="COPIA" branchName={branchName} showCost={showCost} />}
    </div>,
    document.body
  );
}

/** Remito del envío: el Remito R si salió con CAI, si no el interno. */
export function TransferRemitoPrint({ transfer, branchName, showCost, onDone, onError }: { transfer: Transfer; branchName: (id: string) => string; showCost: boolean; onDone: () => void; onError: (text: string) => void }) {
  const [remito, setRemito] = useState<Remito | null>(null);
  useEffect(() => {
    if (!transfer.remitoId) return;
    let cancelled = false;
    void getRemito(transfer.remitoId)
      .then((r) => {
        if (cancelled) return;
        if (r) setRemito(r);
        else onError("No se encontró el Remito R de este envío.");
      })
      .catch((err) => !cancelled && onError(err instanceof Error ? err.message : "No se pudo leer el Remito R."));
    return () => {
      cancelled = true;
    };
    // onError cambia en cada render; alcanza con el remito.
  }, [transfer.remitoId]);
  if (!transfer.remitoId) return <TransferPrint transfer={transfer} kind="remito" branchName={branchName} showCost={showCost} onDone={onDone} />;
  return remito ? <RemitoRPrint remito={remito} onDone={onDone} /> : null;
}
