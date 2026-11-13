import { parsePluAs, type SystelPlu } from "../../../inventory/systel/systel-plu";

/**
 * Balanza Systel SIN NINGÚN producto: Patagonia arma cada producto nuevo copiando uno que la balanza ya tiene
 * (desiredRead en systel-push.ts), y además reconoce el formato leyendo uno. Con la balanza vacía no tenía de dónde
 * copiar: el plan quedaba vacío y la pantalla decía "ya tiene los mismos productos" (real Los gringos, 13/11/2026:
 * borraron todos los productos a mano y al sincronizar no pasó ninguno).
 *
 * Para la Cuora Max comprobada (firma 0060, formato max60) se usan como modelo dos registros REALES de esa misma
 * balanza (respaldo de Los gringos del 14/10, los mismos de engine.test.ts): uno por kilo y uno por unidad. Al crear
 * cada producto se cambian número, nombre, precios, código, forma de venta, tara y vencimiento, y se relee y compara
 * igual que siempre. Para cualquier otra firma no se inventa nada: se pide cargar un producto a mano.
 */
const Z = "0".repeat(56);
const T1 = "\u0001";
const MAX60_TEMPLATES = [
  `00040POLLO ENTEROxKG   00520000000000004010000P00000000N                              ${Z}${T1}000000000000N`,
  `00010ALPINA CAJON DE   08200007800000001010000U00000000N                              ${Z}${T1}000000000000N`
];

/** Modelos para una balanza vacía, o null si su firma no es una comprobada. */
export function emptyScaleTemplates(protocolVersion: string | undefined | null): { layout: "max60"; plus: SystelPlu[] } | null {
  // La misma firma que SYSTEL_VERIFIED (systel.ts); acá escrita para no importar systel.ts y armar un ciclo.
  if (protocolVersion !== "0060") return null;
  const plus = MAX60_TEMPLATES.map((raw) => parsePluAs("max60", raw)).filter((p): p is SystelPlu => p !== null);
  return plus.length === MAX60_TEMPLATES.length ? { layout: "max60", plus } : null;
}

export const EMPTY_SCALE_MESSAGE =
  "Tu balanza no tiene ningún producto cargado y Patagonia necesita al menos uno para saber cómo armar los demás. Cargá un producto a mano en la balanza (cualquiera, con un número que no uses en Patagonia, por ejemplo el 9000) y tocá \"Conectar balanza\" otra vez.";
