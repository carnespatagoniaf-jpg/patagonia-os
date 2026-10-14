import type { Product } from "@patagonia/domain";
import { PLUS_BALANZA, PRECIOS_BALANZA } from "../../inventory/systel/systel-real-los-gringos";
import { REPORTE_SEMANA_07_13 } from "../../inventory/systel/systel-real-report-semana";
import type { ScaleCatalogItem, ScaleLink, ScaleSaleProfile, ScaleSaleType } from "./profile";

/**
 * Datos REALES de Los gringos armados como perfil de venta, solo para pruebas.
 *
 * Origen:
 * - catálogo: 103 registros 62 del 14/10;
 * - formatos: configuración 39 del 14/10;
 * - ventas: reporte 72 del 07 al 13/10.
 *
 * Supuestos marcados:
 * - el PLU 201 no se leyó nunca: va con nombre de prueba, unitario a $500 (lo que cobró las 40 veces);
 * - 8001/8002 son los genéricos (venta libre).
 */

const prices = new Map(PRECIOS_BALANZA.split(";").map((r) => r.split("|")).map((r) => [Number(r[0]), [Number(r[1]), Number(r[2])]]));

export function realCatalog(): ScaleCatalogItem[] {
  const items: ScaleCatalogItem[] = PLUS_BALANZA.split(";").map((r) => {
    const [code, type, name, eanType, eanConfig] = r.split("|");
    return { code: Number(code), name, saleType: type as ScaleSaleType, prices: prices.get(Number(code)) ?? [0, 0], eanType: Number(eanType), eanConfig };
  });
  items.push({ code: 201, name: "PRUEBA PLU 201", saleType: "U", prices: [500, 0], eanType: 1, eanConfig: "000000000000" });
  return items;
}

/** Perfil REAL de hoy (14/10): 87 productos con código propio en ceros y formato general con 4 cifras de cantidad. */
export function realProfileToday(): ScaleSaleProfile {
  return { scaleKey: "systel-20", brand: "systel", weighedFormat: "20PPPPCCCCII", unitFormat: "21PPPPCCCCII", totalFormat: "22AAIIIIIIII", amountDecimals: 0, genericCodes: [8001, 8002], catalog: realCatalog() };
}

/** Perfil que hace falta: cada producto con su código propio "20PPPPCCCCCC" (peso) o "21PPPPCCCCCC" (unidad). */
export function targetProfile(): ScaleSaleProfile {
  const p = realProfileToday();
  return {
    ...p,
    catalog: p.catalog.map((i) => ({ ...i, eanType: 1, eanConfig: i.saleType === "U" ? "21PPPPCCCCCC" : "20PPPPCCCCCC" }))
  };
}

/** Productos espejo de Patagonia (uno por producto de la balanza) y sus vínculos. */
export function mirrorProducts(catalog: ScaleCatalogItem[]): Product[] {
  return catalog.map((i) => ({ id: `p-${i.code}`, code: String(9000 + i.code), name: `PRUEBA ${i.name.trim()}`, unit: i.saleType === "U" ? "unit" : "kg", cost: 0, priceRetail: 0, stock: 0, minStock: 0, active: true }));
}

export function mirrorLinks(catalog: ScaleCatalogItem[]): ScaleLink[] {
  return catalog.map((i) => ({ code: i.code, kind: "product" as const, productId: `p-${i.code}` }));
}

export interface RealLine {
  plu: number;
  units: number;
  grams: number;
  /** Pesos (el reporte trae × 100). */
  amount: number;
}
export interface RealTicket {
  key: string;
  number: number;
  date: string;
  time: string;
  seller: number;
  lines: RealLine[];
}

export function realTickets(): RealTicket[] {
  const map = new Map<string, RealTicket>();
  for (const rec of REPORTE_SEMANA_07_13.split(";")) {
    const f = rec.split("^");
    const key = `${f[1]}#${f[0]}`;
    if (!map.has(key)) map.set(key, { key, number: Number(f[0]), date: f[1], time: f[2], seller: Number(f[3]), lines: [] });
    map.get(key)!.lines.push({ plu: Number(f[4]), units: Number(f[6]), grams: Number(f[7]), amount: Number(f[9]) / 100 });
  }
  // El reporte viene del más nuevo al más viejo y, dentro del ticket, del último artículo al primero.
  return [...map.values()].map((t) => ({ ...t, lines: t.lines.reverse() })).reverse();
}
