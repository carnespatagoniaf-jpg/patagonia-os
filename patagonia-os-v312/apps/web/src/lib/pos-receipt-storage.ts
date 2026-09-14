/** Clave de sessionStorage para el "Último comprobante" de Mostrador (ver
 * features/sale/Sale.tsx). Vive acá, fuera de Sale.tsx, para que
 * AuthProvider pueda limpiarla al cerrar sesión sin importar todo el
 * componente de Mostrador -- si no se limpia, el comprobante de una empresa
 * queda pegado en la pantalla al entrar con otra cuenta en la misma
 * pestaña del navegador (sessionStorage no se borra solo al cambiar de
 * usuario). */
export const POS_LAST_RECEIPT_KEY = "patagonia-pos-last-receipt";

export function clearStoredPosReceipt(): void {
  try {
    sessionStorage.removeItem(POS_LAST_RECEIPT_KEY);
  } catch {
    // sessionStorage lleno o bloqueado -- no es crítico.
  }
}
