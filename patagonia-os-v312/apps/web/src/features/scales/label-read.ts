import { markScalesSaleTested } from "./registry/branch-scales";
import { markLabelReadLocally } from "./install-status";

/**
 * Mostrador leyó bien una etiqueta de balanza: es el paso 5 de la instalación ("venta probada"). Se anota en esta
 * computadora y, como mucho cada 10 minutos, en la ficha de las balanzas de la sucursal. Nunca frena la venta.
 */
const lastSent = new Map<string, number>();

export function noteLabelRead(branchId: string, detail: string): void {
  markLabelReadLocally(branchId, detail);
  const now = Date.now();
  if (now - (lastSent.get(branchId) ?? 0) < 10 * 60_000) return;
  lastSent.set(branchId, now);
  void markScalesSaleTested(branchId, detail).catch(() => lastSent.delete(branchId));
}
