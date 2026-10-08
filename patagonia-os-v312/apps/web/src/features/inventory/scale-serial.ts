import type { Product } from "@patagonia/domain";
import { STAGE_LABELS, runKretzDiscovery, saveDiagnosticRecord, savePluScan, scanAllPlus, type DiagnosticRecord, type DiscoveryVerdict, type PluScan } from "./kretz/discovery";
import { runAuraWriteTest, saveAuraWriteTest, type AuraWriteTestResult } from "./kretz/aura-write-test";
import { runAuraModelProbe, saveModelProbe, type ModelProbeResult } from "./kretz/aura-model-probe";
import { readAuraList, runAuraSync, setAuraItemBarcodes, type AuraItemBarcodeResult, type AuraSyncItem, type AuraSyncResult } from "./kretz/aura-sync";
import { getKretzModel, getSavedModelId } from "./kretz/models";
import { buildKretzFrame, describeKretzCode } from "./kretz/kretz-frame";

/** Lo mínimo que hace falta de un producto para mandarlo a la balanza --
 * no el `Product` completo de @patagonia/domain. Así esta función sirve
 * tanto desde Stock (que tiene el producto entero, con costo) como desde
 * la pantalla de Productos del cajero (que solo carga nombre/precio,
 * nunca costo -- ver products-service.ts). Cualquier `Product` real ya
 * cumple esta forma sin cambios, de sobra. */
export interface ScaleSyncableProduct {
  id: string;
  code: string;
  name: string;
  unit: Product["unit"];
  priceRetail: number;
  active?: boolean;
}

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
 *   checksum, y el resto según el documento público de Kretz (ver
 *   kretz/kretz-frame.ts): solo "01" se usa para decidir algo.
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
  /** Bits de stop: 1 en la Report LT; 2 en la Kretz Aura Eco (manual, sección 16.5). */
  stopBits: 1 | 2;
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

export const DEFAULT_SCALE_SERIAL_SETTINGS: ScaleSerialSettings = { baudRate: 115200, stopBits: 1, equipmentId: "01", deviceType: "C", altaCommand: "2005" };

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
let cachedPortOpenKey: string | null = null;
/** Tiempo de espera de la respuesta; la detección automática lo baja para probar rápido. */
let frameTimeoutMs = 2000;

export async function isScalePortPaired(): Promise<boolean> {
  if (!isScaleSerialSupported()) return false;
  if (cachedPort) return true;
  const known = await navigator.serial.getPorts();
  return known.length > 0;
}

const PORT_INFO_KEY = "patagonia-scale-serial-port";

function portInfoKey(port: SerialPort): string {
  try {
    const info = port.getInfo?.() ?? {};
    return `${info.usbVendorId ?? "-"}:${info.usbProductId ?? "-"}`;
  } catch {
    return "-:-";
  }
}

async function pickPort(): Promise<SerialPort> {
  if (cachedPort) return cachedPort;
  const known = await navigator.serial.getPorts();
  if (known.length > 0) {
    // Si la PC tiene permiso para más de un puerto, usar el que la persona
    // eligió la última vez (no el primero de la lista, que puede ser otro aparato).
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(PORT_INFO_KEY);
    } catch {
      // sin localStorage: se usa el primero
    }
    cachedPort = (remembered && known.find((p) => portInfoKey(p) === remembered)) || known[0];
    return cachedPort;
  }
  cachedPort = await navigator.serial.requestPort();
  return cachedPort;
}

/** Abre SIEMPRE el selector de puertos del navegador (tiene que llamarse desde
 * un click). Antes, si la PC ya tenía permiso para algún puerto, agarraba el
 * primero sin preguntar: con dos aparatos serie no había forma de elegir el de
 * la balanza (caso real, primera Aura de un cliente, 2026-10-01). */
export async function connectScalePort(): Promise<void> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  const previous = cachedPort;
  const port = await navigator.serial.requestPort();
  if (previous && previous !== port && (previous.readable || previous.writable)) {
    try {
      await previous.close();
    } catch {
      // ya estaba cerrado
    }
  }
  cachedPort = port;
  cachedPortOpenKey = null;
  try {
    localStorage.setItem(PORT_INFO_KEY, portInfoKey(port));
  } catch {
    // no crítico
  }
}

const USB_SERIAL_CHIPS: Record<number, string> = {
  0x1a86: "CH340",
  0x067b: "Prolific PL2303",
  0x0403: "FTDI",
  0x10c4: "Silicon Labs CP210x"
};

/** Qué puerto está elegido, en palabras (para la pantalla y para soporte). */
export function describeScalePort(port: SerialPort | null): string {
  if (!port) return "ninguno";
  let info: SerialPortInfo = {};
  try {
    info = port.getInfo?.() ?? {};
  } catch {
    // sin info
  }
  if (info.usbVendorId === undefined) return "un puerto serie que no es USB (puerto COM de la PC o uno virtual, por ejemplo Bluetooth)";
  const chip = USB_SERIAL_CHIPS[info.usbVendorId];
  const ids = `${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
  return chip ? `adaptador USB a serie ${chip} (${ids})` : `aparato USB ${ids}`;
}

export async function getScalePortDescription(): Promise<string | null> {
  if (!isScaleSerialSupported()) return null;
  if (cachedPort) return describeScalePort(cachedPort);
  const known = await navigator.serial.getPorts();
  if (known.length === 0) return null;
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(PORT_INFO_KEY);
  } catch {
    // nada
  }
  return describeScalePort((remembered && known.find((p) => portInfoKey(p) === remembered)) || known[0]);
}

export function forgetScalePort(): void {
  cachedPort = null;
  cachedPortOpenKey = null;
}

// La balanza se enchufa solo para pasar precios y después se desenchufa: al
// desenchufarla, el puerto guardado queda muerto. Se olvida acá para que al
// volver a enchufarla el próximo envío tome el puerto nuevo, sin recargar la página.
if (isScaleSerialSupported()) {
  navigator.serial.addEventListener("disconnect", (event) => {
    if (event.target === cachedPort) forgetScalePort();
  });
}

/** La trama Kretz vive en kretz/kretz-frame.ts (documentada y testeada); acá se reusa. */
function buildFrame(deviceType: string, equipmentId: string, commandNumber: string, data: string): Uint8Array {
  return buildKretzFrame(deviceType, equipmentId, commandNumber, data);
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
  const stopBits = getScaleSerialSettings().stopBits;
  const key = `${baudRate}/${stopBits}`;
  if (port.readable && port.writable && cachedPortOpenKey === key) return;
  if (port.readable || port.writable) {
    await port.close();
  }
  await port.open({ baudRate, dataBits: 8, stopBits, parity: "none" });
  cachedPortOpenKey = key;
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
    const deadline = Date.now() + frameTimeoutMs;
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
    cachedPortOpenKey = null;
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

// Tabla del documento público de Kretz (antes había otra, corrida, sin fuente; solo "01" decide algo).
export function describeResponseCode(code: string | null): string {
  return describeKretzCode(code);
}

export interface ScaleAutoDetectResult {
  found: boolean;
  settings?: ScaleSerialSettings;
  rawResponseHex?: string;
  attempts: number;
}

/**
 * Detección automática: prueba el test de conexión (comando 0001) con las
 * combinaciones de velocidad / bits de stop / letra de equipo / ID que usan las
 * balanzas Kretz, hasta que alguna responda algo. Guarda la que anduvo. La
 * Report LT usa 115200 con 1 bit de stop; la Aura Eco usa 9600 con 2 (manual,
 * sección 16.5) y tiene que estar en el menú COMUNI → MODO = "Datos".
 */
export async function autoDetectScale(onProgress: (text: string) => void, shouldStop: () => boolean = () => false): Promise<ScaleAutoDetectResult> {
  const port = await pickPort();
  const previousTimeout = frameTimeoutMs;
  frameTimeoutMs = 800;
  try {
    return await autoDetectScaleWith(port, onProgress, () => {}, shouldStop);
  } finally {
    frameTimeoutMs = previousTimeout;
  }
}

async function autoDetectScaleWith(
  port: SerialPort,
  onProgress: (text: string) => void,
  onResponse: (response: Uint8Array) => void,
  shouldStop: () => boolean = () => false
): Promise<ScaleAutoDetectResult> {
  const original = getScaleSerialSettings();

  const links: { baudRate: number; stopBits: 1 | 2 }[] = [
    { baudRate: 9600, stopBits: 2 },
    { baudRate: 9600, stopBits: 1 },
    { baudRate: 115200, stopBits: 1 },
    { baudRate: 19200, stopBits: 1 },
    { baudRate: 38400, stopBits: 1 },
    { baudRate: 57600, stopBits: 1 },
    { baudRate: 4800, stopBits: 1 },
    { baudRate: 19200, stopBits: 2 },
    { baudRate: 115200, stopBits: 2 }
  ];
  const attempts: ScaleSerialSettings[] = [];
  for (const link of links) attempts.push({ ...original, ...link, deviceType: "C", equipmentId: "01" });
  for (const link of links.slice(0, 3)) {
    for (const deviceType of ["A", "B", "D", "E", "K"]) attempts.push({ ...original, ...link, deviceType, equipmentId: "01" });
    for (const equipmentId of ["00", "02"]) attempts.push({ ...original, ...link, deviceType: "C", equipmentId });
  }

  // El tiempo de espera de cada intento lo fija quien llama (frameTimeoutMs).
  let count = 0;
  {
    for (const candidate of attempts) {
      if (shouldStop()) break;
      count++;
      onProgress(`Probando modo datos ${count}/${attempts.length}: ${candidate.baudRate} baudios, ${candidate.stopBits} bit(s) de stop, equipo "${candidate.deviceType}${candidate.equipmentId}"…`);
      saveScaleSerialSettings(candidate);
      cachedPortOpenKey = null;
      try {
        const frame = buildFrame(candidate.deviceType, candidate.equipmentId, "0001", "");
        const response = await writeFrame(port, frame, candidate.baudRate);
        onResponse(response);
        // Solo vale una respuesta con forma de respuesta Kretz: una balanza en
        // modo continuo de peso (o ruido a otra velocidad) también "manda algo".
        if (isKretzResponse(response)) {
          return { found: true, settings: candidate, rawResponseHex: toHex(response), attempts: count };
        }
      } catch {
        // un error de lectura en esta combinación no impide probar la siguiente
        cachedPortOpenKey = null;
      }
    }
    saveScaleSerialSettings(original);
    return { found: false, attempts: count };
  }
}

/** Respuesta con forma de respuesta Kretz: arranca con 0x07 y termina en EOT. */
export function isKretzResponse(response: Uint8Array): boolean {
  return response.length >= 8 && response[0] === 0x07 && response.includes(EOT);
}

export type ScaleLinkVerdict = DiscoveryVerdict;

export interface ScaleLinkDiagnosis {
  verdict: ScaleLinkVerdict;
  portLabel: string;
  /** Peso leído en modo "A pedido de peso" / continuo (9600, 2 bits de stop). */
  weightKg: number | null;
  /** Lo que llegó en la prueba de peso, tal cual (para soporte). */
  weightRaw: string;
  /** Datos: configuración que contestó como balanza Kretz. */
  dataSettings: ScaleSerialSettings | null;
  dataResponseHex: string;
  /** Llegó algún byte en alguna de las pruebas (entonces el cable transmite). */
  anyBytes: boolean;
  attempts: number;
  message: string;
  /** Registro completo (cada byte que se mandó y que volvió). */
  record: DiagnosticRecord;
}

/**
 * "Probar todo": en un click dice si el problema es el cable/puerto o el modo
 * de la balanza, y deja guardado un registro completo para soporte. Delega en
 * kretz/discovery.ts, que es SOLO DE LECTURA (nunca escribe en la balanza).
 * Primera Kretz Aura real de un cliente: 2026-10-01.
 */
export async function diagnoseScaleLink(
  onProgress: (text: string) => void,
  options: { frameTimeoutMs?: number; listenMs?: number; modelId?: string; balanceNumber?: string; releaseOtherTabs?: boolean; openTries?: number } = {}
): Promise<ScaleLinkDiagnosis> {
  const model = getKretzModel(options.modelId ?? getSavedModelId());
  const port = await pickPort();
  const portLabel = describeScalePort(port);
  cachedPortOpenKey = null;
  const portsSeen = (await navigator.serial.getPorts()).map((p) => describeScalePort(p));
  const record = await runKretzDiscovery(port, portLabel, model, {
    portsSeen,
    releaseOtherTabs: options.releaseOtherTabs,
    openTries: options.openTries,
    balanceNumber: options.balanceNumber,
    frameTimeoutMs: options.frameTimeoutMs,
    listenMs: options.listenMs,
    onProgress
  });
  cachedPortOpenKey = null;
  saveDiagnosticRecord(record);

  let dataSettings: ScaleSerialSettings | null = null;
  if (record.responder) {
    dataSettings = {
      ...getScaleSerialSettings(),
      baudRate: record.responder.link.baudRate,
      stopBits: record.responder.link.stopBits,
      deviceType: record.responder.deviceType,
      equipmentId: record.responder.equipmentId
    };
    saveScaleSerialSettings(dataSettings);
  }
  const answered = record.exchanges.find((e) => e.kretz);
  return {
    verdict: record.verdict,
    portLabel,
    weightKg: record.weight.kg,
    weightRaw: record.weight.raw,
    dataSettings,
    dataResponseHex: answered?.rx ?? "",
    anyBytes: record.anyBytes,
    attempts: record.exchanges.length + 1,
    message: diagnosisMessage(record, model.id, portLabel),
    record
  };
}

/** Lee todos los PLU guardados en la balanza (solo lectura) con la configuración que encontró "Probar todo". Queda como copia de seguridad. */
export async function scanScalePlus(onProgress: (text: string) => void, shouldStop: () => boolean): Promise<PluScan> {
  const settings = getScaleSerialSettings();
  const port = await pickPort();
  cachedPortOpenKey = null;
  const scan = await scanAllPlus(
    port,
    { link: { baudRate: settings.baudRate, stopBits: settings.stopBits }, deviceType: settings.deviceType, equipmentId: settings.equipmentId },
    getSavedModelId(),
    { onProgress, shouldStop }
  );
  cachedPortOpenKey = null;
  savePluScan(scan);
  return scan;
}

/** Prueba de escritura de UN producto en la Aura (PLU libre), con la configuración que encontró "Probar todo". Ver kretz/aura-write-test.ts. */
export async function runAuraWriteTestOnScale(onProgress: (text: string) => void): Promise<AuraWriteTestResult> {
  const settings = getScaleSerialSettings();
  const port = await pickPort();
  cachedPortOpenKey = null;
  const result = await runAuraWriteTest(
    port,
    { link: { baudRate: settings.baudRate, stopBits: settings.stopBits }, deviceType: settings.deviceType, equipmentId: settings.equipmentId },
    { onProgress }
  );
  cachedPortOpenKey = null;
  saveAuraWriteTest(result);
  return result;
}

/** Diagnóstico del modelo de datos de la Aura (SOLO LECTURA), con la configuración que encontró "Probar todo". Ver kretz/aura-model-probe.ts. */
export async function runAuraModelProbeOnScale(onProgress: (text: string) => void): Promise<ModelProbeResult> {
  const settings = getScaleSerialSettings();
  const port = await pickPort();
  cachedPortOpenKey = null;
  // Si todavía no se hizo "Probar todo" en esta PC, se usa la configuración ya comprobada de la Aura (H01, 9600, 2 bits de stop).
  const aura = settings.deviceType === "H" ? settings : { ...settings, baudRate: 9600, stopBits: 2 as const, deviceType: "H", equipmentId: "01" };
  const result = await runAuraModelProbe(
    port,
    { link: { baudRate: aura.baudRate, stopBits: aura.stopBits }, deviceType: aura.deviceType, equipmentId: aura.equipmentId },
    { onProgress }
  );
  cachedPortOpenKey = null;
  saveModelProbe(result);
  return result;
}

/** Configuración de la Aura: la que encontró "Probar todo" o, si no, la comprobada en la Aura real (H01, 9600, 2 bits de stop). */
function auraResponder() {
  const settings = getScaleSerialSettings();
  const aura = settings.deviceType === "H" ? settings : { ...settings, baudRate: 9600, stopBits: 2 as const, deviceType: "H", equipmentId: "01" };
  return { link: { baudRate: aura.baudRate, stopBits: aura.stopBits }, deviceType: aura.deviceType, equipmentId: aura.equipmentId };
}

/** Aura: lee todos los productos de la balanza (SOLO LECTURA). Ver kretz/aura-sync.ts. */
export async function readAuraListOnScale(onProgress: (text: string) => void) {
  const port = await pickPort();
  cachedPortOpenKey = null;
  const r = await readAuraList(port, auraResponder(), { onProgress });
  cachedPortOpenKey = null;
  return r;
}

/** Aura: manda el plan armado con planAuraSync (relee cada producto y frena ante cualquier diferencia). Ver kretz/aura-sync.ts. */
export async function runAuraSyncOnScale(plan: AuraSyncItem[], onProgress: (text: string) => void, shouldStop: () => boolean, configureBarcode = false): Promise<AuraSyncResult> {
  const port = await pickPort();
  cachedPortOpenKey = null;
  const r = await runAuraSync(port, auraResponder(), plan, { onProgress, shouldStop, configureBarcode });
  cachedPortOpenKey = null;
  return r;
}

/** Aura: activa o apaga el código de barras por producto en los tickets (1080). Ver kretz/aura-sync.ts. */
export async function setAuraItemBarcodesOnScale(enable: boolean, onProgress: (text: string) => void): Promise<AuraItemBarcodeResult> {
  const port = await pickPort();
  cachedPortOpenKey = null;
  const r = await setAuraItemBarcodes(port, auraResponder(), enable, { onProgress });
  cachedPortOpenKey = null;
  return r;
}

/** Resumen por etapa: dónde se cortó la comunicación. */
export function stagesSummary(r: DiagnosticRecord): string {
  if (!r.stages) return "";
  const icon = { ok: "✅", falla: "❌", no_llego: "⏸" } as const;
  return r.stages.map((s, i) => `${icon[s.status]} ${i + 1}. ${STAGE_LABELS[s.id]}${s.detail ? `: ${s.detail}` : s.status === "no_llego" ? ": no se llegó a esta etapa" : ""}`).join("\n");
}

function diagnosisMessage(r: DiagnosticRecord, modelId: string, portLabel: string): string {
  const base = diagnosisVerdictMessage(r, modelId, portLabel);
  const stages = stagesSummary(r);
  return stages ? `${base}

Etapas:
${stages}` : base;
}

function diagnosisVerdictMessage(r: DiagnosticRecord, modelId: string, portLabel: string): string {
  const isAura = modelId === "aura";
  if (r.verdict === "puerto") {
    const tabs = r.otherTabs ?? [];
    const holding = tabs.filter((t) => t.openPorts > 0);
    const tabsLine = holding.length
      ? `Había ${holding.length} pestaña(s) de Patagonia con la balanza tomada (${holding.map((t) => t.page).join(", ")}); se les pidió soltarla${holding.some((t) => t.busy > 0) ? ", pero alguna la estaba usando" : ""}.`
      : "Ninguna otra pestaña de Patagonia de este Chrome la tenía tomada.";
    // El tipo de error que dio Chrome (ver kretz/port-session.ts): cada uno tiene otra solución.
    const kind = [...(r.openLog ?? [])].reverse().find((o) => !o.ok && o.kind && o.kind !== "presupuesto")?.kind;
    if (r.stages?.[1]?.detail.startsWith("ya hay una prueba en curso")) {
      return "⏳ Ya hay una prueba corriendo con esta balanza. Esperá a que termine (dice \"Listo\").";
    }
    if (kind === "desconectado") {
      return `❌ El adaptador USB de la balanza no está conectado a la computadora (puerto elegido: ${portLabel}). Enchufalo, esperá 5 segundos y tocá "Probar la conexión".`;
    }
    if (kind === "sin_permiso") {
      return `❌ Chrome no dio permiso para usar el puerto. Tocá "Elegir otro puerto", elegí el de la balanza y tocá "Conectar".`;
    }
    return (
      `❌ Windows no deja abrir el puerto de la balanza (puerto elegido: ${portLabel}). La balanza no llegó a recibir nada: el problema está en la computadora, antes de la balanza.
` +
      `${tabsLine}
` +
      `Qué hacer: cerrar TODAS las ventanas de Chrome (también las de otros perfiles) y cualquier programa de balanza o caja; desenchufar el USB del cable, esperar 5 segundos y volver a enchufarlo; abrir un solo Chrome y tocar "Probar la conexión".`
    );
  }
  if (r.verdict === "peso") {
    return (
      `✅ El cable, el adaptador y el puerto ANDAN: la balanza mandó el peso (${(r.weight.kg ?? 0).toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg).\n` +
      `Está en modo PESO. Para probar la carga de productos, en la balanza: menú COMUNI → MODO = "Datos" (PUERT = RS-232), y tocá de nuevo "Probar la conexión".`
    );
  }
  if (r.verdict === "datos" && r.responder) {
    const how = `${r.responder.link.baudRate} baudios, ${r.responder.link.stopBits} bit(s) de stop, equipo "${r.responder.deviceType}${r.responder.equipmentId}"`;
    const pluRead = r.reads.find((x) => x.command === "5002");
    if (isAura) {
      return (
        `✅ La Aura CONTESTÓ en modo Datos (${how}). Es la primera vez que se comprueba con una Aura real.\n` +
        `Se leyeron sus datos técnicos y el formato de sus productos${pluRead?.code === "01" ? "" : " (alguna lectura no contestó; está en el detalle)"}, sin escribir nada.\n` +
        `Tocá "Enviar a soporte" (abajo) para que el equipo de Patagonia OS lo analice. El envío de productos a la Aura sigue bloqueado hasta confirmar el formato.`
      );
    }
    return (
      `✅ La balanza contestó en modo Datos (${how}). Ya quedó guardado.\n` +
      `Ahora tocá "Verificar compatibilidad" (carga y borra un producto de prueba) y, si sale bien, se habilita "Enviar todos los productos".`
    );
  }
  if (r.verdict === "bytes") {
    const echo = r.exchanges.some((e) => e.echo);
    return (
      (echo
        ? `⚠️ Lo que mandamos vuelve igual: el adaptador o el cable están devolviendo nuestra propia señal (puede ser un cable armado mal o con los pines puenteados).\n`
        : `⚠️ Desde la balanza llega algo, así que el cable transmite, pero no en un formato que entendamos.\n`) +
      `Revisá en la balanza el menú COMUNI: MODO = "Datos" y PUERT = RS-232. Después tocá "Enviar a soporte" (abajo) para que veamos lo que llegó.`
    );
  }
  return (
    `❌ La balanza no mandó ni un dato, en ninguna configuración (puerto elegido: ${portLabel}). Casi siempre es algo físico:\n` +
    `1) El puerto: tocá "Elegir otro puerto" y elegí el del adaptador USB de la balanza (si no sabés cuál es, desenchufá el adaptador, mirá cuál desaparece de la lista y volvé a enchufarlo).\n` +
    `2) El cable: tiene que ser DIRECTO (pin 2 con 2, 3 con 3, 5 con 5), macho del lado de la balanza. Los cables "null modem", "cruzados" o el cable de PC de otras Kretz NO sirven para la Aura.\n` +
    `3) El adaptador USB: en Windows, Administrador de dispositivos → Puertos (COM y LPT): si aparece con un signo amarillo, le falta el driver.\n` +
    `4) La balanza: encendida y en el menú COMUNI con PUERT = RS-232.\n` +
    `Prueba que aísla el cable: poné la balanza en COMUNI → MODO = "A pedido de peso" y tocá "Probar la conexión". Si así contesta el peso, el cable anda.`
  );
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
 * (código de etiqueta, campo 19, etc.) no coinciden con lo que ya tenía --
 * aunque igual responda código "01". Por eso, si el PLU ya existe, se lee
 * primero (5005) y se preservan esos campos tal cual estaban, cambiando
 * solo nombre/descripción/precio/tipo. Si el PLU es nuevo (nunca existió),
 * se usan valores por defecto razonables.
 *
 * Excepción: el flag de posición decimal NUNCA se preserva del registro
 * viejo (ver más abajo) -- un PLU cargado antes por iTegra puede traer otra
 * cantidad de decimales, y mandar el precio entero de Patagonia OS con ese
 * flag viejo corre el precio un dígito en la balanza (bug real detectado en
 * producción: mandamos 17500, la balanza mostraba 1750). Confirmado que
 * forzarlo a 0 decimales aunque no coincida con lo que ya tenía NO dispara
 * el ignorado silencioso de arriba -- el precio se actualiza igual, solo
 * cambia (correctamente) cómo se interpreta.
 * `descriptionOverride` es solo para casos puntuales -- el flujo normal
 * siempre manda el nombre del producto también como descripción, porque
 * Patagonia OS no tiene un campo de descripción separado. */
async function buildPluFrame(
  port: SerialPort,
  product: ScaleSyncableProduct,
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

  const settings = { ...getScaleSerialSettings(), deviceType, equipmentId, altaCommand, baudRate };
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
  // A diferencia de los demás campos secundarios, este NO se preserva del
  // registro viejo: un PLU cargado antes por iTegra puede traer otra
  // cantidad de decimales, y como Patagonia OS manda el precio siempre
  // como pesos enteros, heredar ese flag corre el precio en la balanza.
  // Confirmado con fotos reales de la pantalla probando los tres valores
  // en ROAST BEEF ($17500 cargado): flag "0" -> "175.00" (÷100), flag "1"
  // -> "1750.0" (÷10), flag "2" -> entero sin decimales (÷1, el que
  // corresponde). El patrón es "decimales mostrados = 2 - flag" -- por eso
  // el valor correcto es siempre "2", que es el que ya estaba en este
  // código antes de este incidente. El bug real nunca fue este valor por
  // defecto: fue que antes se heredaba el flag viejo de iTegra en vez de
  // forzar "2" siempre.
  const posicionDecimal = fixedDigits(2, 6);
  const impuesto1 = existing?.[11] ?? fixedDigits(0, 6);
  const impuesto2 = existing?.[12] ?? fixedDigits(0, 6);
  const taraPreempaque = existing?.[13] ?? fixedDigits(0, 5);
  const taraPublico = existing?.[14] ?? fixedDigits(0, 5);
  // "00" (sin formato de etiqueta asignado) es probablemente la causa real
  // de "Formato no definido" en la balanza para un PLU nuevo -- un PLU real
  // que sí muestra bien su etiqueta (PLU 3) trae "01" acá, no "00".
  const codigoEtiqueta = existing?.[15] ?? fixedDigits(1, 2);
  const codigoReceta = existing?.[16] ?? fixedDigits(0, 4);
  const codigoNutricional = existing?.[17] ?? fixedDigits(0, 4);
  // Sin documentación de qué es este campo, pero el mismo PLU 3 trae
  // "1000" acá, no "0000" -- se replica el valor real en vez de adivinar.
  const campo19 = existing?.[18] ?? fixedDigits(1000, 4);
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

/** Los envíos de la Report LT (registro de 135 caracteres, 2005/3005) nunca
 * van a una Kretz Aura: en la Aura la única escritura permitida es la prueba
 * del PLU 99 (kretz/aura-write-test.ts). Antes esto solo lo frenaba la
 * pantalla; si alguien cambiaba el modelo a "Report LT" con la Aura
 * conectada, "Borrar de la balanza" podía borrar un producto real. La Report
 * LT usa el tipo de equipo "C", así que esto no la afecta. */
export function assertNotAuraForReportWrites(settings: ScaleSerialSettings): void {
  if (settings.deviceType === "H" || getSavedModelId() === "aura") {
    throw new Error("Bloqueado: con la Kretz Aura todavía no se pueden mandar ni borrar productos. Solo está habilitada la prueba del producto 99.");
  }
}

/** Manda un solo producto a la balanza (comando 2005). */
export async function syncOneProductToScale(product: ScaleSyncableProduct): Promise<ScalePluWriteResult> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  const settings = getScaleSerialSettings();
  assertNotAuraForReportWrites(settings);
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
  assertNotAuraForReportWrites(settings);
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
  assertNotAuraForReportWrites(settings);
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
  toSend: ScaleSyncableProduct[];
  skipped: { product: ScaleSyncableProduct; reason: string }[];
  /** Productos inactivos -- ni se evalúan, page.active los filtra en
   * inventory-service (products acá ya viene sin bajas si corresponde),
   * pero se cuentan aparte para que enviados + salteados + inactivos dé
   * exactamente el total de productos. */
  inactive: ScaleSyncableProduct[];
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
export function planScaleSync(products: ScaleSyncableProduct[]): ScaleSyncPlan {
  const inactive = products.filter((p) => !(p.active ?? true));
  const active = products.filter((p) => p.active ?? true);
  const skipped: { product: ScaleSyncableProduct; reason: string }[] = [];
  const candidates: ScaleSyncableProduct[] = [];

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
  const byPlu = new Map<number, ScaleSyncableProduct[]>();
  for (const product of candidates) {
    const plu = Number(product.code);
    const group = byPlu.get(plu) ?? [];
    group.push(product);
    byPlu.set(plu, group);
  }

  const toSend: ScaleSyncableProduct[] = [];
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
  skipped: { product: ScaleSyncableProduct; reason: string }[];
  noResponse: { product: ScaleSyncableProduct }[];
  /** Errores de bajo nivel del puerto (ej. "Framing error") -- un hipo del
   * cable en un producto no debe tirar abajo el envío del resto del
   * catálogo. */
  transportErrors: { product: ScaleSyncableProduct; message: string }[];
  /** Cuenta de intentos por código de respuesta real de la balanza -- "01" es
   * éxito confirmado (probado a fondo: grabó y se pudo releer); cualquier
   * otro código es un rechazo real (ver describeResponseCode). */
  responseCodeCounts: Record<string, number>;
  /** Detalle por producto de los que NO dieron "01", para poder identificar
   * cuáles hay que revisar a mano en vez de solo ver un conteo agregado. */
  failed: { product: ScaleSyncableProduct; responseCode: string | null }[];
}

/** Manda el catálogo completo a la balanza por PLU (comando 2005), uno por
 * uno, esperando la respuesta de cada uno antes de mandar el siguiente
 * (nunca en paralelo -- la balanza es un dispositivo serie, de a uno).
 * Salta productos con código no numérico o precio inválido, y sigue con el
 * resto si un producto puntual falla (por rechazo de la balanza o por un
 * hipo de conexión) en vez de frenar todo el envío. */
export async function syncProductsToScale(
  products: ScaleSyncableProduct[],
  onProgress?: (done: number, total: number) => void
): Promise<ScaleSyncResult> {
  if (!isScaleSerialSupported()) {
    throw new Error("Este navegador no soporta comunicación serie directa (usá Chrome o Edge).");
  }
  const settings = getScaleSerialSettings();
  assertNotAuraForReportWrites(settings);
  const port = await pickPort();

  const { toSend, skipped } = planScaleSync(products);

  const noResponse: { product: ScaleSyncableProduct }[] = [];
  const transportErrors: { product: ScaleSyncableProduct; message: string }[] = [];
  const responseCodeCounts: Record<string, number> = {};
  const failed: { product: ScaleSyncableProduct; responseCode: string | null }[] = [];

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
      cachedPortOpenKey = null;
    }
    onProgress?.(i + 1, toSend.length);
  }

  return { attempted: toSend.length, skipped, noResponse, transportErrors, responseCodeCounts, failed };
}
