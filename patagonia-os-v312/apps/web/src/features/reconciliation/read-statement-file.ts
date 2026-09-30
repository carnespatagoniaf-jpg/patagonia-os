import { decodeFileBytes, parseDelimited, type Cell, type Table } from "../import/import-parse";

/**
 * Lee el archivo del resumen tal como lo baja el homebanking:
 * - .xlsx (Excel nuevo)
 * - .csv / .txt (cualquier separador)
 * - .xls que en realidad es una página web con una tabla (muchos bancos
 *   exportan así su "Excel"): se lee la tabla.
 * - .xls de verdad (Excel viejo, binario): no se puede leer acá; se pide
 *   guardarlo como .xlsx o .csv.
 * Solo navegador (usa DOMParser).
 */
export async function readStatementFile(file: File): Promise<Table> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/browser");
    return (await readSheet(file)) as Cell[][];
  }
  if (name.endsWith(".pdf")) {
    throw new Error("Los resúmenes en PDF no se pueden leer con seguridad. Bajalo del homebanking como Excel o CSV (casi todos los bancos lo permiten).");
  }

  const buffer = await file.arrayBuffer();
  const text = decodeFileBytes(buffer);
  if (/<table[\s>]/i.test(text)) return readHtmlTable(text);

  if (name.endsWith(".xls")) {
    const head = new Uint8Array(buffer.slice(0, 4));
    const isBinaryExcel = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
    if (isBinaryExcel) {
      throw new Error('Ese es un Excel viejo (.xls). Abrilo en Excel y guardalo como "Libro de Excel (.xlsx)" o como "CSV" y subilo de nuevo.');
    }
  }
  return parseDelimited(text);
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
