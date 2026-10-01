/**
 * Trama del protocolo Kretz ("Multiprotocolo para la comunicación con
 * balanzas Report Nx", documento público de Kretz S.A.). Lógica pura, sin
 * puerto serie, para poder testearla.
 *
 * QUÉ ESTÁ COMPROBADO Y CON QUÉ (ver docs/BALANZAS_KRETZ.md):
 * - Formato de comando y de respuesta, checksum, grupos de comandos y tabla de
 *   códigos de respuesta: DOCUMENTADO para la familia Report Nx (letra "C").
 *   El ejemplo de checksum del documento está en el test.
 * - Report LT real: COMPROBADO con la balanza (115200 baudios, letra "C",
 *   ID "01", comandos 0001, 2005, 3005, 5002, 5005; código "01" = éxito).
 * - Kretz Aura (familia "PPI" según Kretz): NO documentado. Que hable este
 *   mismo formato en el modo COMUNI → Datos es una HIPÓTESIS hasta que una
 *   Aura real conteste una trama con esta forma.
 *
 * Comando:   STX(0x02) + tipo(1) + ID equipo(2) + comando(4) + datos + checksum(2) + EOT(0x04)
 * Respuesta: 0x07 + tipo(1) + ID equipo(2) + grupo(2) + número(2) + datos + checksum(2) + EOT
 * Checksum:  suma de todos los bytes anteriores al checksum (incluido el
 *            byte de arranque), byte bajo partido en dos nibbles, + 0x30 cada uno.
 */

export const STX = 0x02;
export const ACK_START = 0x07;
export const EOT = 0x04;

export function kretzChecksum(bytes: ArrayLike<number>): [number, number] {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xff;
  return [((sum >> 4) & 0x0f) + 0x30, (sum & 0x0f) + 0x30];
}

export function buildKretzFrame(deviceType: string, equipmentId: string, command: string, data = ""): Uint8Array {
  const body = [
    (deviceType || "C").charCodeAt(0),
    ...equipmentId.padStart(2, "0").slice(-2).split("").map((c) => c.charCodeAt(0)),
    ...command.padStart(4, "0").split("").map((c) => c.charCodeAt(0)),
    ...Array.from(data).map((c) => c.charCodeAt(0))
  ];
  const [high, low] = kretzChecksum([STX, ...body]);
  return new Uint8Array([STX, ...body, high, low, EOT]);
}

export interface KretzResponse {
  deviceType: string;
  equipmentId: string;
  /** Grupo de la respuesta (2 dígitos). */
  group: string;
  /** Número de respuesta: "01" = éxito (ver KRETZ_RESPONSE_LABELS). */
  code: string;
  data: string;
  /** El checksum que vino coincide con el calculado. */
  checksumOk: boolean;
}

/** Interpreta una respuesta Kretz. null si los bytes no tienen esa forma. */
export function parseKretzResponse(bytes: ArrayLike<number>): KretzResponse | null {
  const arr = Array.from(bytes);
  const start = arr.indexOf(ACK_START);
  if (start < 0) return null;
  const end = arr.indexOf(EOT, start + 1);
  if (end < 0) return null;
  const frame = arr.slice(start, end + 1);
  // 0x07 + tipo + ID(2) + grupo(2) + número(2) + checksum(2) + EOT = mínimo 11 bytes.
  if (frame.length < 11) return null;
  const text = (from: number, to: number) => String.fromCharCode(...frame.slice(from, to));
  const [high, low] = kretzChecksum(frame.slice(0, frame.length - 3));
  return {
    deviceType: text(1, 2),
    equipmentId: text(2, 4),
    group: text(4, 6),
    code: text(6, 8),
    data: text(8, frame.length - 3),
    checksumOk: frame[frame.length - 3] === high && frame[frame.length - 2] === low
  };
}

/** Códigos de respuesta según el documento público (Report Nx). Solo "01" está comprobado en una balanza real. */
export const KRETZ_RESPONSE_LABELS: Record<string, string> = {
  "01": "comando ejecutado correctamente",
  "02": "comando inexistente o no disponible en el equipo",
  "10": "error de checksum",
  "11": "error en el modelo de datos (cantidad de bytes)",
  "20": "registro inexistente",
  "30": "último registro leído",
  "31": "último registro borrado",
  "40": "no hay registros",
  "41": "no hay registros para borrar",
  "50": "capacidad máxima superada",
  "60": "error al ejecutar el comando"
};

export function describeKretzCode(code: string | null): string {
  if (code === null) return "sin respuesta";
  return KRETZ_RESPONSE_LABELS[code] ?? "código desconocido (no figura en el documento de Kretz)";
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** Bytes a texto legible para el diagnóstico: los no imprimibles como <xx>. */
export function toPrintable(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `<${b.toString(16).padStart(2, "0")}>`)).join("");
}
