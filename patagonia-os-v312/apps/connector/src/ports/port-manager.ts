// Gestor de puertos: cada puerto serie o socket de balanza tiene UN solo dueño
// dentro del servicio. Pedir uno ocupado da un error claro ("in_use_here"),
// distinto de "lo tiene otro programa" (Windows niega el acceso) y de
// "no existe".

import type { ByteLink } from "../link/byte-link";
import { LinkError, classifyOpenError } from "../link/link-error";

export type ResourceKey = string;

export function serialResource(path: string): ResourceKey {
  return `serial:${path.replace(/^\\\\\.\\/, "").trim().toUpperCase()}`;
}

export function tcpResource(host: string, port: number): ResourceKey {
  return `tcp:${host.trim().toLowerCase()}:${port}`;
}

export function describeResource(key: ResourceKey): string {
  if (key.startsWith("serial:")) return `el puerto ${key.slice("serial:".length)}`;
  if (key.startsWith("tcp:")) return `la balanza de red ${key.slice("tcp:".length)}`;
  return key;
}

export interface PortLease {
  readonly key: ResourceKey;
  readonly owner: string;
  readonly link: ByteLink;
  readonly since: Date;
  /** Cierra el enlace y libera el puerto. Se puede llamar varias veces. */
  release(): Promise<void>;
}

interface Entry {
  owner: string;
  since: Date;
  link: ByteLink | null;
  token: symbol;
}

export interface OwnershipInfo {
  key: ResourceKey;
  owner: string;
  since: string;
  open: boolean;
}

export class PortManager {
  private readonly entries = new Map<ResourceKey, Entry>();

  ownerOf(key: ResourceKey): string | undefined {
    return this.entries.get(key)?.owner;
  }

  isTaken(key: ResourceKey): boolean {
    return this.entries.has(key);
  }

  list(): OwnershipInfo[] {
    return [...this.entries.entries()].map(([key, e]) => ({
      key,
      owner: e.owner,
      since: e.since.toISOString(),
      open: Boolean(e.link?.isOpen),
    }));
  }

  /**
   * Reserva el puerto, crea el enlace y lo abre. Si algo falla, el puerto
   * queda libre otra vez y el error sale clasificado.
   */
  async open(key: ResourceKey, owner: string, createLink: () => ByteLink): Promise<PortLease> {
    const current = this.entries.get(key);
    if (current) {
      throw new LinkError(
        "in_use_here",
        `${capitalize(describeResource(key))} ya lo está usando "${current.owner}" en este servicio.`,
      );
    }
    const token = Symbol(key);
    const entry: Entry = { owner, since: new Date(), link: null, token };
    this.entries.set(key, entry);

    let link: ByteLink;
    try {
      link = createLink();
      entry.link = link;
      await link.open();
    } catch (error) {
      this.forget(key, token);
      try {
        await entry.link?.close();
      } catch {
        // ya estaba cerrado
      }
      throw classifyOpenError(error, describeResource(key));
    }

    let released = false;
    return {
      key,
      owner,
      link,
      since: entry.since,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await link.close();
        } finally {
          this.forget(key, token);
        }
      },
    };
  }

  /** Libera todos los puertos (apagado del servicio). */
  async releaseAll(): Promise<void> {
    const links = [...this.entries.values()].map((e) => e.link);
    this.entries.clear();
    await Promise.allSettled(links.map((l) => l?.close()));
  }

  private forget(key: ResourceKey, token: symbol): void {
    // Solo borra si sigue siendo la misma reserva (no una posterior).
    if (this.entries.get(key)?.token === token) this.entries.delete(key);
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
