// Descubridor de puertos: lógica pura. Recibe lo que informa Windows
// (vía serialport.list(), que usa SetupAPI) y lo convierte en algo útil:
// tipo de puerto, chip del adaptador y una "huella" estable para reconocer
// el mismo adaptador aunque Windows le cambie el número de COM.

/** Lo que devuelve serialport.list() (todos los campos salvo path pueden faltar). */
export interface RawPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
}

export type PortKind = "usb" | "bluetooth" | "builtin" | "virtual" | "unknown";
export type ChipFamily = "ftdi" | "ch34x" | "pl2303" | "cp210x" | "bluetooth" | "builtin" | "other" | "unknown";
export type FingerprintSource = "serial" | "location" | "instance" | "bluetooth" | "path";

export interface DiscoveredPort {
  path: string;
  kind: PortKind;
  chip: ChipFamily;
  /** Nombre del chip para la persona ("FTDI FT232R", "CH340"…). */
  chipLabel: string;
  vendorId?: string;
  productId?: string;
  /** Número de serie REAL del adaptador (no el identificador que inventa Windows). */
  serialNumber?: string;
  pnpId?: string;
  /** Ubicación física (puerto del hub) según Windows. */
  location?: string;
  manufacturer?: string;
  friendlyName?: string;
  /** Dirección del equipo Bluetooth emparejado (12 hexadecimales), si es saliente. */
  bluetoothAddress?: string;
  /** "entrante" = el COM que Windows abre para que OTROS se conecten; no sirve para hablarle a la balanza. */
  bluetoothDirection?: "outgoing" | "incoming";
  /** Huella estable del puerto. */
  fingerprint: string;
  fingerprintSource: FingerprintSource;
  /** Advertencias para soporte (chip conflictivo, etc.). */
  notes: string[];
}

interface ChipModel {
  family: ChipFamily;
  vendorLabel: string;
  products: Record<string, string>;
  note?: string;
}

/** Fabricantes de adaptadores USB-serie que se ven en las balanzas. */
const CHIPS: Record<string, ChipModel> = {
  "0403": {
    family: "ftdi",
    vendorLabel: "FTDI",
    products: { "6001": "FT232R", "6015": "FT231X", "6010": "FT2232", "6011": "FT4232", "6014": "FT232H" },
  },
  "1a86": {
    family: "ch34x",
    vendorLabel: "WCH",
    products: { "7523": "CH340", "5523": "CH341", "55d4": "CH9102", "7522": "CH340K" },
    note: "Los CH340 no tienen número de serie: se reconocen por el puerto USB donde están enchufados.",
  },
  "067b": {
    family: "pl2303",
    vendorLabel: "Prolific",
    products: { "2303": "PL2303", "23a3": "PL2303GC", "23d3": "PL2303GL" },
    note: "Algunos PL2303 viejos o clonados no andan con el driver actual de Windows (\"este dispositivo ya no se admite\").",
  },
  "10c4": {
    family: "cp210x",
    vendorLabel: "Silicon Labs",
    products: { ea60: "CP210x", ea70: "CP2105", ea71: "CP2108" },
  },
};

const HEX4 = /^[0-9a-f]{4}$/;

function normHex4(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase().replace(/^0x/, "");
  return HEX4.test(v) ? v : undefined;
}

function fromPnp(pnpId: string | undefined, tag: "VID" | "PID"): string | undefined {
  if (!pnpId) return undefined;
  const match = new RegExp(`${tag}_([0-9A-F]{4})`, "i").exec(pnpId);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * ¿Es un número de serie real? Cuando el adaptador no tiene (CH340, muchos
 * PL2303), Windows inventa un "identificador de instancia" con "&"
 * (por ejemplo "5&2a6e7e8c&0&3") que depende del puerto USB, no del aparato.
 */
export function isRealSerialNumber(value: string | undefined): value is string {
  if (!value) return false;
  const v = value.trim();
  if (v.length < 3 || v.includes("&")) return false;
  if (/^0+$/.test(v)) return false;
  return true;
}

/** Número de serie que aparece en el pnpId ("USB\VID_x&PID_y\SERIE" o "FTDIBUS\VID_x+PID_y+SERIE\0000"). */
function serialFromPnp(pnpId: string | undefined): string | undefined {
  if (!pnpId) return undefined;
  const ftdi = /\+PID_[0-9A-F]{4}\+([^\\]+)/i.exec(pnpId);
  if (ftdi) return ftdi[1];
  const usb = /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}(?:&[^\\]*)?\\([^\\]+)$/i.exec(pnpId);
  return usb ? usb[1] : undefined;
}

function bluetoothInfo(pnpId: string): { address?: string; direction: "outgoing" | "incoming" } {
  // BTHENUM\{00001101-...}_LOCALMFG&0002\7&1A2B3C4D&0&001122334455_C00000000
  const match = /&([0-9A-F]{12})_/i.exec(pnpId);
  const address = match?.[1].toUpperCase();
  if (!address || /^0{12}$/.test(address)) return { direction: "incoming" };
  return { address, direction: "outgoing" };
}

function normPath(path: string): string {
  return path.replace(/^\\\\\.\\/, "").trim().toUpperCase();
}

export function classifyPort(raw: RawPortInfo): DiscoveredPort {
  const path = normPath(raw.path);
  const pnpId = raw.pnpId?.trim() || undefined;
  const pnpUpper = (pnpId ?? "").toUpperCase();
  const vendorId = normHex4(raw.vendorId) ?? fromPnp(pnpId, "VID");
  const productId = normHex4(raw.productId) ?? fromPnp(pnpId, "PID");
  const location = raw.locationId?.trim() || undefined;
  const notes: string[] = [];

  const base = {
    path,
    vendorId,
    productId,
    pnpId,
    location,
    manufacturer: raw.manufacturer?.trim() || undefined,
    friendlyName: raw.friendlyName?.trim() || undefined,
    notes,
  };

  // Bluetooth (perfil de puerto serie, SPP).
  if (pnpUpper.startsWith("BTHENUM\\") || /bluetooth/i.test(raw.friendlyName ?? "")) {
    const bt = pnpId ? bluetoothInfo(pnpId) : { direction: "incoming" as const };
    if (bt.direction === "incoming") {
      notes.push("Es el puerto Bluetooth ENTRANTE de Windows: para hablarle a la balanza hay que usar el saliente.");
    }
    return {
      ...base,
      kind: "bluetooth",
      chip: "bluetooth",
      chipLabel: "Bluetooth",
      bluetoothAddress: bt.address,
      bluetoothDirection: bt.direction,
      fingerprint: bt.address ? `bt:${bt.address}` : `path:${path}`,
      fingerprintSource: bt.address ? "bluetooth" : "path",
    };
  }

  // Puerto serie de la placa madre.
  if (pnpUpper.startsWith("ACPI\\")) {
    return {
      ...base,
      kind: "builtin",
      chip: "builtin",
      chipLabel: "Puerto serie de la PC",
      fingerprint: `path:${path}`,
      fingerprintSource: "path",
    };
  }

  // Puertos virtuales (com0com, emuladores, software de terceros).
  if (pnpUpper.startsWith("ROOT\\") || /com0com|virtual|emulator/i.test(`${raw.friendlyName ?? ""} ${raw.manufacturer ?? ""}`)) {
    return {
      ...base,
      kind: "virtual",
      chip: "other",
      chipLabel: "Puerto virtual",
      fingerprint: `path:${path}`,
      fingerprintSource: "path",
    };
  }

  const isUsb = Boolean(vendorId) || pnpUpper.startsWith("USB\\") || pnpUpper.startsWith("FTDIBUS\\");
  const model = vendorId ? CHIPS[vendorId] : undefined;
  const chip: ChipFamily = model?.family ?? (isUsb ? "other" : "unknown");
  const productLabel = model && productId ? model.products[productId] : undefined;
  const chipLabel = model
    ? productLabel ?? `${model.vendorLabel} ${productId ?? ""}`.trim()
    : isUsb
      ? `USB ${vendorId ?? "????"}:${productId ?? "????"}`
      : "Desconocido";
  if (model?.note) notes.push(model.note);

  const declaredSerial = isRealSerialNumber(raw.serialNumber) ? raw.serialNumber.trim() : undefined;
  const pnpSerial = serialFromPnp(pnpId);
  const serialNumber = declaredSerial ?? (isRealSerialNumber(pnpSerial) ? pnpSerial : undefined);
  const instanceId = !serialNumber && raw.serialNumber?.includes("&") ? raw.serialNumber.trim() : undefined;
  const ids = `${vendorId ?? "????"}:${productId ?? "????"}`;

  let fingerprint: string;
  let fingerprintSource: FingerprintSource;
  if (serialNumber) {
    fingerprint = `usb:${ids}:sn:${serialNumber.toUpperCase()}`;
    fingerprintSource = "serial";
  } else if (location) {
    fingerprint = `usb:${ids}:loc:${location}`;
    fingerprintSource = "location";
  } else if (instanceId) {
    fingerprint = `usb:${ids}:inst:${instanceId.toUpperCase()}`;
    fingerprintSource = "instance";
  } else {
    fingerprint = `path:${path}`;
    fingerprintSource = "path";
  }
  if (isUsb && fingerprintSource !== "serial") {
    notes.push("Sin número de serie: si se enchufa en otro puerto USB, se reconoce como un adaptador nuevo.");
  }

  return {
    ...base,
    kind: isUsb ? "usb" : "unknown",
    chip,
    chipLabel,
    serialNumber,
    fingerprint,
    fingerprintSource,
  };
}

/** Ordena COM1, COM2, COM10 por número (no alfabéticamente). */
function comNumber(path: string): number {
  const match = /^COM(\d+)$/i.exec(path);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function classifyPorts(raws: RawPortInfo[]): DiscoveredPort[] {
  return raws
    .filter((raw) => typeof raw.path === "string" && raw.path.trim() !== "")
    .map(classifyPort)
    .sort((a, b) => comNumber(a.path) - comNumber(b.path) || a.path.localeCompare(b.path));
}
