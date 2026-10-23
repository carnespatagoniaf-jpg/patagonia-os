// Archivos para importar en el Libro IVA Digital de ARCA (RG 4597).
// Diseño de registros: www.afip.gob.ar/libro-iva-digital/documentos/libro-iva-digital-diseno-registros.pdf
// Especificaciones (revisión 30/07/2025): www.afip.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf
//   - Ventas: CBTE (266 caracteres) + ALICUOTAS (62).
//   - Compras: CBTE (325) + ALICUOTAS (84). Las compras B y C (no discriminan
//     IVA) van con "cantidad de alícuotas" 0 y sin registros de alícuotas.
//   - Importes: 13 enteros + 2 decimales, sin punto; negativo con "-" adelante.
//   - Tipo de cambio: 4 enteros + 6 decimales (PES = 0001000000).
//   - El orden de los registros de alícuotas sigue al de los comprobantes.
//   - Archivos en ANSI (acá: solo ASCII, sin acentos) y fin de línea CRLF.
import { purchaseDiscriminatesVat, saleVatLines, type PurchaseVoucher, type SaleVoucher, type VatLine } from "./accounting-view";

/** Tabla de alícuotas de ARCA. */
export const LID_RATE_CODE: Record<string, number> = { "0": 3, "2.5": 9, "5": 8, "10.5": 4, "21": 5, "27": 6 };

function rateCode(rate: number): string {
  const code = LID_RATE_CODE[String(rate)];
  if (!code) throw new Error(`Alícuota sin código en ARCA: ${rate}%`);
  return String(code).padStart(4, "0");
}

export function lidAmount(n: number): string {
  const c = Math.round(Math.abs(n) * 100);
  return n < 0 ? "-" + String(c).padStart(14, "0") : String(c).padStart(15, "0");
}

export function lidNumber(n: number | string, len: number): string {
  const digits = String(n).replace(/\D/g, "") || "0";
  return digits.slice(-len).padStart(len, "0");
}

/** Texto ANSI seguro: sin acentos ni símbolos raros, en mayúsculas, a la izquierda y con espacios. */
export function lidText(s: string | null | undefined, len: number): string {
  const clean = (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .toUpperCase()
    .trim();
  return clean.slice(0, len).padEnd(len, " ");
}

function lidDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}

const PES = "PES";
const ONE = "0001000000";

export interface LidFiles {
  vouchers: string;
  rates: string;
  /** Cantidad de comprobantes. */
  count: number;
}

function joinLines(lines: string[]): string {
  return lines.length ? lines.join("\r\n") + "\r\n" : "";
}

/** Libro IVA Ventas: los comprobantes autorizados por ARCA del mes. */
export function buildSalesFiles(sales: SaleVoucher[]): LidFiles {
  const cbte: string[] = [];
  const alic: string[] = [];
  for (const s of sales) {
    const lines = saleVatLines(s);
    const finalConsumer = s.docType === 99;
    const line =
      lidDate(s.date) +
      lidNumber(s.voucherType, 3) +
      lidNumber(s.pointOfSale, 5) +
      lidNumber(s.number, 20) +
      lidNumber(s.number, 20) +
      lidNumber(s.docType, 2) +
      lidNumber(finalConsumer ? 0 : s.doc, 20) +
      lidText(s.name || (finalConsumer ? "CONSUMIDOR FINAL" : ""), 30) +
      lidAmount(s.total) +
      lidAmount(0) + // conceptos que no integran el neto gravado
      lidAmount(0) + // percepción a no categorizados
      lidAmount(0) + // exentas
      lidAmount(0) + // percepciones nacionales
      lidAmount(0) + // percepciones IIBB
      lidAmount(0) + // percepciones municipales
      lidAmount(0) + // impuestos internos
      PES +
      ONE +
      String(lines.length) +
      "0" + // código de operación: no corresponde
      lidAmount(0) + // otros tributos
      "00000000"; // vencimiento de pago (solo servicios públicos)
    cbte.push(line);
    for (const l of lines) {
      alic.push(lidNumber(s.voucherType, 3) + lidNumber(s.pointOfSale, 5) + lidNumber(s.number, 20) + lidAmount(l.net) + rateCode(l.rate) + lidAmount(l.vat));
    }
  }
  return { vouchers: joinLines(cbte), rates: joinLines(alic), count: sales.length };
}

/** Libro IVA Compras: los comprobantes de compra del mes. */
export function buildPurchaseFiles(purchases: PurchaseVoucher[]): LidFiles {
  const cbte: string[] = [];
  const alic: string[] = [];
  for (const p of purchases) {
    const discriminates = purchaseDiscriminatesVat(p.voucherType);
    let lines: VatLine[] = discriminates ? p.vatLines.filter((l) => l.net !== 0 || l.vat !== 0) : [];
    let operation = "0";
    // Una A toda exenta o no gravada: una línea al 0% con su código de operación.
    if (discriminates && lines.length === 0) {
      lines = [{ rate: 0, net: 0, vat: 0 }];
      operation = p.exempt > 0 ? "E" : "N";
    }
    const vatTotal = lines.reduce((s, l) => s + Math.round(l.vat * 100), 0) / 100;
    const line =
      lidDate(p.voucherDate) +
      lidNumber(p.voucherType, 3) +
      lidNumber(p.pointOfSale, 5) +
      lidNumber(p.number, 20) +
      " ".repeat(16) + // despacho de importación
      lidNumber(p.sellerDocType, 2) +
      lidNumber(p.sellerDoc, 20) +
      lidText(p.sellerName, 30) +
      lidAmount(p.total) +
      lidAmount(discriminates ? p.noTaxed : 0) +
      lidAmount(discriminates ? p.exempt : 0) +
      lidAmount(p.percVat) +
      lidAmount(p.percNational) +
      lidAmount(p.percIibb) +
      lidAmount(p.percMunicipal) +
      lidAmount(p.internalTaxes) +
      PES +
      ONE +
      String(lines.length) +
      operation +
      lidAmount(discriminates ? vatTotal : 0) + // crédito fiscal computable (sin prorrateo)
      lidAmount(p.otherTaxes) +
      "0".repeat(11) + // CUIT emisor/corredor
      " ".repeat(30) +
      lidAmount(0); // IVA comisión
    cbte.push(line);
    for (const l of lines) {
      alic.push(
        lidNumber(p.voucherType, 3) +
          lidNumber(p.pointOfSale, 5) +
          lidNumber(p.number, 20) +
          lidNumber(p.sellerDocType, 2) +
          lidNumber(p.sellerDoc, 20) +
          lidAmount(l.net) +
          rateCode(l.rate) +
          lidAmount(l.vat)
      );
    }
  }
  return { vouchers: joinLines(cbte), rates: joinLines(alic), count: purchases.length };
}

/** Nombres de archivo como los pide ARCA, con el período. */
export function lidFileNames(period: string): { salesVouchers: string; salesRates: string; purchaseVouchers: string; purchaseRates: string } {
  const p = period.slice(0, 7).replace("-", "");
  return {
    salesVouchers: `LIBRO_IVA_DIGITAL_VENTAS_CBTE_${p}.txt`,
    salesRates: `LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS_${p}.txt`,
    purchaseVouchers: `LIBRO_IVA_DIGITAL_COMPRAS_CBTE_${p}.txt`,
    purchaseRates: `LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS_${p}.txt`
  };
}
