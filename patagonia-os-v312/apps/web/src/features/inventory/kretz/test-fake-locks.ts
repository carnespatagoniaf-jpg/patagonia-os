/**
 * Solo para pruebas: un administrador de candados en memoria con el comportamiento de la Web Locks API de Chrome
 * (`navigator.locks`), para no depender de la versión de Node (Node 22, el del CI, no lo trae).
 * - uno a la vez por nombre, en orden de llegada;
 * - `ifAvailable`: si está tomado, el callback recibe null enseguida;
 * - `signal`: si se aborta mientras espera, la promesa se rechaza con AbortError y no se toma.
 */
type Callback = (lock: { name: string } | null) => unknown;
interface Options {
  ifAvailable?: boolean;
  signal?: AbortSignal;
}

export function fakeLockManager() {
  const busy = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();

  const take = (name: string) => busy.add(name);
  const free = (name: string) => {
    const q = waiters.get(name);
    const next = q?.shift();
    if (next) next();
    else busy.delete(name);
  };

  return {
    request(name: string, options: Options, cb: Callback): Promise<unknown> {
      if (options.ifAvailable && busy.has(name)) return Promise.resolve(cb(null));
      return new Promise<unknown>((resolve, reject) => {
        const run = () => {
          Promise.resolve()
            .then(() => cb({ name }))
            .then(
              (v) => {
                free(name);
                resolve(v);
              },
              (e) => {
                free(name);
                reject(e);
              }
            );
        };
        if (!busy.has(name)) {
          take(name);
          run();
          return;
        }
        const q = waiters.get(name) ?? [];
        waiters.set(name, q);
        const start = () => {
          options.signal?.removeEventListener("abort", onAbort);
          run();
        };
        const onAbort = () => {
          const i = q.indexOf(start);
          if (i >= 0) q.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        };
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        q.push(start);
      });
    }
  };
}
