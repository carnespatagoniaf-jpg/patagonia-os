// Listado de puertos del sistema, detrás de una interfaz para poder probar
// sin hardware y para que una falla del módulo nativo no tumbe el servicio.

import { classifyPorts, type DiscoveredPort, type RawPortInfo } from "./port-classify";
import { loadSerialport } from "../native/serialport-loader";

export interface PortLister {
  list(): Promise<RawPortInfo[]>;
}

/** Lista con serialport (en Windows usa SetupAPI: VID/PID/serie/ubicación). */
export class SerialportLister implements PortLister {
  async list(): Promise<RawPortInfo[]> {
    const { SerialPort } = await loadSerialport();
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      pnpId: p.pnpId,
      locationId: p.locationId,
      vendorId: p.vendorId,
      productId: p.productId,
      friendlyName: (p as { friendlyName?: string }).friendlyName,
    }));
  }
}

export class StaticPortLister implements PortLister {
  constructor(private readonly ports: RawPortInfo[]) {}
  async list(): Promise<RawPortInfo[]> {
    return this.ports.map((p) => ({ ...p }));
  }
}

export interface DiscoveryResult {
  ok: boolean;
  ports: DiscoveredPort[];
  error?: string;
  at: string;
}

export async function discoverPorts(lister: PortLister, now: () => Date = () => new Date()): Promise<DiscoveryResult> {
  try {
    const raws = await lister.list();
    return { ok: true, ports: classifyPorts(raws), at: now().toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, ports: [], error: `No se pudieron listar los puertos: ${message}`, at: now().toISOString() };
  }
}
