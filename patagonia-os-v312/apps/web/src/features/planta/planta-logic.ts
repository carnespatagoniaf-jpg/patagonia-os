// Planta (migración 194, plan Planta): lógica pura de los paquetes con código. Sin Supabase, para poder probarla.

export type PackageStatus = "en_planta" | "en_viaje" | "en_local" | "vendido" | "anulado";

export interface PlantaPackage {
  id: string;
  number: number;
  code: string;
  productId: string;
  originBranchId: string;
  branchId: string;
  carcassBatchId: string | null;
  quantity: number;
  packedOn: string;
  expiresOn: string | null;
  status: PackageStatus;
  transferId: string | null;
  posSaleId: string | null;
  soldAt: string | null;
  voidReason: string | null;
}

export const STATUS_LABELS: Record<PackageStatus, string> = {
  en_planta: "En la planta",
  en_viaje: "En viaje",
  en_local: "En el local",
  vendido: "Vendido",
  anulado: "Anulado"
};

/** El código de un paquete: PQ + 8 dígitos (correlativo por empresa, lo da la base). */
const PACKAGE_CODE = /^PQ\d{8}$/;

/** Lo que manda la pistola, en mayúsculas y sin espacios (algunas mandan el "*" de inicio y fin del Code 39). */
export function normalizePackageCode(raw: string): string {
  return raw.trim().replace(/^\*+|\*+$/g, "").toUpperCase();
}

export function isPackageCode(raw: string): boolean {
  return PACKAGE_CODE.test(normalizePackageCode(raw));
}

/**
 * Los pesos que se escriben al envasar: uno por paquete, separados por enter, espacio o punto y coma. Acepta coma
 * decimal ("0,850"). Devuelve los pesos válidos y lo que no se entendió, para avisar en vez de adivinar.
 */
export function parseQuantities(text: string): { quantities: number[]; invalid: string[] } {
  const quantities: number[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s;]+/)) {
    if (!token) continue;
    const value = Number(token.replace(",", "."));
    if (!/^\d+([.,]\d+)?$/.test(token) || !(value > 0)) invalid.push(token);
    else quantities.push(Math.round(value * 1000) / 1000);
  }
  return { quantities, invalid };
}

/** Kilos (o unidades) por producto de un grupo de paquetes, como sale en el remito del envío. */
export function totalsByProduct(packages: Pick<PlantaPackage, "productId" | "quantity">[]): Map<string, { count: number; quantity: number }> {
  const out = new Map<string, { count: number; quantity: number }>();
  for (const p of packages) {
    const row = out.get(p.productId) ?? { count: 0, quantity: 0 };
    row.count += 1;
    row.quantity = Math.round((row.quantity + p.quantity) * 1000) / 1000;
    out.set(p.productId, row);
  }
  return out;
}

/** Fecha (YYYY-MM-DD) dentro de N días desde una fecha dada, para "vence en N días". */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Días que le faltan para vencer (negativo = vencido). Null si no tiene vencimiento. */
export function daysToExpire(expiresOn: string | null, todayIso: string): number | null {
  if (!expiresOn) return null;
  return Math.round((Date.parse(`${expiresOn}T12:00:00Z`) - Date.parse(`${todayIso}T12:00:00Z`)) / 86_400_000);
}

/** Lo que vale el paquete al precio de hoy (pesos enteros, como cobra Mostrador). */
export function packagePrice(quantity: number, unitPrice: number): number {
  return Math.round(quantity * unitPrice);
}

/**
 * Agregar un código escaneado a la lista de un envío. Devuelve por qué no se agrega (repetido, no existe, no está en
 * este local) o null si se agrega.
 */
export function shipScanProblem(code: string, scanned: string[], pkg: PlantaPackage | undefined, fromBranchId: string): string | null {
  if (scanned.includes(code)) return `El paquete ${code} ya está en la lista.`;
  if (!pkg) return `El paquete ${code} no existe.`;
  if (pkg.status !== "en_planta" || pkg.branchId !== fromBranchId) return `El paquete ${code} está ${STATUS_LABELS[pkg.status].toLowerCase()}: no se puede mandar desde acá.`;
  return null;
}

/** Al cobrar en Mostrador: por qué no se puede agregar el paquete escaneado (o null si se puede). */
export function saleScanProblem(pkg: Pick<PlantaPackage, "code" | "status"> | undefined): string | null {
  if (!pkg) return "Ese paquete no está en el sistema. Buscá el producto y cargalo a mano.";
  if (pkg.status === "vendido") return `El paquete ${pkg.code} ya se cobró. Si es un error, cargá el producto a mano.`;
  if (pkg.status === "anulado") return `El paquete ${pkg.code} está anulado. Cargá el producto a mano y avisá a la planta.`;
  return null;
}

// Code 39 (lo leen todas las pistolas sin configurar nada): 9 elementos por carácter, barra/espacio alternados,
// n = angosto y w = ancho. Solo los caracteres que usan los códigos de paquete.
export const CODE39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw",
  "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  P: "nnwnwnnwn", Q: "nnnnnnwww", "*": "nwnnwnwnn"
};

/** Barras del código (x y ancho de cada barra, en módulos) y el ancho total. */
export function code39Bars(code: string): { bars: { x: number; w: number }[]; width: number } {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of `*${code}*`) {
    const pattern = CODE39[ch];
    if (!pattern) throw new Error(`El carácter "${ch}" no va en un código de paquete`);
    for (let i = 0; i < pattern.length; i++) {
      const w = pattern[i] === "w" ? 3 : 1;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
    x += 1; // espacio entre caracteres
  }
  return { bars, width: x - 1 };
}
