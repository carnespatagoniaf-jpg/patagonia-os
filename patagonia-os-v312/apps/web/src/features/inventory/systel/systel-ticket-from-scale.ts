import type { Product } from "@patagonia/domain";
import { SystelClient, type SystelExchangeLog } from "./systel-client";
import { loadSavedSystelLink } from "./systel-discovery";
import { FTDI_VENDOR_ID, SerialSystelLink, type SystelLinkEvent } from "./systel-serial";
import { readTicketDetail, type TicketDetailResult } from "./systel-ticket-detail";

/**
 * Mostrador → balanza Systel por cable, para leer el detalle de un ticket de TOTAL.
 * Usa el puerto que esta computadora YA autorizó (Stock → Balanza) y la conexión que se guardó ahí
 * (velocidad y número de balanza). Nunca abre el selector de puertos ni manda nada que no sea
 * lectura (23 ping, 72 reporte de ventas). Siempre cierra el puerto al terminar.
 */

/** ¿Esta computadora tiene una Systel configurada por cable? */
export function systelTicketReadConfigured(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator && loadSavedSystelLink() !== null;
}

export type ScaleTicketRead = TicketDetailResult & { log: SystelExchangeLog[]; events: SystelLinkEvent[] };

export async function readSystelTicketFromScale(input: { amount: number; products: Product[]; usedKeys: string[] }): Promise<ScaleTicketRead> {
  const log: SystelExchangeLog[] = [];
  const events: SystelLinkEvent[] = [];
  const fail = (reason: string): ScaleTicketRead => ({ ok: false, stage: "lectura", reason, log, events });
  const saved = loadSavedSystelLink();
  if (!saved || !("serial" in navigator)) return fail("esta computadora no tiene la balanza Systel conectada por cable");
  const ports = await navigator.serial.getPorts();
  const ftdi = ports.filter((p) => {
    try {
      return p.getInfo().usbVendorId === FTDI_VENDOR_ID;
    } catch {
      return false;
    }
  });
  const port = ftdi.length === 1 ? ftdi[0] : ftdi.length === 0 && ports.length === 1 ? ports[0] : null;
  if (!port) return fail(ftdi.length > 1 ? "hay más de un cable de balanza autorizado en esta computadora" : "el cable de la balanza no está conectado (o el puerto no está autorizado en esta computadora)");
  const link = new SerialSystelLink(port, saved.settings, events);
  try {
    await link.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(/already open/i.test(message) ? "el puerto de la balanza está abierto en otra pantalla o programa (por ejemplo Qendra o Stock → Balanza)" : `no se pudo abrir el puerto de la balanza (${message})`);
  }
  try {
    // Igual que en todas las sesiones que la balanza real contestó (DTR y RTS encendidas).
    await link.setSignals(true);
    const client = new SystelClient(link, { address: saved.address, log });
    const r = await readTicketDetail(client, input);
    return { ...r, log, events };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    await link.close();
  }
}
