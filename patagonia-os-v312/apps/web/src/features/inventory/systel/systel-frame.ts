/**
 * Trama del protocolo Systel (Cuora 2 V4.0, Cuora Max V6.0 / V6.2 / V7.0).
 * Fuente: "Protocolo de comunicaciones CUORA MAX V7" (Systel, 20/06/2022) y el
 * programa de ejemplo oficial (Form1.vb). Resumen en docs/SYSTEL_INFORME.md.
 *
 * PC → balanza: dirección (1 byte, 0-99) + función (1 byte) + datos ASCII + verificación.
 * Balanza → PC: lo mismo. La verificación es el XOR de todos los bytes anteriores.
 * DOCUMENTADO: no hay bytes de inicio ni de fin; la trama termina por silencio (~5 ms).
 * EJEMPLO: dirección y función van como bytes binarios (ChrW(número)), no como texto.
 *
 * Módulo independiente: no usa nada de Kretz.
 */

export function xorChecksum(bytes: ArrayLike<number>): number {
  let x = 0;
  for (let i = 0; i < bytes.length; i++) x ^= bytes[i];
  return x & 0xff;
}

/** Caracteres que acepta la Cuora (nota 1 del instructivo de importación de Qendra), sin "ñ/Ñ/º/´" (no son ASCII). */
const CUORA_SAFE = /^[ !"#$%&()*+,\-./0-9:;<=>?@A-Z[\\\]_`a-z{|}]*$/;

export function isCuoraSafeText(text: string): boolean {
  return CUORA_SAFE.test(text);
}

/** Pasa un texto a lo que acepta la balanza: sin acentos, Ñ → N, sin ";" (lo usan las listas), lo demás a espacio. */
export function toCuoraText(text: string, width: number): string {
  const clean = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N")
    .replace(/;/g, ",")
    .replace(/[^ !"#$%&()*+,\-./0-9:<=>?@A-Z[\\\]_`a-z{|}]/g, " ");
  return clean.slice(0, width).padEnd(width, " ");
}

export function buildSystelFrame(address: number, fn: number, data = "", options: { checksum?: boolean } = {}): Uint8Array {
  if (!Number.isInteger(address) || address < 0 || address > 99) throw new Error(`Dirección fuera de rango (0 a 99): ${address}`);
  if (!Number.isInteger(fn) || fn < 1 || fn > 255) throw new Error(`Función inválida: ${fn}`);
  for (let i = 0; i < data.length; i++) {
    if (data.charCodeAt(i) > 0x7e || data.charCodeAt(i) < 0x20) throw new Error(`Carácter no permitido en la trama (posición ${i})`);
  }
  const body = [address, fn, ...Array.from(data, (c) => c.charCodeAt(0))];
  const withCheck = options.checksum === false ? body : [...body, xorChecksum(body)];
  return Uint8Array.from(withCheck);
}

export const SYSTEL_ERRORS: Record<string, string> = {
  E1: "la verificación de la trama no coincide",
  E2: "se llenó el buffer de recepción",
  E3: "se desatendieron datos",
  E4: "la balanza no conoce esa orden (función no válida para este modelo)",
  E5: "se mandaron más o menos datos de los necesarios",
  E6: "dato fuera de límites",
  E7: "el dato pedido no existe",
  E8: "contenido inválido",
  E9: "desborde de un acumulador"
};

export type SystelReplyKind = "ack" | "error" | "data" | "working";

export interface SystelReply {
  address: number;
  fn: number;
  data: string;
  kind: SystelReplyKind;
  /** "E1".."E9" si kind === "error". */
  errorCode: string | null;
  checksumOk: boolean;
}

/**
 * Interpreta lo recibido. Devuelve null si no tiene la forma mínima (dirección + función + verificación).
 * `ACK` = recibido y procesado; `En` = error; `I` = empezó una tarea larga.
 */
export function parseSystelReply(bytes: Uint8Array): SystelReply | null {
  if (bytes.length < 3) return null;
  const body = bytes.subarray(0, bytes.length - 1);
  const check = bytes[bytes.length - 1];
  const data = String.fromCharCode(...body.subarray(2));
  const checksumOk = xorChecksum(body) === check;
  let kind: SystelReplyKind = "data";
  let errorCode: string | null = null;
  if (data === "ACK") kind = "ack";
  else if (/^E[1-9]$/.test(data)) {
    kind = "error";
    errorCode = data;
  } else if (data === "I") kind = "working";
  return { address: body[0], fn: body[1], data, kind, errorCode, checksumOk };
}

export function describeSystelError(code: string | null): string {
  return code ? `${code}: ${SYSTEL_ERRORS[code] ?? "error desconocido"}` : "sin respuesta";
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes as ArrayLike<number>, (b) => b.toString(16).padStart(2, "0")).join(" ");
}
