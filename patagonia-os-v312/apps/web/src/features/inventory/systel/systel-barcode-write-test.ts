import type { SystelClient } from "./systel-client";
import { LAYOUT_INFO, pluEanSetting, type SystelLayout } from "./systel-plu";
import { backupDigest, buildBarcodeRewrite, compareWithBackup, rewriteProductBarcode, takeProductBackup, verifyBackup, type BarcodeRewriteResult, type ProductBackup, type TypeByteMode } from "./systel-product-barcode";
import { parseSalesReport, salesReportRequest } from "./systel-sales";

/**
 * Prueba de escritura del código de barras de cada producto, en dos etapas. Bloqueada salvo `writes.productBarcode`.
 *
 * Etapa 1, en un número de producto LIBRE (sin historia: no hay precios, ventas ni totales que perder).
 * Resuelve con la balanza real lo que el documento de Systel no dice:
 *   - si la escritura (61) lleva byte de control (el programa de ejemplo OFICIAL de Systel lo manda en todas las
 *     funciones, incluida la de escribir un producto: Form1.vb, Button3_Click);
 *   - si el tipo de código va como byte (como lo devuelve la balanza) o como dígito (como dice el texto).
 * Escribe un producto "PRUEBA PATAGONIA" sin precio, lo relee y lo compara con lo escrito. Antes y después
 * comprueba que los productos del cliente y su reporte de ventas no cambiaron. El producto de prueba queda en la
 * balanza: no se usa ninguna función de borrado.
 *
 * Etapa 2, en UN producto real que no se vendió en la semana (elige el dueño). Hace lo mismo que se haría con los
 * 87: solo cambia el código propio, relee y compara; si cambió otra cosa, restaura. Además controla otra vez que
 * los demás productos y el reporte de ventas sigan iguales.
 *
 * Lo que NO puede comprobar: los totales acumulados por producto de la balanza (no hay función para leerlos en la
 * Cuora Max). Por eso la etapa 2 es sobre un producto sin ventas recientes.
 */

export interface WriteTestStep {
  label: string;
  ok: boolean;
  detail: string;
}

export interface WriteTestReport {
  stage: 1 | 2;
  verdict: "confirmado" | "frenado" | "bloqueado";
  /** Forma del tipo de código que aceptó la balanza (etapa 1). */
  mode: TypeByteMode | null;
  number: number | null;
  steps: WriteTestStep[];
  backup: ProductBackup | null;
  /** Huella del reporte de ventas antes y después (tiene que ser la misma). */
  salesBefore: string | null;
  salesAfter: string | null;
  written: string | null;
  readBack: string | null;
  rewrite?: BarcodeRewriteResult;
}

export const TEST_PRODUCT_NAME = "PRUEBA PATAGONIA  ";
const pad = (s: string, n: number) => s.slice(0, n).padEnd(n, " ");

/** Reporte de ventas de los últimos 40 días (solo lectura): su huella y los productos vendidos. null si no se pudo leer. */
async function salesSnapshot(client: SystelClient, today: Date): Promise<{ hash: string; soldPlus: Set<number> } | null> {
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 40);
  const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const r = await client.salesReportRaw(salesReportRequest(from, to));
  if ("error" in r) return null;
  const parsed = parseSalesReport(r.data);
  return { hash: backupDigest([{ number: 0, raw: r.data }]), soldPlus: new Set(parsed.ok ? parsed.lines.map((l) => l.plu) : []) };
}
const salesFingerprint = async (client: SystelClient, today: Date) => (await salesSnapshot(client, today))?.hash ?? null;

/** Registro de prueba a partir de uno real (misma forma): otro número, nombre de prueba, sin precios, código = número. */
export function testRecordFrom(templateRaw: string, layout: SystelLayout, number: number): string | null {
  const info = LAYOUT_INFO[layout];
  if (layout === "cuora2") return null;
  const pd = info.pluDigits;
  const nameAt = pd + 1;
  const pricesAt = nameAt + 18;
  const priceLen = info.priceLists * (layout === "max7" ? 12 : 6);
  const codeAt = pricesAt + priceLen;
  const code = String(number).padStart(info.codeDigits, "0");
  if (code.length > info.codeDigits) return null;
  return String(number).padStart(pd, "0") + templateRaw[pd] + pad(TEST_PRODUCT_NAME, 18) + "0".repeat(priceLen) + code + templateRaw.slice(codeAt + info.codeDigits);
}

export async function runStage1FreeSlot(
  client: SystelClient,
  layout: SystelLayout,
  opts: { templateNumber: number; protect: number[]; today: Date; candidates?: number[]; onProgress?: (t: string) => void }
): Promise<WriteTestReport> {
  const report: WriteTestReport = { stage: 1, verdict: "frenado", mode: null, number: null, steps: [], backup: null, salesBefore: null, salesAfter: null, written: null, readBack: null };
  const step = (label: string, ok: boolean, detail: string) => {
    report.steps.push({ label, ok, detail });
    opts.onProgress?.(`${ok ? "✓" : "✗"} ${label}: ${detail}`);
    return ok;
  };

  report.salesBefore = await salesFingerprint(client, opts.today);
  if (!step("Reporte de ventas (solo lectura)", !!report.salesBefore, report.salesBefore ? "leído" : "no se pudo leer: no se sigue (no habría cómo comprobar que no cambió)")) return report;

  const numbers = [...new Set([...opts.protect, opts.templateNumber])];
  const { backup, missing } = await takeProductBackup(client, layout, numbers, opts.onProgress);
  report.backup = backup;
  const v = verifyBackup(backup);
  if (!step("Respaldo de los productos (solo lectura)", missing.length === 0 && v.ok, `${backup.records.length} de ${numbers.length}${missing.length ? `; sin leer: ${missing.join(", ")}` : ""} · ${v.detail}`)) return report;

  const template = backup.records.find((r) => r.number === opts.templateNumber)!.raw;
  const max = Math.min(LAYOUT_INFO[layout].maxPlu, 10 ** LAYOUT_INFO[layout].codeDigits - 1);
  const candidates = opts.candidates ?? Array.from({ length: 10 }, (_, i) => Math.min(max, 7999) - i);
  let free: number | null = null;
  for (const n of candidates) {
    const s = await client.readPluStatus(layout, n);
    if ("missing" in s) {
      free = n;
      break;
    }
    if ("error" in s) {
      step(`¿Está libre el N.º ${n}?`, false, `no se pudo saber (${s.error}): no se sigue`);
      return report;
    }
  }
  if (!step("Número de producto libre", free !== null, free !== null ? `N.º ${free} (la balanza contestó "no existe")` : "no hay un número libre entre los candidatos")) return report;
  report.number = free;

  const base = testRecordFrom(template, layout, free!);
  const target = pluEanSetting(template).type !== null ? "20PPPPCCCCCC" : null;
  if (!step("Registro de prueba", !!base && !!target, base ? `"${TEST_PRODUCT_NAME.trim()}", sin precio, código ${free}, código de barras 20PPPPCCCCCC` : "el registro de referencia no tiene la forma esperada")) return report;

  for (const mode of ["binario", "ascii"] as const) {
    const data = buildBarcodeRewrite(base!, layout, target!, mode);
    if (!data) {
      step(`Escritura (tipo ${mode})`, false, "no se pudo armar");
      return report;
    }
    const reply = await client.writePluRaw(layout, free!, data);
    if (reply === "bloqueado") {
      report.verdict = "bloqueado";
      step("Escritura", false, "bloqueada en Patagonia (falta la autorización)");
      return report;
    }
    if (reply && reply.kind === "error" && (reply.errorCode === "E5" || reply.errorCode === "E8")) {
      step(`Escritura (tipo ${mode})`, false, `la balanza la rechazó (${reply.errorCode}); no guardó nada. Se prueba la otra forma`);
      continue;
    }
    const back = await client.readPluStatus(layout, free!);
    if (!("plu" in back)) {
      step(`Relectura del N.º ${free}`, false, "missing" in back ? "no quedó guardado" : back.error);
      return report;
    }
    report.written = data;
    report.readBack = back.plu.raw;
    const pd = LAYOUT_INFO[layout].pluDigits;
    const expected = data.slice(0, pd) + back.plu.raw[pd] + data.slice(pd);
    const sameExceptType = expected.length === back.plu.raw.length && [...expected].every((ch, i) => ch === back.plu.raw[i] || (expected.charCodeAt(i) <= 3 || ch === "1") && back.plu.raw.charCodeAt(i) <= 3);
    const ean = pluEanSetting(back.plu.raw);
    if (!step(`Escritura (tipo ${mode}) y relectura`, sameExceptType && ean.type === 1 && ean.config === target, sameExceptType ? `quedó igual a lo escrito; código ${ean.config}` : "lo releído no es igual a lo escrito")) return report;
    report.mode = mode;
    break;
  }
  if (!report.mode) return report;

  const states = await compareWithBackup(client, backup);
  const changed = states.filter((s) => s.state !== "igual");
  if (!step("Productos del cliente sin cambios", changed.length === 0, changed.length ? `CAMBIARON: ${changed.map((s) => `${s.number} (${s.state})`).join(", ")}` : `los ${states.length} iguales al respaldo`)) return report;
  report.salesAfter = await salesFingerprint(client, opts.today);
  if (!step("Reporte de ventas sin cambios", report.salesAfter === report.salesBefore, report.salesAfter === report.salesBefore ? "igual" : "DISTINTO o no se pudo leer")) return report;
  report.verdict = "confirmado";
  return report;
}

export async function runStage2OneProduct(
  client: SystelClient,
  layout: SystelLayout,
  opts: { number: number; saleType: string; mode: TypeByteMode; protect: number[]; today: Date; onProgress?: (t: string) => void }
): Promise<WriteTestReport> {
  const report: WriteTestReport = { stage: 2, verdict: "frenado", mode: opts.mode, number: opts.number, steps: [], backup: null, salesBefore: null, salesAfter: null, written: null, readBack: null };
  const step = (label: string, ok: boolean, detail: string) => {
    report.steps.push({ label, ok, detail });
    opts.onProgress?.(`${ok ? "✓" : "✗"} ${label}: ${detail}`);
    return ok;
  };
  const snap = await salesSnapshot(client, opts.today);
  report.salesBefore = snap?.hash ?? null;
  if (!step("Reporte de ventas (solo lectura)", !!snap, snap ? "leído" : "no se pudo leer: no se sigue")) return report;
  // Los totales acumulados de la balanza no se pueden leer: el producto de la prueba no puede tener ventas recientes.
  if (!step(`Producto ${opts.number} sin ventas en 40 días`, !snap!.soldPlus.has(opts.number), snap!.soldPlus.has(opts.number) ? "tiene ventas: elegí otro (sus acumulados en la balanza no se pueden leer ni recuperar)" : "sin ventas")) return report;
  const numbers = [...new Set([...opts.protect, opts.number])];
  const { backup, missing } = await takeProductBackup(client, layout, numbers, opts.onProgress);
  report.backup = backup;
  if (!step("Respaldo de los productos (solo lectura)", missing.length === 0 && verifyBackup(backup).ok, `${backup.records.length} de ${numbers.length}`)) return report;
  const r = await rewriteProductBarcode(client, layout, opts.number, opts.saleType, opts.mode);
  report.rewrite = r;
  if (r.verdict === "bloqueado") report.verdict = "bloqueado";
  if (!step(`Producto ${opts.number}: solo el código de barras`, r.ok, `${r.verdict}: ${r.detail}`)) return report;
  const others = (await compareWithBackup(client, backup)).filter((s) => s.number !== opts.number && s.state !== "igual");
  if (!step("Los demás productos sin cambios", others.length === 0, others.length ? `CAMBIARON: ${others.map((s) => s.number).join(", ")}` : "iguales al respaldo")) return report;
  report.salesAfter = await salesFingerprint(client, opts.today);
  if (!step("Reporte de ventas sin cambios", report.salesAfter === report.salesBefore, report.salesAfter === report.salesBefore ? "igual" : "DISTINTO o no se pudo leer")) return report;
  report.verdict = "confirmado";
  return report;
}
