// Punto de entrada del código de protocolos de la WEB que usa el conector.
//
// NO es código del conector: es la lista de piezas de `apps/web` que se empaquetan
// (esbuild, formato IIFE) en un solo texto. Ese texto se ejecuta UNA VEZ POR BALANZA
// (web-runtime.ts), con su propio `localStorage` y su propio `navigator.serial`, así
// cada balanza tiene sus variables de módulo (puerto elegido, formato de etiqueta,
// tiempos) igual que si fuera una pestaña de Chrome aparte. Nada de esto se copia ni
// se reescribe: el día que se arregla un protocolo en la web, el conector lo trae.

import { NetScalePort, type NetAddress } from "../../../web/src/features/inventory/kretz/net-port";

export { makeKretzAdapter, KRETZ_IO, isFactoryPlaceholder } from "../../../web/src/features/scales/engine/adapters/kretz";
export { makeSystelAdapter, saveProductBackupLocally } from "../../../web/src/features/scales/engine/adapters/systel";
export { loadSavedSystelLink, saveSystelLink } from "../../../web/src/features/inventory/systel/systel-discovery";
export { FriendlyError, FRIENDLY_MESSAGES, friendlyKind, isPortOpenError } from "../../../web/src/features/scales/engine/friendly";
export { usbKeyOf } from "../../../web/src/features/scales/engine/memory";
export { AURA_ITEM_SCALE_CONFIG, planAuraSync } from "../../../web/src/features/inventory/kretz/aura-sync";
export { expectedReportProduct, reportDifferences } from "../../../web/src/features/inventory/scale-serial";
export { isNetPort, netKey } from "../../../web/src/features/inventory/kretz/net-port";

/** Lo mínimo de un SerialPort que el conector le pasa (WebSerialPortShim). */
interface PortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
}

/**
 * Balanza por red (TCP directo desde el conector) con la forma de `NetScalePort`:
 * así el código Kretz la trata como "por red" (sin velocidades ni modo peso, etiqueta
 * 2-5-5 de la Report por red) exactamente como en el navegador. Los bytes van por el
 * puerto del conector en vez del programa de la PC.
 */
export function makeConnectorNetPort(base: PortLike, address: NetAddress): SerialPort {
  class ConnectorNetPort extends NetScalePort {
    constructor() {
      super(address, false);
      Object.defineProperty(this, "readable", { get: () => base.readable, set: () => undefined, configurable: true });
      Object.defineProperty(this, "writable", { get: () => base.writable, set: () => undefined, configurable: true });
    }

    override async open(options?: SerialOptions): Promise<void> {
      await base.open(options ?? { baudRate: 9600 });
    }

    override async tryOpen(): Promise<boolean> {
      await this.open();
      return true;
    }

    override async close(): Promise<void> {
      await base.close();
    }
  }
  return new ConnectorNetPort() as unknown as SerialPort;
}
