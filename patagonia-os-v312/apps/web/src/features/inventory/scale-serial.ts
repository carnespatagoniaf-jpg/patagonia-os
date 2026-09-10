import type { Product } from "@patagonia/domain";
import type { ProductCategory } from "./product-categories-service";

/**
 * Carga de PLUs directo a la balanza Kretz (familia Report NX/LT) por cable
 * serie (RS232, o USB con adaptador serie) -- sin pasar por iTegra/Simplex.
 * El navegador habla directo por el puerto COM con la Web Serial API
 * (navigator.serial), igual que thermal-printer.ts hace con WebUSB para la
 * impresora: solo anda en Chrome/Edge, y hay que autorizar el puerto una
 * vez (después queda recordado, navigator.serial.getPorts() lo devuelve sin
 * pedir permiso de nuevo).
 *
 * Protocolo confirmado contra una balanza Report LT real (modelo
 * RPL-030KM4BFPP3KAR, firmware ODISEA 2, 115200 baudios, tipo de equipo
 * 'C', ID de equipo "01"):
 * - Trama de comando: STX(0x02) + tipo de equipo ('C') + ID de equipo
 *   (2 ASCII) + Nº de comando (4 ASCII) + datos + checksum (2 ASCII) +
 *   EOT(0x04).
 * - Checksum: suma algebraica (mod 256) de TODOS los bytes de la trama que
 *   preceden al checksum, incluido el byte de arranque (STX en el comando,
 *   0x07 en la respuesta). Se separa la suma en nibble alto y bajo, y a
 *   cada nibble se le suma 0x30 para volverlo un caracter ASCII imprimible.
 *   Confirmado reproduciendo a mano el checksum real que puso la balanza en
 *   varias respuestas.
 * - Comando 0001: test de conexión, sin datos.
 * - Comando 2005: alta/modificación de PLU. El modelo de datos real (orden
 *   y ancho de cada campo) se obtuvo con el comando 5002 (consultar modelo
 *   de datos de la entidad "05" = PLU) contra esta balanza puntual -- NO es
 *   el mismo que documenta el protocolo público de Kretz (ahí Precio es de
 *   7 dígitos y no hay campo 22). Ver el detalle en buildPluFrame.
 * - Comando 3005: borrar PLU. Comando 5005: leer PLU.
 * - IMPORTANTE -- 5005 NO es una lectura exacta: devuelve el primer PLU
 *   existente ESTRICTAMENTE MAYOR al argumento que le mandás (nunca el
 *   argumento mismo, aunque exista un registro con ese número). Confirmado
 *   con varios códigos reales (ej. pedir "105" salta al "106" aunque el
 *   105 exista; pedir "103" y "104" devuelven los dos el mismo "105", el
 *   primero mayor que ambos). Por eso, para leer/verificar el PLU N con
 *   5005 hay que consultarlo con el argumento N-1, no con N. Campo 01
 *   (Número de PLU) y Campo 06 (Código de PLU) del comando 2005 SÍ llevan
 *   el código de Patagonia OS tal cual, sin ningún desfasaje -- confirmado
 *   con datos reales nunca tocados por nosotros (PLU 509 = "ARROLLADO DE
 *   CARNE" vive nativamente en el 509) y con una prueba sintética (Campo 01
 *   = 90001 sin offset, verificado con éxito usando argumento 90000).
 *   También se confirmó que 2005 modifica el registro existente en vez de
 *   duplicar (probado escribiendo dos veces seguidas el mismo PLU
 *   sintético con nombres distintos: la segunda escritura reemplazó a la
 *   primera).
 * - Código de respuesta (2 ASCII en el offset 6-7 de la respuesta): "01" es
 *   éxito real, confirmado a fondo (se grabó y se pudo releer). Otros
 *   códigos documentados: "02" comando inexistente, "10" error de
 *   checksum, "20" cantidad de bytes incorrecta / modelo de datos
 *   inválido, "30" registro inexistente, "40" último registro borrado,
 *   "41" no hay registros, "50" no hay registros para borrar, "60"
 *   capacidad máxima superada o falló la ejecución.
 * - IMPORTANTE -- 2005 sobre un PLU que ya existía (cargado antes por
 *   iTegra) puede IGNORAR la modificación en silencio (respondiendo "01"
 *   igual) si los campos "secundarios" del comando (flag de posición
 *   decimal, código de etiqueta, campo 19, etc.) no coinciden con los que
 *   ya tenía guardados. Por eso buildPluFrame LEE el PLU primero (5005) y
 *   preserva esos campos tal cual venían, cambiando solo nombre/
 *   descripción/precio/tipo -- para un PLU nuevo (que nunca existió) usa
 *   valores por defecto razonables. Esto significa que cada producto
 *   enviado hace un viaje de lectura + uno de escritura (el doble de
 *   tráfico que antes), no una escritura sola.
 *
 * El PLU se arma a partir del `product.code` de Patagonia OS (tiene que
 * ser puramente numérico) -- es el mismo criterio que ya usa el escaneo de
 * etiquetas en Mostrador (scale-config-service.ts, Sale.tsx:
 * `p.code === scanned.plu`), así que un producto sincronizado acá después
 * se reconoce igual al escanear su etiqueta.
 */

const STX = 0x02;
const EOT = 0x04;

export interface ScaleSerialSettings {
  baudRate: number;
  equipmentId: string; // 2 dígitos, "01" confirmado contra esta balanza
  /** Carácter que identifica la familia de equipo -- 'C' confirmado contra
   * una Report LT real (probamos A, B, D, K también: ninguna respondió
   * nada, solo 'C'). Se deja configurable por si otro cliente tiene un
   * modelo que use otra letra. */
  deviceType: string;
  /** Número de comando para alta/modificación de PLU -- confirmado "2005"
   * contra esta balanza. */
  altaCommand: string;
}

export const DEFAULT_SCALE_SERIAL_SETTINGS: ScaleSerialSettings = { baudRate: 115200, equipmentId: "01", deviceType: "C", altaCommand: "2005" };

const SETTINGS_KEY = "patagonia-scale-serial-settings";

export function getScaleSerialSettings(): ScaleSerialSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SCALE_SERIAL_SETTINGS;
    return { ...DEFAULT_SCALE_SERIAL_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SCALE_SERIAL_SETTINGS;
  }
}

export function saveScaleSerialSettings(settings: ScaleSerialSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage lleno o bloqueado -- no crítico.
  }
}

export function isScaleSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

let cachedPort: SerialPort | null = null;
let cachedPortOpenBaud: number | null = null;

export async function isScalePortPaired(): Promise<boolean> {
  if (!isScaleSerialSupported()) return false;
  if (cachedPort) return true;
  const known = await navigator.serial.getPorts();
  return known.length > 0;
}

async function pickPort(): Promise<SerialPort> {
  if (cachedPort) return cachedPort;
  const known = await navigator.serial.getPorts();
  if (known.length > 0) {
    cachedPort = known[0];
    return cachedPort;
  }
  cachedPort = await navigator.serial.requestPort();
  return cachedPort;
}

/** Pide el puerto por primera vez -- tiene que llamarse desde un gesto del
 * usuario (click), el navegador exige eso para mostrar el selector. */
export async function connectScalePort(): Promise<void> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  cachedPort = null;
  cachedPortOpenBaud = null;
  await pickPort();
}

export function forgetScalePort(): void {
  cachedPort = null;
  cachedPortOpenBaud = null;
}

function checksum(bytes: number[]): [number, number] {
  const sum = bytes.reduce((acc, b) => (acc + b) & 0xff, 0);
  const high = (sum >> 4) & 0x0f;
  const low = sum & 0x0f;
  return [high + 0x30, low + 0x30];
}

function buildFrame(deviceType: string, equipmentId: string, commandNumber: string, data: string): Uint8Array {
  const body = [
    (deviceType || "C").charCodeAt(0),
    ...equipmentId.padStart(2, "0").split("").map((c) => c.charCodeAt(0)),
    ...commandNumber.padStart(4, "0").split("").map((c) => c.charCodeAt(0)),
    ...Array.from(data).map((c) => c.charCodeAt(0))
  ];
  const [checkHigh, checkLow] = checksum([STX, ...body]);
  return new Uint8Array([STX, ...body, checkHigh, checkLow, EOT]);
}

/** Texto a ASCII simple (sin acentos/ñ), ancho fijo -- estos protocolos de
 * balanza no soportan UTF-8 y esperan campos de ancho fijo con relleno. */
function fixedAscii(text: string, width: number): string {
  const ascii = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");
  return ascii.slice(0, width).padEnd(width, " ");
}

function fixedDigits(value: number, width: number): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return String(safeValue).slice(-width).padStart(width, "0");
}

async function ensureOpen(port: SerialPort, baudRate: number): Promise<void> {
  if (port.readable && port.writable && cachedPortOpenBaud === baudRate) return;
  if (port.readable || port.writable) {
    await port.close();
  }
  await port.open({ baudRate });
  cachedPortOpenBaud = baudRate;
}

async function writeFrame(port: SerialPort, frame: Uint8Array, baudRate: number): Promise<Uint8Array> {
  await ensureOpen(port, baudRate);

  const writer = port.writable!.getWriter();
  try {
    await writer.write(frame);
  } finally {
    writer.releaseLock();
  }

  const reader = port.readable!.getReader();
  try {
    const chunks: number[] = [];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) break;
      const result = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), timeLeft))
      ]);
      if (result.done) break;
      if (result.value) {
        chunks.push(...result.value);
        if (chunks.includes(EOT)) break;
      } else {
        break; // se agotó el tiempo de espera sin respuesta
      }
    }
    return new Uint8Array(chunks);
  } finally {
    reader.releaseLock();
  }
}

/** Una vez que el stream de lectura del puerto tira un error (ej. "Framing
 * error" -- un hipo físico del cable/adaptador) queda roto para cualquier
 * lectura futura hasta reabrir el puerto. En vez de que cada botón de la UI
 * tenga que saber esto, se reintenta acá una vez, cerrando y reabriendo. */
async function writeFrameResilient(port: SerialPort, frame: Uint8Array, baudRate: number): Promise<Uint8Array> {
  try {
    return await writeFrame(port, frame, baudRate);
  } catch (err) {
    try {
      await port.close();
    } catch {
      // ya estaba cerrado/roto -- no importa
    }
    cachedPortOpenBaud = null;
    try {
      return await writeFrame(port, frame, baudRate);
    } catch {
      throw err; // el reintento también falló -- devolver el error original
    }
  }
}

export interface ScalePingResult {
  ok: boolean;
  rawResponseHex: string;
  responseCode: string | null;
}

function toHex(response: Uint8Array): string {
  return Array.from(response).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** Según el formato de respuesta documentado (0x07 + tipo(1) + ID equipo(2)
 * + grupo/entidad(2) + código de respuesta(2) + datos + checksum(2) + EOT),
 * el código de respuesta está en las posiciones 6 y 7. Devuelve null si la
 * respuesta es más corta que eso (no llegó nada usable). */
function extractResponseCode(response: Uint8Array): string | null {
  if (response.length < 8) return null;
  return String.fromCharCode(response[6], response[7]);
}

const RESPONSE_CODE_LABELS: Record<string, string> = {
  "01": "OK -- comando ejecutado correctamente",
  "02": "comando inexistente en el equipo (funcionalidad no disponible)",
  "10": "error de checksum recibido por el equipo",
  "20": "cantidad de bytes incorrecta / modelo de datos inválido",
  "30": "registro inexistente",
  "31": "último registro leído",
  "40": "último registro borrado",
  "41": "no hay registros en el equipo",
  "50": "no hay registros para borrar",
  "60": "capacidad máxima superada, o falló la ejecución del comando"
};

export function describeResponseCode(code: string | null): string {
  if (code === null) return "sin respuesta";
  return RESPONSE_CODE_LABELS[code] ?? "código desconocido (no está en la tabla que tenemos)";
}

/** Comando 0001 (test de conexión) -- confirma que el cable y la velocidad
 * andan, antes de mandar un PLU real. */
export async function sendScalePing(): Promise<ScalePingResult> {
  const settings = getScaleSerialSettings();
  const port = await pickPort();
  const frame = buildFrame(settings.deviceType, settings.equipmentId, "0001", "");
  const response = await writeFrameResilient(port, frame, settings.baudRate);
  return {
    ok: response.length > 0,
    rawResponseHex: toHex(response),
    responseCode: extractResponseCode(response)
  };
}

/** Anchos reales de los 20 campos del comando 2005 (confirmados con 5002),
 * en orden. Se usa tanto para armar un PLU nuevo como para parsear uno
 * existente y preservar sus campos secundarios (ver buildPluFrame). */
const PLU_FIELD_WIDTHS = [6, 3, 3, 26, 26, 5, 1, 7, 6, 6, 6, 6, 6, 5, 5, 2, 4, 4, 4, 4];
const PRICE_FIELD_INDEX = 8; // "Precio", 0-indexed dentro de PLU_FIELD_WIDTHS

function splitPluFields(data: string): string[] {
  const values: string[] = [];
  let pos = 0;
  for (const width of PLU_FIELD_WIDTHS) {
    values.push(data.slice(pos, pos + width));
    pos += width;
  }
  return values;
}

/** Lee el PLU `pluDigits` (comando 5005, con la resta de 1 que compensa que
 * 5005 devuelve "el próximo mayor", no el argumento exacto -- ver más
 * abajo) y devuelve sus 20 campos ya separados, o null si no existe
 * ningún registro con ESE número exacto (5005 puede devolver otro
 * registro más adelante en la tabla si el pedido no existe; se descarta
 * si el Campo 01 del que vino no coincide con lo que se pidió). */
async function readExistingPluFields(port: SerialPort, settings: ScaleSerialSettings, pluDigits: number): Promise<string[] | null> {
  const argument = fixedDigits(pluDigits - 1, 6);
  const frame = buildFrame(settings.deviceType, settings.equipmentId, "5005", argument);
  const response = await writeFrameResilient(port, frame, settings.baudRate);
  if (extractResponseCode(response) !== "01") return null;
  const dataBytes = response.length > 10 ? response.slice(8, -3) : new Uint8Array();
  const dataStr = Array.from(dataBytes).map((b) => String.fromCharCode(b)).join("");
  const fields = splitPluFields(dataStr);
  if (Number(fields[0]) !== pluDigits) return null; // 5005 encontró otro registro distinto, no el pedido
  return fields;
}

/** Modelo de campos REAL del comando 2005, confirmado campo por campo
 * contra esta balanza con el comando 5002 (no asumido de ningún
 * documento). Total: 135 caracteres. Diferencias clave contra el protocolo
 * público de Kretz: Precio/Precio alternativo/Precio anterior son de 6
 * dígitos acá, no 7; y hay un campo 22 (4 dígitos) al final que el
 * documento no menciona -- los campos 20 y 21 están deshabilitados (ancho
 * 0) en esta balanza puntual, pero el 22 sí existe. El orden de nombres
 * (PLU, depto, familia, nombre, descripción, código, tipo, valor fijo,
 * precio, ...) coincide con el documento público -- confirmado leyendo un
 * PLU real con 5005 y viendo que decodifica limpio con este mismo orden.
 *
 * IMPORTANTE -- por qué esto lee antes de escribir: confirmado con pruebas
 * reales que 2005 puede IGNORAR silenciosamente la modificación de un PLU
 * que ya existía (cargado antes por iTegra) si los campos "secundarios"
 * (flag de posición decimal, código de etiqueta, campo 19, etc.) no
 * coinciden con lo que ya tenía -- aunque igual responda código "01". Por
 * eso, si el PLU ya existe, se lee primero (5005) y se preservan esos
 * campos tal cual estaban, cambiando solo nombre/descripción/precio/tipo.
 * Si el PLU es nuevo (nunca existió), se usan valores por defecto
 * razonables (0 decimales, ya que los precios de Patagonia OS son siempre
 * pesos enteros).
 * `descriptionOverride` es solo para casos puntuales -- el flujo normal
 * siempre manda el nombre del producto también como descripción, porque
 * Patagonia OS no tiene un campo de descripción separado. */
async function buildPluFrame(
  port: SerialPort,
  product: Product,
  deviceType: string,
  equipmentId: string,
  altaCommand: string,
  baudRate: number,
  descriptionOverride?: string
): Promise<Uint8Array> {
  // SIN desfasaje: Campo 01/06 = código de Patagonia OS tal cual. El "+1"
  // que se usó antes era un espejismo -- 5005 busca "el próximo PLU
  // ESTRICTAMENTE MAYOR al argumento" (nunca el argumento mismo), así que
  // pedir 5005(N) para verificar un registro que vive en N siempre salta a
  // N+1. Confirmado con datos reales nunca tocados por nosotros (PLU 509 =
  // "ARROLLADO DE CARNE" vive nativamente en el 509, no en el 510) y con
  // una prueba sintética (Campo 01 = 90001 sin ningún +1, verificado
  // correctamente con 5005 usando argumento 90000 = N-1).
  const pluDigits = Number(product.code);
  if (!Number.isFinite(pluDigits) || pluDigits > MAX_PLU_CODE) {
    // El campo "Código de PLU" de la balanza es de 5 dígitos -- un código
    // largo (ej. un EAN-13 de un producto envasado) se truncaría en vez de
    // mandarse, y podría pisar el PLU de otro producto sin aviso. Mejor
    // frenar acá que mandar un dato corrupto.
    throw new Error(`El código "${product.code}" de "${product.name}" es demasiado largo para ser un PLU de balanza (parece un EAN/código de barras, no un PLU corto).`);
  }

  const settings = { deviceType, equipmentId, altaCommand, baudRate };
  const existing = await readExistingPluFields(port, settings, pluDigits);

  const pluNumber = fixedDigits(pluDigits, 6);
  const pluCode = fixedDigits(pluDigits, 5);
  const name = fixedAscii(product.name, 26);
  const description = fixedAscii(descriptionOverride ?? product.name, 26);
  const type = product.unit === "kg" ? "P" : "N";
  const price = fixedDigits(product.priceRetail, 6);

  // Campos secundarios: si el PLU ya existía, se preservan tal cual venían
  // (índices según PLU_FIELD_WIDTHS: 1=depto, 2=familia, 7=valor fijo,
  // 9=precio alternativo, 10=flag decimal, 11-12=impuestos, 13-14=taras,
  // 15=etiqueta, 16-17=receta/nutricional, 18=campo19, 19=campo22). Si es
  // nuevo, se usan los mismos valores por defecto que ya veníamos usando.
  const departamento = existing?.[1] ?? fixedDigits(1, 3);
  const familia = existing?.[2] ?? fixedDigits(1, 3);
  const valorFijo = existing?.[7] ?? fixedDigits(0, 7);
  const precioAlternativo = existing?.[9] ?? fixedDigits(0, 6);
  const posicionDecimal = existing?.[10] ?? fixedDigits(2, 6); // 2 = 0 decimales
  const impuesto1 = existing?.[11] ?? fixedDigits(0, 6);
  const impuesto2 = existing?.[12] ?? fixedDigits(0, 6);
  const taraPreempaque = existing?.[13] ?? fixedDigits(0, 5);
  const taraPublico = existing?.[14] ?? fixedDigits(0, 5);
  const codigoEtiqueta = existing?.[15] ?? fixedDigits(0, 2);
  const codigoReceta = existing?.[16] ?? fixedDigits(0, 4);
  const codigoNutricional = existing?.[17] ?? fixedDigits(0, 4);
  const campo19 = existing?.[18] ?? fixedDigits(0, 4);
  const campo22 = existing?.[19] ?? fixedDigits(0, 4);

  const data =
    `${pluNumber}${departamento}${familia}${name}${description}${pluCode}${type}${valorFijo}` +
    `${price}${precioAlternativo}${posicionDecimal}${impuesto1}${impuesto2}${taraPreempaque}${taraPublico}` +
    `${codigoEtiqueta}${codigoReceta}${codigoNutricional}${campo19}${campo22}`;

  if (data.length !== 135) {
    // No debería pasar nunca (fixedAscii/fixedDigits siempre devuelven el
    // ancho pedido) -- si pasa, hay un bug real y no hay que mandar nada.
    throw new Error(`Payload de PLU inválido para "${product.name}" (código ${product.code}): se esperaban 135 caracteres y se generaron ${data.length}.`);
  }

  return buildFrame(deviceType, equipmentId, altaCommand, data);
}

export interface ScalePluWriteResult {
  rawResponseHex: string;
  responseCode: string | null;
}

/** Manda un solo producto a la balanza (comando 2005). */
export async function syncOneProductToScale(product: Product, _categories: ProductCategory[]): Promise<ScalePluWriteResult> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  const settings = getScaleSerialSettings();
  const port = await pickPort();
  const frame = await buildPluFrame(port, product, settings.deviceType, settings.equipmentId, settings.altaCommand, settings.baudRate);
  const response = await writeFrameResilient(port, frame, settings.baudRate);
  return { rawResponseHex: toHex(response), responseCode: extractResponseCode(response) };
}

export interface ScalePluDeleteResult {
  rawResponseHex: string;
  responseCode: string | null;
}

/** Comando 3005 (borrar un PLU). Riesgo real: borra el PLU de la balanza --
 * pensado para códigos de prueba, no para productos reales que el negocio
 * esté usando en el mostrador ahora mismo.
 * SIN VERIFICAR si 3005 tiene el mismo desfasaje "próximo mayor" que 5005
 * (no se lo volvió a probar después de descubrir eso) -- manda el código
 * tal cual, igual que antes. Si algún borrado parece no afectar el PLU
 * esperado, puede ser la misma causa: confirmar con "Leer este PLU" antes
 * y después de borrar. */
export async function deleteScalePlu(pluCode: string): Promise<ScalePluDeleteResult> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  const settings = getScaleSerialSettings();
  const port = await pickPort();
  const pluNumber = fixedDigits(Number(pluCode) || 0, 6);
  const frame = buildFrame(settings.deviceType, settings.equipmentId, "3005", pluNumber);
  const response = await writeFrameResilient(port, frame, settings.baudRate);
  return { rawResponseHex: toHex(response), responseCode: extractResponseCode(response) };
}

export interface ScalePluReadResult {
  rawResponseHex: string;
  responseCode: string | null;
  /** Los bytes de datos de la respuesta (entre el código de respuesta y el
   * checksum) decodificados como ASCII imprimible -- sirve para chequear
   * desde la PC qué tiene grabado un PLU sin ir hasta la balanza. */
  rawDataAscii: string;
}

/** Comando 5005 (leer PLU) -- para verificar desde la PC qué quedó grabado
 * en un PLU sin ir hasta la balanza cada vez.
 * 5005 no busca el argumento exacto: devuelve el primer PLU existente
 * ESTRICTAMENTE MAYOR al argumento (nunca el argumento mismo). Para leer el
 * PLU que realmente pediste (`pluCode`), acá se manda `pluCode - 1` como
 * argumento -- así la función devuelve, en el caso normal, el contenido de
 * `pluCode` mismo (siempre que no haya otro PLU intermedio entre los dos,
 * lo cual no puede pasar tratándose de números enteros consecutivos). */
export async function readScalePlu(pluCode: string): Promise<ScalePluReadResult> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  const settings = getScaleSerialSettings();
  const port = await pickPort();
  const pluNumber = fixedDigits((Number(pluCode) || 0) - 1, 6);
  const frame = buildFrame(settings.deviceType, settings.equipmentId, "5005", pluNumber);
  const response = await writeFrameResilient(port, frame, settings.baudRate);
  const dataBytes = response.length > 10 ? response.slice(8, -3) : new Uint8Array();
  const rawDataAscii = Array.from(dataBytes).map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
  return { rawResponseHex: toHex(response), responseCode: extractResponseCode(response), rawDataAscii };
}

async function readPluRaw(port: SerialPort, settings: ScaleSerialSettings, pluDigits: number): Promise<{ responseCode: string | null; fields: string[] | null }> {
  const argument = fixedDigits(pluDigits - 1, 6);
  const frame = buildFrame(settings.deviceType, settings.equipmentId, "5005", argument);
  const response = await writeFrameResilient(port, frame, settings.baudRate);
  const responseCode = extractResponseCode(response);
  if (responseCode !== "01") return { responseCode, fields: null };
  const dataBytes = response.length > 10 ? response.slice(8, -3) : new Uint8Array();
  const dataStr = Array.from(dataBytes).map((b) => String.fromCharCode(b)).join("");
  const fields = splitPluFields(dataStr);
  if (Number(fields[0]) !== pluDigits) return { responseCode, fields: null };
  return { responseCode, fields };
}

/** PLU alto, fuera de cualquier catálogo real de un cliente, usado
 * exclusivamente por checkScaleCompatibility como zona de prueba
 * descartable. */
const COMPATIBILITY_TEST_PLU = 99999;

export interface ScaleCompatibilityResult {
  pingOk: boolean;
  pingResponseCode: string | null;
  testPluCode: number;
  aborted: boolean;
  writeResponseCode: string | null;
  readResponseCode: string | null;
  fieldsMatch: boolean;
  deleteResponseCode: string | null;
  compatible: boolean;
  message: string;
}

/** Prueba si ESTA balanza puntual habla el mismo protocolo que la Report
 * LT contra la que se confirmó todo (ver el comentario del encabezado del
 * archivo). No confía en el modelo/nombre de la balanza ni en ninguna
 * documentación pública -- ya se demostró una vez que el documento
 * público de Kretz no coincidía con los anchos de campo reales de la
 * Report LT usada acá. En cambio, hace la prueba real: escribe un PLU
 * sintético en una zona alta (99999, fuera de cualquier catálogo real),
 * lo relee, compara byte a byte contra lo que se mandó, y lo borra de
 * nuevo para no dejar nada cargado. Si coincide exacto, el modelo de
 * campos que usa buildPluFrame (PLU_FIELD_WIDTHS) es el correcto para
 * esta balanza y el envío masivo debería funcionar igual que en la
 * balanza ya confirmada -- sin tener que tocar código. */
export async function checkScaleCompatibility(): Promise<ScaleCompatibilityResult> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  const settings = getScaleSerialSettings();
  const port = await pickPort();

  const pingFrame = buildFrame(settings.deviceType, settings.equipmentId, "0001", "");
  const pingResponse = await writeFrameResilient(port, pingFrame, settings.baudRate);
  const pingResponseCode = extractResponseCode(pingResponse);
  const pingOk = pingResponse.length > 0;

  if (!pingOk) {
    return {
      pingOk, pingResponseCode, testPluCode: COMPATIBILITY_TEST_PLU, aborted: true,
      writeResponseCode: null, readResponseCode: null, fieldsMatch: false, deleteResponseCode: null,
      compatible: false,
      message: "La balanza no respondió al comando de test de conexión (0001). Revisá el cable, el puerto y la velocidad configurada antes de probar de nuevo."
    };
  }

  const before = await readPluRaw(port, settings, COMPATIBILITY_TEST_PLU);
  if (before.fields) {
    return {
      pingOk, pingResponseCode, testPluCode: COMPATIBILITY_TEST_PLU, aborted: true,
      writeResponseCode: null, readResponseCode: before.responseCode, fieldsMatch: false, deleteResponseCode: null,
      compatible: false,
      message: `No se pudo probar: ya existe un producto real cargado en el código ${COMPATIBILITY_TEST_PLU} de esta balanza -- se frenó para no arriesgarse a pisarlo.`
    };
  }

  const pluNumber = fixedDigits(COMPATIBILITY_TEST_PLU, 6);
  const pluCodeStr = fixedDigits(COMPATIBILITY_TEST_PLU, 5);
  const testName = fixedAscii("PRUEBA PATAGONIA", 26);
  const testFields = [
    pluNumber, fixedDigits(1, 3), fixedDigits(1, 3), testName, testName, pluCodeStr, "N", fixedDigits(0, 7),
    fixedDigits(12345, 6), fixedDigits(0, 6), fixedDigits(2, 6), fixedDigits(0, 6), fixedDigits(0, 6),
    fixedDigits(0, 5), fixedDigits(0, 5), fixedDigits(0, 2), fixedDigits(0, 4), fixedDigits(0, 4),
    fixedDigits(0, 4), fixedDigits(0, 4)
  ];
  const data = testFields.join("");
  if (data.length !== 135) {
    throw new Error(`Error interno armando la trama de prueba: ${data.length} caracteres en vez de 135.`);
  }

  const writeResponse = await writeFrameResilient(port, buildFrame(settings.deviceType, settings.equipmentId, settings.altaCommand, data), settings.baudRate);
  const writeResponseCode = extractResponseCode(writeResponse);

  if (writeResponseCode !== "01") {
    return {
      pingOk, pingResponseCode, testPluCode: COMPATIBILITY_TEST_PLU, aborted: false,
      writeResponseCode, readResponseCode: null, fieldsMatch: false, deleteResponseCode: null,
      compatible: false,
      message: `La balanza respondió código "${writeResponseCode}" (${describeResponseCode(writeResponseCode)}) al cargar el PLU de prueba -- no es compatible con el formato que usamos. Por ahora, cargar productos en esta balanza con iTegra.`
    };
  }

  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await readPluRaw(port, settings, COMPATIBILITY_TEST_PLU);
  const fieldsMatch = after.fields !== null && after.fields.join("") === testFields.join("");

  const deleteResponse = await writeFrameResilient(port, buildFrame(settings.deviceType, settings.equipmentId, "3005", pluNumber), settings.baudRate);
  const deleteResponseCode = extractResponseCode(deleteResponse);

  const compatible = fieldsMatch;
  const message = compatible
    ? "Compatible: se cargó un producto de prueba, se releyó tal cual se mandó, y se borró de nuevo. El envío masivo debería funcionar igual que en la balanza ya confirmada."
    : after.fields === null
      ? `No compatible: se pudo cargar el PLU de prueba, pero al releerlo la balanza respondió código "${after.responseCode}" (${describeResponseCode(after.responseCode)}) en vez de devolverlo. El formato de esta balanza no es el que usamos.`
      : "No compatible: se releyó el PLU de prueba pero los datos no coinciden con lo que se mandó -- el orden o ancho de los campos de esta balanza es distinto al que usamos.";

  return { pingOk, pingResponseCode, testPluCode: COMPATIBILITY_TEST_PLU, aborted: false, writeResponseCode, readResponseCode: after.responseCode, fieldsMatch, deleteResponseCode, compatible, message };
}

/** Ancho real del campo "Código de PLU" (5 dígitos, confirmado con el
 * comando 5002) -- es el más chico de los dos campos que llevan el número
 * de PLU (el otro, "Número de PLU", es de 6), así que es el límite real:
 * el código de Patagonia OS más alto representable sin truncar. */
const MAX_PLU_CODE = 99999;

export interface ScaleSyncPlan {
  toSend: Product[];
  skipped: { product: Product; reason: string }[];
  /** Productos inactivos -- ni se evalúan, page.active los filtra en
   * inventory-service (products acá ya viene sin bajas si corresponde),
   * pero se cuentan aparte para que enviados + salteados + inactivos dé
   * exactamente el total de productos. */
  inactive: Product[];
}

/** Decide qué productos activos calificarían para el envío masivo, sin
 * tocar la balanza -- misma regla que usa syncProductsToScale, expuesta
 * aparte para poder mostrar una vista previa antes de mandar nada.
 *
 * El campo "Código de PLU" de la balanza es de solo 5 dígitos -- un código
 * de Patagonia OS que sea en realidad un EAN-13 (código de barras de un
 * producto envasado, no un PLU corto pensado para pesar) no entra ahí. Si
 * se truncara en vez de rechazarse, dos productos con EANs distintos
 * podrían terminar pisándose el mismo PLU en la balanza sin ningún aviso
 * -- por eso se saltean en vez de mandarse truncados. También se detecta y
 * bloquea cualquier colisión real (dos productos que, después de sumarle 1
 * al código, terminarían apuntando al mismo PLU interno). */
export function planScaleSync(products: Product[]): ScaleSyncPlan {
  const inactive = products.filter((p) => !(p.active ?? true));
  const active = products.filter((p) => p.active ?? true);
  const skipped: { product: Product; reason: string }[] = [];
  const candidates: Product[] = [];

  for (const product of active) {
    if (!/^\d+$/.test(product.code)) {
      skipped.push({ product, reason: "El código no es puramente numérico -- no se puede usar como PLU de balanza." });
    } else if (!Number.isFinite(product.priceRetail) || product.priceRetail < 0) {
      skipped.push({ product, reason: "El precio no es un número válido." });
    } else if (Number(product.code) > MAX_PLU_CODE) {
      skipped.push({ product, reason: `El código es demasiado largo para ser un PLU de balanza (parece un EAN/código de barras) -- el campo de la balanza solo admite hasta ${MAX_PLU_CODE}.` });
    } else {
      candidates.push(product);
    }
  }

  // Detectar colisiones: dos productos distintos que terminarían con el
  // mismo PLU interno se sacan los dos, en vez de dejar que uno pise
  // silenciosamente el registro del otro en la balanza. Con el código tal
  // cual (sin +1) esto solo puede pasar si dos productos ya comparten el
  // mismo código en Patagonia OS -- un problema de datos previo, no del
  // envío a la balanza -- pero se chequea igual como red de seguridad.
  const byPlu = new Map<number, Product[]>();
  for (const product of candidates) {
    const plu = Number(product.code);
    const group = byPlu.get(plu) ?? [];
    group.push(product);
    byPlu.set(plu, group);
  }

  const toSend: Product[] = [];
  for (const [plu, group] of byPlu) {
    if (group.length > 1) {
      for (const product of group) {
        skipped.push({ product, reason: `Colisión de PLU interno (${plu}) con otro producto: ${group.filter((p) => p.id !== product.id).map((p) => `${p.name} (${p.code})`).join(", ")}.` });
      }
    } else {
      toSend.push(group[0]);
    }
  }

  return { toSend, skipped, inactive };
}

export interface ScaleSyncResult {
  attempted: number;
  /** Productos salteados antes de mandar nada -- código no numérico o
   * precio inválido -- para no arriesgarse a mandar un PLU con datos
   * corruptos que rompa el registro de otro producto. */
  skipped: { product: Product; reason: string }[];
  noResponse: { product: Product }[];
  /** Errores de bajo nivel del puerto (ej. "Framing error") -- un hipo del
   * cable en un producto no debe tirar abajo el envío del resto del
   * catálogo. */
  transportErrors: { product: Product; message: string }[];
  /** Cuenta de intentos por código de respuesta real de la balanza -- "01" es
   * éxito confirmado (probado a fondo: grabó y se pudo releer); cualquier
   * otro código es un rechazo real (ver describeResponseCode). */
  responseCodeCounts: Record<string, number>;
  /** Detalle por producto de los que NO dieron "01", para poder identificar
   * cuáles hay que revisar a mano en vez de solo ver un conteo agregado. */
  failed: { product: Product; responseCode: string | null }[];
}

/** Manda el catálogo completo a la balanza por PLU (comando 2005), uno por
 * uno, esperando la respuesta de cada uno antes de mandar el siguiente
 * (nunca en paralelo -- la balanza es un dispositivo serie, de a uno).
 * Salta productos con código no numérico o precio inválido, y sigue con el
 * resto si un producto puntual falla (por rechazo de la balanza o por un
 * hipo de conexión) en vez de frenar todo el envío. */
export async function syncProductsToScale(
  products: Product[],
  categories: ProductCategory[],
  onProgress?: (done: number, total: number) => void
): Promise<ScaleSyncResult> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  const settings = getScaleSerialSettings();
  const port = await pickPort();

  const { toSend, skipped } = planScaleSync(products);

  const noResponse: { product: Product }[] = [];
  const transportErrors: { product: Product; message: string }[] = [];
  const responseCodeCounts: Record<string, number> = {};
  const failed: { product: Product; responseCode: string | null }[] = [];

  for (let i = 0; i < toSend.length; i++) {
    const product = toSend[i];
    try {
      const frame = await buildPluFrame(port, product, settings.deviceType, settings.equipmentId, settings.altaCommand, settings.baudRate);
      const response = await writeFrameResilient(port, frame, settings.baudRate);

      const code = extractResponseCode(response);
      if (code === null) {
        noResponse.push({ product });
      } else {
        responseCodeCounts[code] = (responseCodeCounts[code] ?? 0) + 1;
        if (code !== "01") failed.push({ product, responseCode: code });
      }
    } catch (err) {
      // Un hipo puntual del cable/puerto (ej. "Framing error"), o un
      // payload inválido de un producto puntual -- no debe frenar el envío
      // del resto del catálogo. Una vez que el stream del puerto tira un
      // error queda roto para cualquier lectura futura hasta reabrirlo, así
      // que se fuerza a cerrar/reabrir antes de seguir con el próximo.
      transportErrors.push({ product, message: err instanceof Error ? err.message : String(err) });
      try {
        await port.close();
      } catch {
        // ya estaba cerrado/roto -- no importa, el próximo ensureOpen lo reabre igual
      }
      cachedPortOpenBaud = null;
    }
    onProgress?.(i + 1, toSend.length);
  }

  return { attempted: toSend.length, skipped, noResponse, transportErrors, responseCodeCounts, failed };
}
