import type { SystelClient } from "./systel-client";
import { LAYOUT_INFO, pluEanSetting, type SystelLayout } from "./systel-plu";
import { backupDigest, buildBarcodeRewrite, compareWithBackup, onlyBarcodeChanged, rewriteProductBarcode, takeProductBackup, verifyBackup, type BarcodeRewriteResult, type ProductBackup, type TypeByteMode } from "./systel-product-barcode";
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
  /** Producto de prueba por unidad (etapa 1). */
  unitNumber?: number;
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

/**
 * Registro de prueba a partir de uno real (misma forma): otro número, nombre de prueba, código = número y precio
 * de lista 1 = $1 (para poder pesarlo e imprimir un ticket de prueba; $1 nunca se confunde con un precio real).
 */
export function testRecordFrom(templateRaw: string, layout: SystelLayout, number: number, priceRaw = 1): string | null {
  const info = LAYOUT_INFO[layout];
  if (layout === "cuora2") return null;
  const pd = info.pluDigits;
  const nameAt = pd + 1;
  const pricesAt = nameAt + 18;
  const each = layout === "max7" ? 12 : 6;
  const priceLen = info.priceLists * each;
  const codeAt = pricesAt + priceLen;
  const code = String(number).padStart(info.codeDigits, "0");
  if (code.length > info.codeDigits) return null;
  const prices = String(priceRaw).padStart(6, "0") + "0".repeat(priceLen - 6);
  return String(number).padStart(pd, "0") + templateRaw[pd] + pad(TEST_PRODUCT_NAME, 18) + prices + code + templateRaw.slice(codeAt + info.codeDigits);
}

/** Escribe un producto de prueba en un número libre y lo relee. Prueba las formas del tipo de código en orden. */
async function writeTestProduct(
  client: SystelClient,
  layout: SystelLayout,
  number: number,
  base: string,
  target: string,
  modes: TypeByteMode[],
  step: (label: string, ok: boolean, detail: string) => boolean
): Promise<{ mode: TypeByteMode; written: string; readBack: string } | "bloqueado" | null> {
  for (const mode of modes) {
    const data = buildBarcodeRewrite(base, layout, target, mode);
    if (!data) {
      step(`Escritura del N.º ${number} (tipo ${mode})`, false, "no se pudo armar");
      return null;
    }
    // Justo antes de escribir, otra vez: ¿sigue sin existir?
    const still = await client.readPluStatus(layout, number);
    if (!("missing" in still)) {
      step(`N.º ${number} libre justo antes de escribir`, false, "plu" in still ? "ya existe: no se escribe" : still.error);
      return null;
    }
    const reply = await client.writePluRaw(layout, number, data);
    if (reply === "bloqueado") {
      step("Escritura", false, "bloqueada en Patagonia (falta la autorización)");
      return "bloqueado";
    }
    if (reply && reply.kind === "error" && (reply.errorCode === "E5" || reply.errorCode === "E8")) {
      step(`Escritura del N.º ${number} (tipo ${mode})`, false, `la balanza la rechazó (${reply.errorCode}); no guardó nada${modes.length > 1 ? ". Se prueba la otra forma" : ""}`);
      continue;
    }
    const back = await client.readPluStatus(layout, number);
    if (!("plu" in back)) {
      step(`Relectura del N.º ${number}`, false, "missing" in back ? "no quedó guardado" : back.error);
      return null;
    }
    const pd = LAYOUT_INFO[layout].pluDigits;
    const expected = data.slice(0, pd) + back.plu.raw[pd] + data.slice(pd);
    const sameExceptType = expected.length === back.plu.raw.length && [...expected].every((ch, i) => ch === back.plu.raw[i] || ((expected.charCodeAt(i) <= 3 || ch === "1") && back.plu.raw.charCodeAt(i) <= 3));
    const ean = pluEanSetting(back.plu.raw);
    if (!step(`Escritura del N.º ${number} (tipo ${mode}) y relectura`, sameExceptType && ean.type === 1 && ean.config === target, sameExceptType ? `quedó igual a lo escrito; código ${ean.config}` : "lo releído no es igual a lo escrito")) return null;
    return { mode, written: data, readBack: back.plu.raw };
  }
  return null;
}

export async function runStage1FreeSlot(
  client: SystelClient,
  layout: SystelLayout,
  opts: { templateNumber: number; unitTemplateNumber?: number; protect: number[]; today: Date; candidates?: number[]; onProgress?: (t: string) => void }
): Promise<WriteTestReport> {
  const report: WriteTestReport = { stage: 1, verdict: "frenado", mode: null, number: null, steps: [], backup: null, salesBefore: null, salesAfter: null, written: null, readBack: null };
  const step = (label: string, ok: boolean, detail: string) => {
    report.steps.push({ label, ok, detail });
    opts.onProgress?.(`${ok ? "✓" : "✗"} ${label}: ${detail}`);
    return ok;
  };

  report.salesBefore = await salesFingerprint(client, opts.today);
  if (!step("Reporte de ventas (solo lectura)", !!report.salesBefore, report.salesBefore ? "leído" : "no se pudo leer: no se sigue (no habría cómo comprobar que no cambió)")) return report;

  const numbers = [...new Set([...opts.protect, opts.templateNumber, ...(opts.unitTemplateNumber !== undefined ? [opts.unitTemplateNumber] : [])])];
  const { backup, missing } = await takeProductBackup(client, layout, numbers, opts.onProgress);
  report.backup = backup;
  const v = verifyBackup(backup);
  if (!step("Respaldo de los productos (solo lectura)", missing.length === 0 && v.ok, `${backup.records.length} de ${numbers.length}${missing.length ? `; sin leer: ${missing.join(", ")}` : ""} · ${v.detail}`)) return report;

  const max = Math.min(LAYOUT_INFO[layout].maxPlu, 10 ** LAYOUT_INFO[layout].codeDigits - 1);
  const candidates = opts.candidates ?? Array.from({ length: 10 }, (_, i) => Math.min(max, 7999) - i);
  const free: number[] = [];
  const wanted = opts.unitTemplateNumber !== undefined ? 2 : 1;
  for (const n of candidates) {
    if (free.length === wanted) break;
    const s = await client.readPluStatus(layout, n);
    if ("missing" in s) free.push(n);
    else if ("error" in s) {
      step(`¿Está libre el N.º ${n}?`, false, `no se pudo saber (${s.error}): no se sigue`);
      return report;
    }
  }
  if (!step("Números de producto libres", free.length === wanted, free.length === wanted ? `N.º ${free.join(" y ")} (la balanza contestó "no existe")` : "no hay suficientes números libres entre los candidatos")) return report;

  // Pesable: prueba las dos formas del tipo de código.
  const template = backup.records.find((r) => r.number === opts.templateNumber)!.raw;
  const base = testRecordFrom(template, layout, free[0]);
  if (!step("Producto de prueba por peso", !!base && pluEanSetting(template).type !== null, `"${TEST_PRODUCT_NAME.trim()}", $1 el kg, código ${free[0]}, código de barras 20PPPPCCCCCC`)) return report;
  const w = await writeTestProduct(client, layout, free[0], base!, "20PPPPCCCCCC", ["binario", "ascii"], step);
  if (w === "bloqueado") {
    report.verdict = "bloqueado";
    return report;
  }
  if (!w) return report;
  report.number = free[0];
  report.mode = w.mode;
  report.written = w.written;
  report.readBack = w.readBack;

  // Por unidad: con la forma que ya aceptó.
  if (opts.unitTemplateNumber !== undefined) {
    const ut = backup.records.find((r) => r.number === opts.unitTemplateNumber)!.raw;
    const ub = testRecordFrom(ut, layout, free[1]);
    if (!step("Producto de prueba por unidad", !!ub && pluEanSetting(ut).type !== null, `"${TEST_PRODUCT_NAME.trim()}", $1 la unidad, código ${free[1]}, código de barras 21PPPPCCCCCC`)) return report;
    const u = await writeTestProduct(client, layout, free[1], ub!, "21PPPPCCCCCC", [w.mode], step);
    if (!u || u === "bloqueado") return report;
    report.unitNumber = free[1];
  }

  const states = await compareWithBackup(client, backup);
  const changed = states.filter((s) => s.state !== "igual");
  if (!step("Productos del cliente sin cambios", changed.length === 0, changed.length ? `CAMBIARON: ${changed.map((s) => `${s.number} (${s.state})`).join(", ")}` : `los ${states.length} iguales al respaldo`)) return report;
  report.salesAfter = await salesFingerprint(client, opts.today);
  if (!step("Reporte de ventas sin cambios", report.salesAfter === report.salesBefore, report.salesAfter === report.salesBefore ? "igual" : "DISTINTO o no se pudo leer")) return report;
  report.verdict = "confirmado";
  return report;
}

/**
 * Prueba 1b, solo sobre un producto de prueba ("PRUEBA PATAGONIA"): lo reescribe igual que se haría con un producto
 * real. Si antes se vendió (ticket de prueba) y se miró su total en el menú de la balanza, comparando ese total antes y
 * después se sabe si la escritura pone en cero los acumulados, sin arriesgar ningún producto del cliente.
 */
export async function runTestProductRewrite(client: SystelClient, layout: SystelLayout, opts: { number: number; mode: TypeByteMode; protect: number[]; onProgress?: (t: string) => void }): Promise<WriteTestReport> {
  const report: WriteTestReport = { stage: 1, verdict: "frenado", mode: opts.mode, number: opts.number, steps: [], backup: null, salesBefore: null, salesAfter: null, written: null, readBack: null };
  const step = (label: string, ok: boolean, detail: string) => {
    report.steps.push({ label, ok, detail });
    opts.onProgress?.(`${ok ? "✓" : "✗"} ${label}: ${detail}`);
    return ok;
  };
  const cur = await client.readPluStatus(layout, opts.number);
  if (!("plu" in cur)) {
    step(`Producto ${opts.number}`, false, "no se pudo leer");
    return report;
  }
  const isTest = cur.plu.name === pad(TEST_PRODUCT_NAME, 18);
  if (!step(`El ${opts.number} es un producto de prueba`, isTest, isTest ? `"${cur.plu.name.trim()}"` : `es "${cur.plu.name.trim()}": no se toca`)) return report;
  const { backup } = await takeProductBackup(client, layout, opts.protect, opts.onProgress);
  report.backup = backup;
  const config = pluEanSetting(cur.plu.raw).config;
  const data = config ? buildBarcodeRewrite(cur.plu.raw, layout, config, opts.mode) : null;
  if (!step("Reescritura armada", !!data, data ? `mismo contenido, código ${config}` : "no se pudo armar")) return report;
  const reply = await client.writePluRaw(layout, opts.number, data!);
  if (reply === "bloqueado") {
    report.verdict = "bloqueado";
    step("Escritura", false, "bloqueada en Patagonia");
    return report;
  }
  const back = await client.readPluStatus(layout, opts.number);
  const same = "plu" in back && onlyBarcodeChanged(cur.plu.raw, back.plu.raw, layout) && pluEanSetting(back.plu.raw).config === config;
  if (!step("Reescrito y releído", !!reply && reply.kind === "ack" && same, same ? "igual" : "distinto o sin confirmar")) return report;
  const changed = (await compareWithBackup(client, backup)).filter((s) => s.state !== "igual");
  if (!step("Productos del cliente sin cambios", changed.length === 0, changed.length ? `CAMBIARON: ${changed.map((s) => s.number).join(", ")}` : "iguales")) return report;
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
