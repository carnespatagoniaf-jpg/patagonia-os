// `localStorage` de UNA balanza, guardado en el directorio de datos del conector.
//
// El código de la web recuerda cosas en localStorage (modelo Kretz encontrado,
// configuración serie, número de la Systel, "código de barras ya configurado",
// prueba de escritura, respaldo de productos…). En el conector cada balanza tiene su
// propio almacén (como una pestaña aparte), así dos balanzas nunca se pisan.
//
// La interfaz es la de Storage (sincrónica); el guardado en disco va atrás, en fila,
// con escritura atómica. `flush()` espera a que quede en disco.

import { readJsonFile, writeFileAtomic } from "../storage/atomic-file";

interface StateFile {
  format: "patagonia-scale-connect/web-storage";
  version: 1;
  deviceId: string;
  items: Record<string, string>;
}

export class ScaleStateStore implements Storage {
  private readonly items = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;

  /** `file` null = solo en memoria (pruebas). */
  constructor(
    readonly deviceId: string,
    private readonly file: string | null,
  ) {}

  static async open(deviceId: string, file: string | null): Promise<ScaleStateStore> {
    const store = new ScaleStateStore(deviceId, file);
    if (file) {
      const read = await readJsonFile<StateFile>(file);
      if (read.status === "ok" && read.value && typeof read.value.items === "object") {
        for (const [k, v] of Object.entries(read.value.items)) if (typeof v === "string") store.items.set(k, v);
      }
    }
    return store;
  }

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.items.has(key) ? this.items.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    const text = String(value);
    if (this.items.get(key) === text) return;
    this.items.set(String(key), text);
    this.schedule();
  }

  removeItem(key: string): void {
    if (this.items.delete(key)) this.schedule();
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.schedule();
  }

  /** Copia de lo guardado (para soporte y pruebas). */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.items);
  }

  /** Espera a que lo último quede en disco. */
  async flush(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  private schedule(): void {
    if (!this.file) return;
    this.dirty = true;
    const file = this.file;
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        if (!this.dirty) return;
        this.dirty = false;
        const data: StateFile = { format: "patagonia-scale-connect/web-storage", version: 1, deviceId: this.deviceId, items: this.snapshot() };
        await writeFileAtomic(file, JSON.stringify(data, null, 1));
      });
  }
}
