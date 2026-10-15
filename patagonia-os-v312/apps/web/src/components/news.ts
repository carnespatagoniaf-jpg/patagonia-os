/**
 * Novedades: un cartel arriba de la pantalla para avisarles a los clientes de una mejora nueva, sin mandar mensajes.
 * Lógica pura (testeada). Para agregar una novedad: sumar un elemento a NEWS con un id nuevo.
 * - Solo la ve quien tiene TODOS los permisos de `requires` (y el plan de esos permisos).
 * - Se muestra hasta `until` (fecha AAAA-MM-DD incluida) o hasta que la persona toca "Entendido".
 */
export interface NewsItem {
  id: string;
  title: string;
  body: string;
  /** Página a la que lleva el botón (opcional). */
  page?: string;
  pageLabel?: string;
  requires: string[];
  until: string;
}

export const NEWS: NewsItem[] = [
  {
    id: "2026-10-compras-para-despostar",
    title: "Nuevo: la factura del proveedor se carga una sola vez, en Compras",
    body:
      "Si el proveedor te trae en la misma factura cosas para vender tal cual (pan rallado, bondiola) y cosas para despostar " +
      "(cajones de pollo, media res, capón), cargá todo junto en Compras y tildá \"Para despostar\" en esa línea. " +
      "La deuda queda una sola vez y la res aparece sola en Despiece; con plantilla de cortes, ya repartida y en el stock. " +
      "Despiece queda para ver cuánto rindió y cuánto costó cada corte: ya no genera deuda con el proveedor.",
    page: "purchases",
    pageLabel: "Ir a Compras",
    requires: ["purchases.manage", "carcass.manage"],
    until: "2026-11-15"
  }
];

/** Novedades que esta persona tiene que ver hoy. */
export function visibleNews(
  news: NewsItem[],
  has: (permission: string) => boolean,
  dismissed: string[],
  todayIso: string
): NewsItem[] {
  return news.filter((n) => todayIso <= n.until && !dismissed.includes(n.id) && n.requires.every(has));
}
