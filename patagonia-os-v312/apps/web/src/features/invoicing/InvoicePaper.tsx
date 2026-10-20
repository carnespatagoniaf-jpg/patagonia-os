import qrcode from "qrcode-generator";
import { formatMoney } from "../shifts/format";
import {
  CUSTOMER_CONDITION_LABEL,
  VOUCHER_NAME,
  arDateLabel,
  customerDocLabel,
  formatCuit,
  voucherNumberLabel,
  type InvoicePrint
} from "./invoicing-view";

// Partes de la factura en papel común (Mostrador sin térmica, Facturas, Clientes).
// La térmica arma lo mismo en sale-tickets.ts (invoiceHeader / invoiceFooter).

/** QR de ARCA como SVG (se imprime nítido a cualquier tamaño). */
export function InvoiceQr({ url, size = 120 }: { url: string; size?: number }) {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) cells.push(`M${c} ${r}h1v1h-1z`);
    }
  }
  return (
    <svg width={size} height={size} viewBox={`-2 -2 ${count + 4} ${count + 4}`} shapeRendering="crispEdges" role="img" aria-label="Código QR de ARCA">
      <rect x={-2} y={-2} width={count + 4} height={count + 4} fill="#fff" />
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}

export function InvoicePaperHeader({ invoice }: { invoice: InvoicePrint }) {
  const voucher = VOUCHER_NAME[invoice.voucherType];
  const doc = customerDocLabel(invoice.customer.docType, invoice.customer.docNumber);
  return (
    <div className="ticket-header">
      <strong>{voucher?.name ?? `FACTURA ${invoice.letter}`}</strong>
      <p>Cód. {voucher?.code} · Original</p>
      <p><strong>{invoice.issuer.businessName}</strong></p>
      {invoice.issuer.address && <p>{invoice.issuer.address}</p>}
      <p>CUIT {formatCuit(invoice.issuer.cuit)} · {invoice.issuer.taxCondition === "monotributo" ? "Responsable Monotributo" : "IVA Responsable Inscripto"}</p>
      {(invoice.issuer.grossIncomeNumber || invoice.issuer.activityStart) && (
        <p>
          {invoice.issuer.grossIncomeNumber && `IIBB ${invoice.issuer.grossIncomeNumber}`}
          {invoice.issuer.grossIncomeNumber && invoice.issuer.activityStart && " · "}
          {invoice.issuer.activityStart && `Inicio de actividades ${arDateLabel(invoice.issuer.activityStart)}`}
        </p>
      )}
      <p>
        Nro {voucherNumberLabel(invoice.pointOfSale, invoice.number)} · Fecha {arDateLabel(invoice.issuedOn)}
      </p>
      {invoice.relatedLabel && <p>Anula: {invoice.relatedLabel}</p>}
      <p>
        Cliente: {CUSTOMER_CONDITION_LABEL[invoice.customer.taxCondition]}
        {doc && ` · ${doc}`}
        {invoice.customer.name && ` · ${invoice.customer.name}`}
      </p>
    </div>
  );
}

export function InvoicePaperFooter({ invoice }: { invoice: InvoicePrint }) {
  const rate = String(invoice.vatRate).replace(".", ",");
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
      <InvoiceQr url={invoice.qrUrl} />
      <div className="ticket-line-sm">
        {invoice.letter === "A" && (
          <>
            <div>Neto gravado: {formatMoney(invoice.net)}</div>
            <div>IVA {rate}%: {formatMoney(invoice.vat)}</div>
          </>
        )}
        {invoice.letter === "B" && <div>IVA contenido ({rate}%): {formatMoney(invoice.vat)}</div>}
        <div><strong>CAE {invoice.cae}</strong></div>
        <div>Vto. CAE {arDateLabel(invoice.caeDue)}</div>
        <div>Comprobante autorizado por ARCA</div>
      </div>
    </div>
  );
}
