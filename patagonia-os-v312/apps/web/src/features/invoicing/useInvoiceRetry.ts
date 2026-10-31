import { useEffect } from "react";
import { authorizeInvoices, hasPendingInvoices } from "./invoicing-service";

const RETRY_EVERY_MS = 10 * 60_000;

/**
 * Reintento automático de las facturas que quedaron pendientes (ARCA caído o lento al cobrar). Antes solo se
 * reintentaban al abrir la pantalla Facturas: si nadie la abría, la venta quedaba sin factura y, al autorizarse días
 * después, podía caer en otro mes del Libro IVA (auditoría 29/10/2026). Cada 10 minutos, si hay alguna pendiente, se
 * le pide a ARCA. Sin pendientes no se llama a nada (una consulta liviana a la base).
 */
export function useInvoiceRetry(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let running = false;
    async function retry() {
      if (running || !navigator.onLine) return;
      running = true;
      try {
        // Solo las de hace más de 2 minutos: la caja que recién cobró la está pidiendo ella (revisión 30/10).
        if (await hasPendingInvoices()) await authorizeInvoices(undefined, 120);
      } catch {
        // Queda pendiente: se vuelve a probar en el próximo intento.
      } finally {
        running = false;
      }
    }
    const first = window.setTimeout(() => void retry(), 30_000);
    const timer = window.setInterval(() => void retry(), RETRY_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled]);
}
