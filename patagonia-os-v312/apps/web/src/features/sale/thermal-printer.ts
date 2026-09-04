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

/** A diferencia de isThermalPrintSupported (que solo dice si el navegador
 * tiene la API WebUSB, la tenga Chrome entero o no), esto dice si ESTE
 * usuario ya autorizó una impresora real -- navigator.usb.getDevices()
 * devuelve los dispositivos ya emparejados sin pedir permiso de nuevo, así
 * que se puede llamar sin gesto del usuario (por ejemplo, para decidir
 * solo si el auto-print va por la térmica o cae al diálogo del navegador). */
export async function isThermalPrinterPaired(): Promise<boolean> {
  if (!isThermalPrintSupported()) return false;
  if (cachedDevice) return true;
  const known = await navigator.usb.getDevices();
  return known.length > 0;
}

/** Para saber contra qué impresora real se está probando cada comando ESC/POS
 * -- después de que "Font A" y "doble alto" no cambiaron nada visible, hace
 * falta el modelo exacto en vez de seguir probando a ciegas. */
export async function getPairedPrinterInfo(): Promise<{ productName: string; manufacturerName: string; vendorId: number; productId: number } | null> {
  if (!isThermalPrintSupported()) return null;
  const device = cachedDevice ?? (await navigator.usb.getDevices())[0];
  if (!device) return null;
  return {
    productName: device.productName || "(sin nombre)",
    manufacturerName: (device as unknown as { manufacturerName?: string }).manufacturerName || "(sin fabricante)",
    vendorId: device.vendorId,
    productId: device.productId
  };
}

/** Cada cliente tiene una impresora distinta (térmica genérica, fiscal
 * Hasar, etc.) que responde distinto a los mismos comandos ESC/POS -- no
 * hay una sola configuración que funcione para todos. Se guarda por
 * navegador/equipo (no por empresa) porque la impresora está físicamente
 * conectada a esa caja puntual, no es algo que tenga sentido compartir
 * entre sucursales. */
export interface ThermalPrintSettings {
  bodySize: "normal" | "tall" | "double";
  font: "auto" | "a" | "b";
  lineWidth: number;
}

const SETTINGS_KEY = "patagonia-thermal-print-settings";

export const DEFAULT_THERMAL_PRINT_SETTINGS: ThermalPrintSettings = { bodySize: "tall", font: "a", lineWidth: 32 };

export function getThermalPrintSettings(): ThermalPrintSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_THERMAL_PRINT_SETTINGS;
    return { ...DEFAULT_THERMAL_PRINT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_THERMAL_PRINT_SETTINGS;
  }
}

export function saveThermalPrintSettings(settings: ThermalPrintSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage lleno o bloqueado -- no es crítico, se pierde la
    // configuración guardada pero no rompe la impresión.
  }
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

  /** La mayoría de las impresoras ESC/POS traen dos tipografías internas:
   * Font A (12x24, la grande, la de "tamaño normal" de un ticket) y Font B
   * (9x17, chica y condensada -- pensada para entrar más texto por línea,
   * no para leerse bien). Si el equipo arranca en Font B por default, todo
   * sale chico aunque el resto del formato esté bien -- por eso se fija
   * Font A acá antes de imprimir nada. GS ! (doubleSize/tall) no tuvo
   * ningún efecto visible en el equipo real de Carnes Patagonia -- puede
   * que esa impresora no soporte ese comando, así que esto es la otra
   * palanca disponible para agrandar la letra. */
  font(mode: "a" | "b") {
    this.bytes.push(ESC, 0x4d, mode === "a" ? 0 : 1);
    return this;
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

  /** Solo el doble de alto (no de ancho) -- para agrandar el cuerpo del
   * ticket sin que las líneas más largas se corten o envuelvan raro, cosa
   * que sí pasaría con doubleSize (dobla ancho y alto juntos). */
  tall(on: boolean) {
    this.bytes.push(GS, 0x21, on ? 0x01 : 0x00);
    return this;
  }

  /** Aplica la configuración de tamaño elegida por el usuario para ESTA
   * impresora (ver ThermalPrintSettings) -- normal/tall/double -- en vez de
   * un tamaño fijo en el código. on=false vuelve a tamaño normal. */
  bodySize(settings: ThermalPrintSettings, on: boolean) {
    if (settings.bodySize === "normal") return this;
    if (!on) return this.tall(false);
    return settings.bodySize === "double" ? this.doubleSize(true) : this.tall(true);
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

/** Ticket chico con datos de ejemplo para probar una configuración de
 * tamaño/fuente/ancho de línea al toque, sin necesitar una venta real --
 * así cada cliente puede ir probando combinaciones contra su propia
 * impresora hasta que se vea bien, en vez de depender de un redeploy por
 * cada intento. */
export function buildTestTicket(settings: ThermalPrintSettings): Uint8Array {
  const t = new TicketBuilder();
  if (settings.font !== "auto") t.font(settings.font);
  t.bodySize(settings, true);
  t.align("center").bold(true).line("TICKET DE PRUEBA").bold(false);
  t.align("left").separator("-", settings.lineWidth);
  t.line("Producto de ejemplo");
  t.line("  1 kg x $9.900 = $9.900");
  t.separator("-", settings.lineWidth);
  t.bodySize(settings, false);
  t.bold(true).doubleSize(true).line("TOTAL $9.900").doubleSize(false).bold(false);
  t.bodySize(settings, true);
  t.line("Así se ve con esta configuración.");
  t.bodySize(settings, false);
  t.cut();
  return t.build();
}

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
