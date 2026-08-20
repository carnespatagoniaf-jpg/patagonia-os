/**
 * Impresión de ticket interno en una impresora térmica ESC/POS conectada
 * por USB (ej. la "Thermal Receipt Printer" de mostrador). No usa ningún
 * servicio intermedio: el navegador le manda los bytes directo por
 * WebUSB, así que solo anda en Chrome/Edge y hace falta autorizar el
 * dispositivo una vez por navegador (después queda recordado).
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

let cachedDevice: USBDevice | null = null;

export function isThermalPrintSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/** Reemplaza acentos/ñ por su equivalente simple -- la mayoría de estas impresoras no soportan UTF-8. */
function toPrinterText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x00-\x7f]/g, "?");
}

async function pickDevice(): Promise<USBDevice> {
  if (cachedDevice) return cachedDevice;

  const known = await navigator.usb.getDevices();
  if (known.length > 0) {
    cachedDevice = known[0];
    return cachedDevice;
  }

  const device = await navigator.usb.requestDevice({ filters: [] });
  cachedDevice = device;
  return device;
}

async function findPrintEndpoint(device: USBDevice): Promise<{ interfaceNumber: number; endpointNumber: number }> {
  if (device.configuration === null) {
    await device.selectConfiguration(1);
  }
  const config = device.configuration;
  if (!config) throw new Error("La impresora no tiene una configuración USB disponible.");

  for (const iface of config.interfaces) {
    const outEndpoint = iface.alternate.endpoints.find((e) => e.direction === "out");
    if (outEndpoint) {
      return { interfaceNumber: iface.interfaceNumber, endpointNumber: outEndpoint.endpointNumber };
    }
  }
  throw new Error("No se encontró un endpoint de salida en la impresora.");
}

class TicketBuilder {
  private bytes: number[] = [];

  constructor() {
    this.bytes.push(ESC, 0x40); // ESC @ -- inicializar
  }

  align(mode: "left" | "center" | "right") {
    const n = mode === "left" ? 0 : mode === "center" ? 1 : 2;
    this.bytes.push(ESC, 0x61, n);
    return this;
  }

  bold(on: boolean) {
    this.bytes.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  doubleSize(on: boolean) {
    this.bytes.push(GS, 0x21, on ? 0x11 : 0x00);
    return this;
  }

  line(text = "") {
    const encoded = new TextEncoder().encode(toPrinterText(text));
    this.bytes.push(...encoded, LF);
    return this;
  }

  separator(char = "-", width = 32) {
    return this.line(char.repeat(width));
  }

  feed(lines = 1) {
    for (let i = 0; i < lines; i++) this.bytes.push(LF);
    return this;
  }

  cut() {
    this.feed(3);
    this.bytes.push(GS, 0x56, 0x00); // GS V 0 -- corte total
    return this;
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export { TicketBuilder };

export async function printBytes(bytes: Uint8Array): Promise<void> {
  if (!isThermalPrintSupported()) {
    throw new Error("Este navegador no soporta impresión USB directa (usá Chrome o Edge).");
  }
  const device = await pickDevice();
  try {
    await device.open();
    const { interfaceNumber, endpointNumber } = await findPrintEndpoint(device);
    await device.claimInterface(interfaceNumber);
    await device.transferOut(endpointNumber, bytes);
  } catch (err) {
    cachedDevice = null;
    throw err;
  }
}
