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
    id: "2026-10-reportes-nuevos",
    title: "Nuevo en Reportes: cuánto te quedó, la merma y qué vende cada cajero",
    body:
      "Elegí el período y vas a ver el resultado (lo vendido menos el costo, los gastos y los sueldos), la merma de los conteos y del desposte, " +
      "los productos que más venden y los que no salen, cuánto cobró cada cajero y a qué hora se vende más.",
    page: "reports",
    pageLabel: "Ir a Reportes",
    requires: ["reports.view"],
    until: "2026-11-12"
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
