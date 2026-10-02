/**
 * Código de barras de los tickets de la Kretz Aura (EAN-13). No se usa en la
 * app todavía: es la base para que Mostrador entienda estos tickets.
 *
 * Fuentes:
 * - Manual Aura Eco (§7.1.6 Código Suma, §7.1.7 Código de Barras). Formatos
 *   1-4-7, 1-5-6, 1-6-5, 2-3-7, 2-4-6 y 2-5-5 = dígitos de inicio, código y
 *   valor. Ini_P / Ini_U = dígitos de inicio de pesables / unitarios.
 *   PESO / Unid = si el valor es el peso/unidades (SI) o el importe (NO).
 * - Multiprotocolo Report Nx §4.17 (comando 1070): los mismos 5 datos.
 *   §4.18 (comando 1080): "código de barras INDIVIDUAL por PLU en un tiquet de
 *   SUMA" (no figura en el menú de la Aura; no se sabe si la Aura lo acepta).
 * - Real: los dos tickets de la clienta (T.0029 con $1394 y T.0030 con $1130)
 *   traen el mismo código, 2099998000008. Leído como 2-5-5 da inicio "20",
 *   código "99998" (el código suma) y valor "00000": no trae importe.
 * - Terceros (yoreparo.com, otra Aura): "20999810208"; "el 9998 sería código
 *   de producto, ahí siempre me sale el mismo" y "el código del precio está
 *   bien". Mismo código suma fijo, pero ese ticket SÍ traía el importe.
 */

export type AuraBarcodeFormat = "1-4-7" | "1-5-6" | "1-6-5" | "2-3-7" | "2-4-6" | "2-5-5";

export interface AuraBarcodeConfig {
  format: AuraBarcodeFormat;
  /** Código suma configurado en la balanza (menú Código Suma). */
  sumCode: number;
  /** Para pasar el valor a pesos (100 si el importe viene con 2 decimales). Se calibra con un ticket real. */
  amountDivisor: number;
}

export type AuraBarcodeResult =
  | { kind: "suma"; prefix: string; amount: number | null }
  | { kind: "producto"; prefix: string; code: number; value: number }
  | null;

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const sum = d.slice(0, 12).reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}

export function parseAuraBarcode(code: string, config: AuraBarcodeConfig): AuraBarcodeResult {
  if (!isValidEan13(code)) return null;
  const [p, c, v] = config.format.split("-").map(Number);
  if (p + c + v !== 12) return null;
  const prefix = code.slice(0, p);
  const codePart = Number(code.slice(p, p + c));
  const value = Number(code.slice(p + c, 12));
  if (codePart === config.sumCode % 10 ** c) {
    // Ticket de suma: sin importe (valor 0) no sirve para cargar la venta.
    return { kind: "suma", prefix, amount: value > 0 ? value / config.amountDivisor : null };
  }
  return { kind: "producto", prefix, code: codePart, value };
}
