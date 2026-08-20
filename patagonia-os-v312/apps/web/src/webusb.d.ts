// Tipos minimos de WebUSB -- la lib.dom.d.ts de este TypeScript no los trae.
// Solo lo que usa features/sale/thermal-printer.ts para hablarle a la
// impresora térmica por USB directo desde el navegador (Chrome/Edge).
interface USBEndpoint {
  endpointNumber: number;
  direction: "in" | "out";
}

interface USBAlternateInterface {
  endpoints: USBEndpoint[];
}

interface USBInterface {
  interfaceNumber: number;
  alternate: USBAlternateInterface;
}

interface USBConfiguration {
  interfaces: USBInterface[];
}

interface USBOutTransferResult {
  bytesWritten: number;
  status: "ok" | "stall" | "babble";
}

interface USBDevice {
  configuration: USBConfiguration | null;
  productName?: string;
  vendorId: number;
  productId: number;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<USBOutTransferResult>;
}

interface USBDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
}

interface USBDeviceRequestOptions {
  filters: USBDeviceFilter[];
}

interface USB {
  getDevices(): Promise<USBDevice[]>;
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
}

interface Navigator {
  readonly usb: USB;
}
