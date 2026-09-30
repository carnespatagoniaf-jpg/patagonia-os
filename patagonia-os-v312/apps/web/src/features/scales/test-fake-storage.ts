/**
 * Stub mínimo de localStorage para los tests de este módulo -- Node no trae
 * un `localStorage` global (a diferencia del navegador), y manager.ts/
 * sync.ts/activity-log.ts lo usan directo. No se usa en la app real, solo
 * en las pruebas (excluidas de tsc, ver tsconfig.json).
 */
export function installFakeLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    }
  } as Storage;
}
