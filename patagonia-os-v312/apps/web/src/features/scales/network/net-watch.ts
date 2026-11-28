import { useEffect, useState } from "react";
import { netPortFor, parseNetKey, type NetAddress } from "../../inventory/kretz/net-port";

/**
 * Las balanzas por red que esta computadora ya conectó se revisan solas: al abrir "Mis balanzas" y cada 30 segundos
 * mientras está abierta la lista. Abrir la conexión ya reintenta y, si la balanza cambió de dirección, la busca de
 * nuevo por su marca y la recuerda con la nueva (net-port.ts). Así "PASAR PRODUCTOS" la encuentra sin preguntar nada.
 *
 * Solo con la lista a la vista. Y nunca mientras otra pestaña usa esa balanza: el candado entre pestañas
 * (`NetScalePort.tryOpen`) lo impide, porque con el programa de la PC versión 6 (una conexión a la vez) revisar
 * mientras se pasan productos cortaba el envío.
 */

export type NetWatchStatus = "revisando" | "ok" | "no";

export interface NetWatchTarget {
  key: string;
  /** La clave del cable recordado ("red:IP:puerto"); las que no son por red no se revisan. */
  usb: string | null;
}

export interface NetWatchState {
  status: NetWatchStatus;
  address: NetAddress;
}

type WatchedPort = { open(): Promise<void>; tryOpen?(): Promise<boolean>; close(): Promise<void>; readable: unknown; net: NetAddress };

/**
 * Revisa una balanza: abre y cierra (no le manda nada). Devuelve dónde contestó, o null si no contestó.
 * Si otra pestaña (o otra parte de esta) la tiene tomada (candado de scale-lock.ts), no la toca: está andando.
 */
export async function checkNetScale(a: NetAddress, portFor: (a: NetAddress) => WatchedPort = netPortFor): Promise<NetAddress | null> {
  const port = portFor(a);
  if (port.readable) return port.net; // abierta por otra cosa: está andando
  try {
    if (port.tryOpen) {
      if (!(await port.tryOpen())) return port.net; // la está usando otra pestaña
    } else await port.open();
    await port.close();
    return port.net;
  } catch {
    return null;
  }
}

const EVERY_MS = 30000;

export function useNetScaleWatch(targets: () => NetWatchTarget[], enabled: boolean, deps: unknown[]): Record<string, NetWatchState> {
  const [state, setState] = useState<Record<string, NetWatchState>>({});
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        for (const t of targets()) {
          if (stop) return;
          const a = parseNetKey(t.usb);
          if (!a) continue;
          setState((s) => ({ ...s, [t.key]: { status: s[t.key]?.status === "ok" ? "ok" : "revisando", address: a } }));
          const at = await checkNetScale(a);
          if (stop) return;
          setState((s) => ({ ...s, [t.key]: { status: at ? "ok" : "no", address: at ?? a } }));
        }
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), EVERY_MS);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return state;
}

export function netWatchText(s: NetWatchState): { text: string; tone: "ok" | "warn" | "bad" } {
  if (s.status === "ok") return { text: `Conectada por cable de red (${s.address.host})`, tone: "ok" };
  if (s.status === "revisando") return { text: "Revisando la conexión por la red…", tone: "warn" };
  return { text: "No contesta por la red: fijate que esté prendida y la luz del cable. Se vuelve a conectar sola.", tone: "bad" };
}

