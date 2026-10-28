/**
 * ¿Se está usando Patagonia desde un celular o una tablet? REAL (Pollería Giuseppe, 27/10): una tablet Samsung con
 * Chrome abrió la lista de cables y dijo "No se han podido encontrar dispositivos compatibles". Chrome en Android
 * muestra solo dispositivos Bluetooth, nunca un cable USB de balanza; en iPhone/iPad no hay conexión por cable.
 * Solo sirve para avisar: no se bloquea nada (una Kretz Report LT por Bluetooth podría aparecer igual).
 */

export interface DeviceHints {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean } | null;
}

export function isPhoneOrTablet(nav: DeviceHints | null | undefined = typeof navigator !== "undefined" ? (navigator as DeviceHints) : null): boolean {
  if (!nav) return false;
  if (nav.userAgentData?.mobile) return true;
  const ua = nav.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // iPadOS se presenta como una Mac: se lo reconoce por la pantalla táctil.
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export const PHONE_OR_TABLET_MESSAGE =
  "Estás en un celular o una tablet. La balanza se conecta por el cable USB solo desde una computadora (Windows) con Google Chrome o Microsoft Edge. Abrí Patagonia en la computadora que está al lado de la balanza.";
