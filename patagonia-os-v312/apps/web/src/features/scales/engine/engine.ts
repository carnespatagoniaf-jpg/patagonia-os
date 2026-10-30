import { knownNetAddresses, netPortFor, type NetAddress } from "../../inventory/kretz/net-port";
import { FriendlyError, friendlyKind, isPortOpenError } from "./friendly";
import { familyOrder, loadRememberedScale, rememberScale, usbKeyOf } from "./memory";
import type { EngineContext, ProgressFn, ScaleAdapter, ScaleSession } from "./types";

/**
 * "Conectar balanza": permiso → elegir puerto (o el recordado) → probar cada marca SOLO LEYENDO → sesión.
 * Las marcas vienen de live.ts (SCALE_ADAPTERS); agregar una = un adaptador más en esa lista.
 */

export interface SerialApi {
  getPorts(): Promise<SerialPort[]>;
  requestPort(): Promise<SerialPort>;
}

let pendingNetPick: NetAddress | null = null;

/** "Por cable de red": la próxima elección de cable es esa balanza por red (sin la lista de Chrome). */
export function pickNetworkScaleNext(a: NetAddress | null): void {
  pendingNetPick = a;
}

/**
 * Los puertos de Chrome más las balanzas por cable de red que esta computadora ya conectó (inventory/kretz/net-port.ts):
 * para "Mis balanzas" una Report por red es un cable más, reconocido por su dirección ("red:IP:puerto").
 */
export function serialApi(): SerialApi | null {
  const native = typeof navigator !== "undefined" && "serial" in navigator ? navigator.serial : null;
  if (!native && !pendingNetPick && knownNetAddresses().length === 0) return null;
  const netPorts = () => knownNetAddresses().map((a) => netPortFor(a) as unknown as SerialPort);
  return {
    getPorts: async () => [...(native ? await native.getPorts() : []), ...netPorts()],
    requestPort: async () => {
      const a = pendingNetPick;
      if (a) {
        pendingNetPick = null;
        return netPortFor(a) as unknown as SerialPort;
      }
      if (!native) throw new Error("Este navegador no puede usar balanzas por cable.");
      return native.requestPort();
    }
  };
}

/**
 * Tiene que llamarse desde el click de "Conectar balanza" (Chrome pide un click para mostrar la lista).
 * Lo PRIMERO que hace es pedir el puerto, antes de cualquier otra espera.
 */
export async function connectScale(ctx: EngineContext, onProgress: ProgressFn, deps: { adapters: ScaleAdapter[]; serial?: SerialApi | null }): Promise<ScaleSession> {
  const serial = deps.serial === undefined ? serialApi() : deps.serial;
  if (!serial) throw new FriendlyError("sin_navegador");
  const remembered = loadRememberedScale();

  let port: SerialPort | null = null;
  if (remembered?.usb) {
    const granted = await serial.getPorts();
    port = granted.find((p) => usbKeyOf(p) === remembered.usb) ?? null;
  }
  if (!port) {
    onProgress("permiso", "Elegí tu balanza en la lista y tocá \"Conectar\".");
    try {
      port = await serial.requestPort();
    } catch (err) {
      throw new FriendlyError("sin_eleccion", err instanceof Error ? err.message : String(err));
    }
  }

  const usb = usbKeyOf(port);
  const adapters = deps.adapters;
  const order = familyOrder(usb, remembered);
  const sorted = [...adapters].sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family));
  const errors: string[] = [];
  for (const adapter of sorted) {
    try {
      const session = await adapter.identify(port, ctx, onProgress);
      if (session) {
        rememberScale({ model: session.model, label: session.label, family: adapter.family, usb, connectedAt: new Date().toISOString(), syncedAt: remembered?.family === adapter.family ? remembered.syncedAt : null });
        return session;
      }
    } catch (err) {
      // Puerto tomado por otra pestaña/programa: no tiene sentido probar otra marca.
      if (isPortOpenError(err)) throw err instanceof FriendlyError ? err : new FriendlyError(friendlyKind(err), String(err));
      errors.push(`${adapter.family}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new FriendlyError("no_contesta", errors.join(" · ") || "ninguna marca contestó");
}

export function markSynced(): void {
  const r = loadRememberedScale();
  if (r) rememberScale({ ...r, syncedAt: new Date().toISOString() });
}
