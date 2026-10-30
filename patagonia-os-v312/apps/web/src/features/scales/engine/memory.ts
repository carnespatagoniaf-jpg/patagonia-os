import { isNetPort, netKey } from "../../inventory/kretz/net-port";
import type { ScaleModelId } from "./capabilities";

/**
 * Lo que "Mi balanza" recuerda de la balanza de ESTA computadora, para que la próxima vez sea un solo toque:
 * qué marca era y por qué cable USB (fabricante:producto del adaptador). No guarda puertos COM ni velocidades
 * (eso lo recuerda cada adaptador, como siempre).
 */

const KEY = "patagonia-my-scale";

export interface RememberedScale {
  model: ScaleModelId;
  label: string;
  family: "systel" | "kretz";
  /** "0403:6001" del adaptador USB, o null si no es USB. */
  usb: string | null;
  connectedAt: string;
  syncedAt: string | null;
}

export function usbKeyOf(port: SerialPort): string | null {
  // Balanza por cable de red: se reconoce por su dirección ("red:192.168.1.50:1001").
  if (isNetPort(port)) return netKey(port.net);
  try {
    const i = port.getInfo?.() ?? {};
    if (i.usbVendorId === undefined) return null;
    return `${i.usbVendorId.toString(16).padStart(4, "0")}:${(i.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
  } catch {
    return null;
  }
}

export function loadRememberedScale(): RememberedScale | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RememberedScale) : null;
  } catch {
    return null;
  }
}

export function rememberScale(s: RememberedScale): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // sin localStorage: la próxima vez se busca de nuevo
  }
}

export function forgetRememberedScale(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nada
  }
}

/**
 * En qué orden probar las marcas. Lo recordado primero; si no, por el chip del cable: la Cuora Max trae un FTDI
 * (documentado por Systel); las Kretz de los clientes usan adaptadores CH340/PL2303/CP210x.
 */
export function familyOrder(usb: string | null, remembered: RememberedScale | null): ("systel" | "kretz")[] {
  if (remembered && (!remembered.usb || remembered.usb === usb)) return remembered.family === "systel" ? ["systel", "kretz"] : ["kretz", "systel"];
  return usb?.startsWith("0403:") ? ["systel", "kretz"] : ["kretz", "systel"];
}
