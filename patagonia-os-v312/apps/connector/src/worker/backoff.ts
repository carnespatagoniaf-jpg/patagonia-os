// Espera creciente entre reintentos de conexión: 1, 2, 5, 10 y después 30 s.

export const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000];

export function backoffDelay(attempt: number, schedule: readonly number[] = DEFAULT_BACKOFF_MS): number {
  if (schedule.length === 0) return 0;
  const index = Math.min(Math.max(0, Math.floor(attempt)), schedule.length - 1);
  return schedule[index];
}
