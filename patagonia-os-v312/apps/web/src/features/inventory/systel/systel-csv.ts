import { toCuoraText } from "./systel-frame";

/**
 * Archivos de productos para los importadores oficiales de Systel (sin cable):
 *
 * - Qendra ("Qendra - Importar datos automático Rev 2"): CSV con ";", SIN encabezados,
 *   9 campos: Sección; Código PLU; Descripción; Número de PLU; Precio lista 1;
 *   Precio lista 2; Tipo de venta (PESO/UNIDAD); Vencimiento; Otros datos.
 *   Descripción y sección hasta 18 caracteres, precio con la coma decimal de
 *   Windows (Argentina: ","), sin "$" ni separador de miles, sin "ñ".
 *   Ojo en Qendra: dejar APAGADA la opción de borrar los productos que no estén en el archivo.
 *
 * - Cuora Neo ("Formato archivo CSV para importador Systel Suite Neo", formato 1):
 *   Nombre de sección; Código de PLU; Nombre; Código ERP; Precio lista 1; Precio lista 2;
 *   Tipo de venta; Vencimiento; Campo extra 1. Nombre y sección hasta 56, precio con
 *   2 decimales (punto o coma). La balanza lo baja de un servidor FTP/SFTP.
 */

export interface SystelCsvProduct {
  code: string;
  name: string;
  byWeight: boolean;
  price: number;
  section?: string;
  expiryDays?: number;
}

export interface SystelCsvResult {
  csv: string;
  skipped: { code: string; name: string; reason: string }[];
}

function money(n: number, separator: "," | "."): string {
  return n.toFixed(2).replace(".", separator);
}

function plainText(text: string, width: number): string {
  return toCuoraText(text, width).trimEnd();
}

export function buildQendraCsv(products: SystelCsvProduct[]): SystelCsvResult {
  const skipped: SystelCsvResult["skipped"] = [];
  const rows: string[] = [];
  for (const p of products) {
    const code = p.code.trim();
    const n = /^\d+$/.test(code) ? Number(code) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 8000) {
      // Número de PLU de Qendra: 1 a 8.000 (y Patagonia usa el mismo número como código).
      skipped.push({ code: p.code, name: p.name, reason: "el código tiene que ser un número de 1 a 8000" });
      continue;
    }
    if (!(p.price >= 0) || p.price > 999999) {
      skipped.push({ code: p.code, name: p.name, reason: "precio fuera de rango" });
      continue;
    }
    const section = plainText(p.section || "General", 18) || "General";
    rows.push([section, n, plainText(p.name, 18), n, money(p.price, ","), money(0, ","), p.byWeight ? "PESO" : "UNIDAD", p.expiryDays ?? 0, ""].join(";"));
  }
  return { csv: rows.join("\r\n") + (rows.length ? "\r\n" : ""), skipped };
}

export function buildCuoraNeoCsv(products: SystelCsvProduct[]): SystelCsvResult {
  const skipped: SystelCsvResult["skipped"] = [];
  const rows: string[] = [];
  for (const p of products) {
    const code = p.code.trim();
    if (!/^\d{1,7}$/.test(code) || Number(code) < 1) {
      skipped.push({ code: p.code, name: p.name, reason: "el código tiene que ser un número (hasta 7 dígitos)" });
      continue;
    }
    if (!(p.price >= 0)) {
      skipped.push({ code: p.code, name: p.name, reason: "precio inválido" });
      continue;
    }
    const section = plainText(p.section || "General", 56) || "General";
    rows.push([section, Number(code), plainText(p.name, 56), code, money(p.price, "."), money(0, "."), p.byWeight ? "PESO" : "UNIDAD", p.expiryDays ?? 0, ""].join(";"));
  }
  return { csv: rows.join("\r\n") + (rows.length ? "\r\n" : ""), skipped };
}
