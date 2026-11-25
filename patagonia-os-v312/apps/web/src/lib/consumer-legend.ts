// Ley 13.987 (Provincia de Buenos Aires): los tickets y facturas a consumidor final llevan, legible, el teléfono
// gratuito de orientación al consumidor. Desde el 21/11/2026 es la Línea 148 (resolución del 22/10/2026; el 0800 de
// 2009 ya no funciona). Sale sola en las empresas con provincia "Buenos Aires" en el panel (companies.province).
// CABA no: es otra jurisdicción.

let companyProvince: string | null = null;

/** La carga AuthProvider al leer el perfil (provincia de la empresa). */
export function setCompanyProvince(province: string | null | undefined): void {
  companyProvince = province?.trim() || null;
}

export function needsPbaConsumerLegend(province: string | null = companyProvince): boolean {
  if (!province) return false;
  const p = province.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.\s]+/g, " ").trim();
  return p === "buenos aires" || p === "provincia de buenos aires" || p === "pba" || p === "bs as";
}

/** Renglones a imprimir al pie (vacío si la empresa no es de la Provincia). */
export function consumerLegendLines(province: string | null = companyProvince): string[] {
  return needsPbaConsumerLegend(province) ? ["Orientación al Consumidor", "Provincia de Buenos Aires: 148", "Línea gratuita"] : [];
}
