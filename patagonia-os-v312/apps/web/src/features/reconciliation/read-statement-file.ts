import { decodeFileBytes, parseDelimited, type Cell, type Table } from "../import/import-parse";

/**
 * Lee el archivo del resumen tal como lo baja el homebanking:
 * - .xlsx (Excel nuevo)
 * - .xls de verdad (Excel viejo, binario). Ej. real: Banco Provincia, que lo
 *   genera con JasperReports. Se lee con SheetJS (se carga solo cuando hace falta).
 * - .xls que en realidad es una página web con una tabla (muchos bancos
 *   exportan así su "Excel"): se lee la tabla.
 * - .csv / .txt (cualquier separador)
 * Solo navegador (usa DOMParser).
 */
export async function readStatementFile(file: File): Promise<Table> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    throw new Error("Los resúmenes en PDF no se pueden leer con seguridad. Bajalo del homebanking como Excel o CSV (casi todos los bancos lo permiten).");
  }
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/browser");
    return (await readSheet(file)) as Cell[][];
  }

  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer.slice(0, 4));
  // Firma de los archivos de Office viejos (Excel 97-2003).
  const isBinaryExcel = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  if (isBinaryExcel) return readBinaryExcel(buffer);

  const text = decodeFileBytes(buffer);
  if (/<table[\s>]/i.test(text)) return readHtmlTable(text);
  return parseDelimited(text);
}

async function readBinaryExcel(buffer: ArrayBuffer): Promise<Table> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: true });
  // La hoja con más filas (el detalle de movimientos).
  let best: Table = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Cell[]>(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null });
    if (rows.length > best.length) best = rows;
  }
  if (best.length === 0) throw new Error("El Excel no tiene filas.");
  return best;
}

/** La tabla con más filas de la página (los bancos a veces ponen tablas chicas de encabezado). */
function readHtmlTable(html: string): Table {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  let best: Table = [];
  for (const table of tables) {
    const rows: Table = Array.from(table.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.querySelectorAll("th,td")).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())
    );
    if (rows.length > best.length) best = rows;
  }
  if (best.length === 0) throw new Error("No encontré ninguna tabla en el archivo.");
  return best;
}
