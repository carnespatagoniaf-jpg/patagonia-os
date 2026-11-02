import type { Page } from "../features/auth/permissions";

/**
 * Para que una pantalla mande a otra sin recibir onPageChange por props (Clientes → "Remito R" → Facturas,
 * 2026-11-02: faltaban datos fiscales y el aviso no decía dónde cargarlos). App.tsx escucha el evento.
 */
export const NAVIGATE_EVENT = "patagonia:navigate";

/** Facturas abre "Datos fiscales del negocio" desplegado la próxima vez que se monta. */
export const OPEN_FISCAL_KEY = "patagonia-open-fiscal-settings";

export function goToPage(page: Page) {
  window.dispatchEvent(new CustomEvent<Page>(NAVIGATE_EVENT, { detail: page }));
}

export function goToFiscalSettings() {
  try {
    sessionStorage.setItem(OPEN_FISCAL_KEY, "1");
  } catch {
    // Sin sessionStorage igual navega; la sección queda cerrada.
  }
  goToPage("invoicing");
}
