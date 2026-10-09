import { SystelClient, type SystelExchangeLog } from "./systel-client";
import { SerialSystelLink, type SystelLinkEvent, type SystelSerialSettings } from "./systel-serial";
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
  const client = new SystelClient(link, { address, timeoutMs, log, busyRetryMs: [] });
  if (address !== 0 && (await client.ping())) return address;
  if (address === 0) await client.ping();
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
  pingTimeoutMs = 350,
  linkEvents: SystelLinkEvent[] = []
): Promise<SystelFoundLink | null> {
  const plan: { settings: SystelSerialSettings; addresses: number[] }[] = [];
  // Con lo guardado se repite la secuencia que anduvo en la balanza real (1, 0 y recién su número):
  // las 3 veces que se le habló directo a su número contestó E3 a todo.
  if (preferred) plan.push({ settings: preferred.settings, addresses: [...new Set([1, 0, preferred.address])] });
  // 20 temprano: es el número que trae el programa de ejemplo oficial (Form1.Designer.vb, Text_IP = "20")
  // y el del ejemplo del manual ("Id : 20"), y el que tiene la balanza de Los gringos.
  const firstAddresses = [1, 0, 20, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const settings of SYSTEL_SERIAL_CANDIDATES) plan.push({ settings, addresses: firstAddresses });
  plan.push({ settings: SYSTEL_SERIAL_CANDIDATES[0], addresses: Array.from({ length: 89 }, (_, i) => i + 11) });

  for (const [i, step] of plan.entries()) {
    onProgress(`Buscando la balanza (${i + 1} de ${plan.length}: ${label(step.settings)})… no desenchufes el cable.`);
    const link = new SerialSystelLink(port, step.settings, linkEvents);
    try {
      await link.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push({ step: `abrir puerto (${label(step.settings)})`, fn: 0, tx: "", rx: "", rxText: message, ms: 0, result: "no se pudo abrir el puerto" });
      // Si el puerto ni abre, no tiene sentido seguir probando, y NO es "la balanza no contestó"
      // (real 15:59:03: "The port is already open", otra pantalla o programa lo tenía tomado).
      throw new Error(/already open/i.test(message) ? "el puerto de la balanza está abierto en otra pantalla o programa (por ejemplo Qendra)" : `no se pudo abrir el puerto de la balanza (${message})`);
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
