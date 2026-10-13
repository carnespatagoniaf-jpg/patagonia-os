import type { ScaleConfig } from "./scale-barcode";

/**
 * Etiquetas REALES de balanza escaneadas en el local de Carnes Patagonia (balanza Kretz), tal cual
 * las leyó el lector, con el producto y el peso que el sistema les asignó. Fuente: tabla
 * scale_ticket_voids de producción (tickets anulados, 2026-09-30 a 2026-10-12), las 29 que hay.
 * Solo para pruebas. No inventar ni "corregir" valores acá.
 */
export const CARNES_PATAGONIA_CONFIG: ScaleConfig = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };

/** [código escaneado, N.º de producto, kilos] */
export const CARNES_PATAGONIA_LABELS: [string, string, number][] = [
  ["2000001007969", "1", 0.796], ["2000001012604", "1", 1.26], ["2000001019665", "1", 1.966], ["2000001061053", "1", 6.105],
  ["2000002009429", "2", 0.942], ["2000003003006", "3", 0.3], ["2000005020766", "5", 2.076], ["2000011005948", "11", 0.594],
  ["2000012008627", "12", 0.862], ["2000012030789", "12", 3.078], ["2000013010568", "13", 1.056], ["2000021005044", "21", 0.504],
  ["2000021064652", "21", 6.465], ["2000022019361", "22", 1.936], ["2000026010784", "26", 1.078], ["2000026019664", "26", 1.966],
  ["2000030006766", "30", 0.676], ["2000030011944", "30", 1.194], ["2000035011987", "35", 1.198], ["2000035020767", "35", 2.076],
  ["2000101029540", "101", 2.954], ["2000102008261", "102", 0.826], ["2000201013401", "201", 1.34], ["2000208010168", "208", 1.016],
  ["2000210007507", "210", 0.75], ["2000504005127", "504", 0.512], ["2000504011722", "504", 1.172], ["2000901021423", "901", 2.142],
  ["2000901029061", "901", 2.906]
];

/** Ticket de TOTAL real de la Systel de Los gringos (foto del 2026-10-13): TOTAL $780. */
export const LOS_GRINGOS_TOTAL_TICKET: [string, number] = ["2220000007801", 780];

/**
 * Formato de etiqueta por producto que tiene configurado la Systel de Los gringos (leído de la
 * balanza el 2026-10-09): "E_P=20PPPPCCCCCC" (por kilo) y "E_U=21PPPPCCCCCC" (por unidad):
 * 2 dígitos fijos + N.º de producto (4) + cantidad (6) + verificador. Hoy la balanza NO imprime
 * esa etiqueta en el ticket ("ETi=N"): no hay ninguna real todavía.
 */
export const LOS_GRINGOS_LABEL_CONFIG: ScaleConfig = { prefixLength: 2, pluLength: 4, weightLength: 6, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };
