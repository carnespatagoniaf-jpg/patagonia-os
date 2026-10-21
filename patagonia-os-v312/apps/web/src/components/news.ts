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

export const NEWS: NewsItem[] = [];

/** Novedades que esta persona tiene que ver hoy. */
export function visibleNews(
  news: NewsItem[],
  has: (permission: string) => boolean,
  dismissed: string[],
  todayIso: string
): NewsItem[] {
  return news.filter((n) => todayIso <= n.until && !dismissed.includes(n.id) && n.requires.every(has));
}
