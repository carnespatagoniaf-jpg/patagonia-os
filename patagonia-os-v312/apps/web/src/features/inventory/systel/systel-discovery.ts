import { SystelClient, type SystelExchangeLog } from "./systel-client";
import { SerialSystelLink, type SystelSerialSettings } from "./systel-serial";
import { parseSystelReply } from "./systel-frame";

/**
 * Buscar cómo habla la balanza (2026-10-09, primer intento real en Los gringos: Cuora Max
 * por USB FTDI, con 115200/sin paridad/1 stop y número 1 NO contestó ni un byte).
 *
 * El documento de Systel no fija paridad, bits de stop ni el número de "Identificación"
 * (menú 11 → 3 → 1, 0 = broadcast). En vez de pedirle al cliente que revise menús, se
 * prueba solo con la función 23 (ping, SOLO LECTURA): primero las combinaciones más
 * probables con los números 1 a 10 y el 0, después 11 a 99 con la más probable.
 * Todo lo que va y vuelve queda en `log` (se manda a soporte), incluidos bytes ilegibles.
 */

export const SYSTEL_LINK_KEY = "patagonia-systel-link";

export const SYSTEL_SERIAL_CANDIDATES: SystelSerialSettings[] = [
  { baudRate: 115200, stopBits: 1, parity: "none" },
  { baudRate: 115200, stopBits: 2, parity: "none" },
  { baudRate: 115200, stopBits: 1, parity: "even" },
  { baudRate: 57600, stopBits: 1, parity: "none" },
  { baudRate: 38400, stopBits: 1, parity: "none" },
  { baudRate: 19200, stopBits: 1, parity: "none" },
  { baudRate: 9600, stopBits: 1, parity: "none" }
];

export interface SystelFoundLink {
  link: SerialSystelLink;
  settings: SystelSerialSettings;
  address: number;
}

export interface SavedSystelLink {
  settings: SystelSerialSettings;
  address: number;
}

export function loadSavedSystelLink(): SavedSystelLink | null {
  try {
    const raw = localStorage.getItem(SYSTEL_LINK_KEY);
    return raw ? (JSON.parse(raw) as SavedSystelLink) : null;
  } catch {
    return null;
  }
}

export function saveSystelLink(found: SavedSystelLink): void {
  try {
    localStorage.setItem(SYSTEL_LINK_KEY, JSON.stringify(found));
  } catch {
    // sin localStorage la próxima vez vuelve a buscar
  }
}

const label = (s: SystelSerialSettings) => `${s.baudRate} ${s.parity === "none" ? "sin paridad" : s.parity === "even" ? "paridad par" : "paridad impar"} ${s.stopBits} stop`;

/**
 * Prueba un número de balanza con una configuración ya abierta. Devuelve el número que
 * contestó: con 0 (broadcast) la balanza responde con el suyo, que se lee de los bytes.
 */
async function pingAt(link: SerialSystelLink, address: number, log: SystelExchangeLog[], timeoutMs: number): Promise<number | null> {
  const client = new SystelClient(link, { address, timeoutMs, log });
  if (await client.ping()) return address;
  const last = log[log.length - 1];
  if (!last?.rx) return null;
  const bytes = Uint8Array.from(last.rx.split(" ").filter(Boolean).map((h) => parseInt(h, 16)));
  const reply = parseSystelReply(bytes);
  return reply && reply.checksumOk && reply.fn === 23 && reply.address >= 1 && reply.address <= 99 ? reply.address : null;
}

export async function discoverSystelLink(
  port: SerialPort,
  log: SystelExchangeLog[],
  onProgress: (text: string) => void = () => {},
  preferred: SavedSystelLink | null = null,
  pingTimeoutMs = 350
): Promise<SystelFoundLink | null> {
  const plan: { settings: SystelSerialSettings; addresses: number[] }[] = [];
  if (preferred) plan.push({ settings: preferred.settings, addresses: [preferred.address] });
  const firstAddresses = [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const settings of SYSTEL_SERIAL_CANDIDATES) plan.push({ settings, addresses: firstAddresses });
  plan.push({ settings: SYSTEL_SERIAL_CANDIDATES[0], addresses: Array.from({ length: 89 }, (_, i) => i + 11) });

  for (const [i, step] of plan.entries()) {
    onProgress(`Buscando la balanza (${i + 1} de ${plan.length}: ${label(step.settings)})… no desenchufes el cable.`);
    const link = new SerialSystelLink(port, step.settings);
    try {
      await link.connect();
    } catch (err) {
      log.push({ step: `abrir puerto (${label(step.settings)})`, fn: 0, tx: "", rx: "", rxText: err instanceof Error ? err.message : String(err), ms: 0, result: "no se pudo abrir el puerto" });
      // Si el puerto ni abre, no tiene sentido seguir probando velocidades.
      return null;
    }
    await link.setSignals(true);
    for (const address of step.addresses) {
      const found = await pingAt(link, address, log, pingTimeoutMs);
      if (found !== null) return { link, settings: step.settings, address: found };
    }
    await link.close();
  }
  return null;
}
