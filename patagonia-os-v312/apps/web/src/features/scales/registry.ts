import { kretzAuraWeightDriver } from "./drivers/kretz-aura-weight";
import { kretzReportPluDriver } from "./drivers/kretz-report-plu";
import type { ScaleDriver } from "./types";

/**
 * Lista de drivers dados de alta en el Scale Manager. Agregar una marca
 * nueva es: escribir drivers/<algo>.ts que cumpla `ScaleDriver` + agregarlo
 * acá. Ningún otro archivo del sistema (Manager, pantallas, Mostrador,
 * Stock) debe tocarse para eso.
 *
 * Los dos primeros son envolturas del código Kretz ya probado en
 * producción (features/sale/scale-weight.ts y features/inventory/
 * scale-serial.ts) -- ningún protocolo se reescribió para esto.
 */
export const SCALE_DRIVERS: ScaleDriver[] = [kretzAuraWeightDriver, kretzReportPluDriver];

export function getDriverById(id: string): ScaleDriver | undefined {
  return SCALE_DRIVERS.find((d) => d.id === id);
}
