// "Descargar PDF" del Detalle de cuenta corriente (Clientes): baja un archivo
// con los movimientos del cliente para mandárselo por WhatsApp o guardarlo,
// sin pasar por el diálogo de imprimir. jsPDF se carga recién al tocar el
// botón, así no pesa en la carga del sistema.

export interface StatementRow {
  date: string;
  detail: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface StatementInput {
  business: string;
  customerName: string;
  customerNumber?: number;
  phone?: string;
  location?: string;
  issuedAt: string;
  rows: StatementRow[];
}

function money(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 })
    .format(value)
    .replace(/ /g, " ");
}

function shortDate(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** Nombre del archivo: "Cuenta corriente - DON ARMANDO - 2026-10-19.pdf". */
export function statementFileName(customerName: string, issuedAt: string) {
  const safe = customerName.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "cliente";
  return `Cuenta corriente - ${safe} - ${issuedAt.slice(0, 10)}.pdf`;
}

export function balanceLabel(balance: number) {
  if (balance > 0) return `Debe ${money(balance)}`;
  if (balance < 0) return `A favor ${money(-balance)}`;
  return "Al día";
}

/** Arma el PDF (sin bajarlo): separado para poder probarlo fuera del navegador. */
export async function buildCustomerStatementPdf(input: StatementInput) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const left = 14;
  const finalBalance = input.rows.length ? input.rows[input.rows.length - 1].balance : 0;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(input.business || "Cuenta corriente", left, 18);
  doc.setFontSize(12);
  doc.text("Cuenta corriente", left, 26);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const customerLine = `${input.customerNumber ? `Cliente N.º ${input.customerNumber} · ` : "Cliente: "}${input.customerName}`;
  const lines = [customerLine];
  const contact = [input.phone, input.location].filter(Boolean).join(" · ");
  if (contact) lines.push(contact);
  lines.push(`Fecha: ${shortDate(input.issuedAt)}`);
  doc.text(lines, left, 34);

  const startY = 34 + lines.length * 5 + 2;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(`Saldo: ${balanceLabel(finalBalance)}`, left, startY + 2);

  autoTable(doc, {
    startY: startY + 7,
    head: [["Fecha", "Concepto", "Venta", "Pago", "Saldo"]],
    body: input.rows.map((row) => [
      shortDate(row.date),
      row.detail,
      row.debit > 0 ? money(row.debit) : "-",
      row.credit > 0 ? money(row.credit) : "-",
      money(row.balance)
    ]),
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [21, 25, 31], textColor: 255 },
    columnStyles: {
      0: { cellWidth: 22 },
      2: { halign: "right", cellWidth: 26 },
      3: { halign: "right", cellWidth: 26 },
      4: { halign: "right", cellWidth: 28 }
    },
    margin: { left, right: left }
  });

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Página ${page} de ${pages}`, 196, 290, { align: "right" });
  }

  return doc;
}

export async function downloadCustomerStatementPdf(input: StatementInput) {
  const doc = await buildCustomerStatementPdf(input);
  doc.save(statementFileName(input.customerName, input.issuedAt));
}
