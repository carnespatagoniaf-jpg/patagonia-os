/**
 * Supabase devuelve como máximo 1000 filas por consulta y corta en silencio. Pide todas las páginas hasta que una
 * venga incompleta. `page(from, to)` arma la consulta con `.range(from, to)` (y un orden estable).
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }>,
  pageSize = 1000
): Promise<{ data: T[]; error: { code?: string; message: string } | null }> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { data: all, error };
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) return { data: all, error: null };
  }
}
