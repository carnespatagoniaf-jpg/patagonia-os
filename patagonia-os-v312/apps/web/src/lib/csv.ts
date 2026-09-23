function escapeCsvCell(value: string | number): string {
  let text = String(value);
  // Un texto que empieza con = + - @ lo interpreta Excel como fórmula (un nombre
  // o nota cargado a propósito podría ejecutar algo al abrir el archivo). Se le
  // antepone un apóstrofe; los números reales (incluso negativos) no se tocan.
  if (typeof value === "string" && text !== "-" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Excel en español interpreta CSV con `;` como separador por defecto, no
 * `,` -- si no, todo cae en una sola columna al abrirlo. */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(";"));
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
