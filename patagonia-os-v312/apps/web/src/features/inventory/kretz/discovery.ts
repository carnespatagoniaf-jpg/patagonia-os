import { exchangeWeightFrame, WEIGHT_PORT_OPTIONS } from "../../sale/scale-weight-protocol";
import { buildKretzFrame, describeKretzCode, parseKretzResponse, toHex, toPrintable, type KretzResponse } from "./kretz-frame";
import type { KretzModel, SerialLink } from "./models";
import { askOtherTabs, type TabAnswer } from "./serial-tabs";

/**
 * Descubrimiento SOLO DE LECTURA de una balanza Kretz ("Probar todo").
 *
 * Nunca escribe nada en la balanza: `assertReadOnly` corta cualquier comando
 * que no sea de prueba o de lectura según los grupos del documento público de
 * Kretz (0001/0002 test de conexión, 1500-1999 lectura de configuración,
 * 5000-5999 lectura de datos). Los de alta (2xxx), borrado (3xxx/4xxx) y
 * configuración (0000-1499 salvo 0001/0002) no se pueden mandar desde acá.
 *
 * Todo lo que se manda y lo que vuelve queda anotado byte por byte en el
 * registro (DiagnosticRecord), que se guarda en la PC y viaja con "Enviar a
 * soporte": con eso se identifica el protocolo sin adivinar.
 */

export function isReadOnlyCommand(command: string): boolean {
  if (!/^\d{4}$/.test(command)) return false;
  const n = Number(command);
  return n === 1 || n === 2 || (n >= 1500 && n <= 1999) || (n >= 5000 && n <= 5999);
}

export function assertReadOnly(command: string): void {
  if (!isReadOnlyCommand(command)) {
    throw new Error(`Bloqueado: el comando ${command} no es de solo lectura y el descubrimiento nunca escribe en la balanza.`);
  }
}

export interface DiagnosticExchange {
  step: string;
  link: string;
  tx: string;
  rx: string;
  rxText: string;
  ms: number;
  kretz: KretzResponse | null;
  echo: boolean;
}

export type DiscoveryVerdict = "datos" | "peso" | "bytes" | "nada" | "puerto";

/** Etapas de la comunicación, en orden. Cada prueba dice en cuál se cortó. */
export type StageId = "dispositivo" | "abrir" | "enviar" | "recibir" | "interpretar";
export const STAGE_LABELS: Record<StageId, string> = {
  dispositivo: "Detectar el aparato (adaptador USB)",
  abrir: "Abrir la conexión (puerto)",
  enviar: "Enviar la instrucción",
  recibir: "Recibir respuesta",
  interpretar: "Entender la respuesta (protocolo Kretz)"
};
export interface Stage {
  id: StageId;
  status: "ok" | "falla" | "no_llego";
  detail: string;
}

export interface DiagnosticRecord {
  version: 1;
  model: string;
  startedAt: string;
  finishedAt: string;
  port: string;
  balanceNumber: string;
  weight: { kg: number | null; raw: string; passiveBytes: number };
  responder: { link: SerialLink; deviceType: string; equipmentId: string } | null;
  reads: { command: string; data: string; label: string; code: string | null; codeLabel: string; dataText: string }[];
  exchanges: DiagnosticExchange[];
  verdict: DiscoveryVerdict;
  anyBytes: boolean;
  /** Versión de esta prueba (para saber qué código corrió en la PC del cliente). */
  codeVersion?: string;
  /** Cada intento de abrir el puerto, con el error exacto de Windows/Chrome si falló. */
  openLog?: OpenAttempt[];
  /** Resultado por etapa: dónde se cortó. */
  stages?: Stage[];
  /** Puertos serie que este Chrome tiene autorizados (para ver si hay más de uno). */
  portsSeen?: string[];
  /** Otras pestañas de Patagonia en este Chrome que tenían un puerto abierto (y si lo soltaron). */
  otherTabs?: TabAnswer[];
}

export interface OpenAttempt {
  at: string;
  settings: string;
  try: number;
  ok: boolean;
  error?: string;
  /** Estado del puerto ANTES de intentar (si quedaba algo abierto). */
  before: string;
}

export const DISCOVERY_VERSION = "2026-10-02a";

/** Se llena en cada apertura; runKretzDiscovery y scanAllPlus lo guardan en su registro. */
let openLog: OpenAttempt[] = [];

export interface DiscoveryOptions {
  /** Número de balanza (Aura: menú DATOS → n_bal). Se usa como ID de equipo. */
  balanceNumber?: string;
  frameTimeoutMs?: number;
  listenMs?: number;
  onProgress?: (text: string) => void;
  shouldStop?: () => boolean;
  /** Descripción de cada puerto autorizado (lo arma quien llama). */
  portsSeen?: string[];
  /** Pedir a otras pestañas que suelten el puerto (por defecto sí; los tests lo apagan). */
  releaseOtherTabs?: boolean;
  /** Intentos de abrir por velocidad (por defecto 4). */
  openTries?: number;
}

const linkLabel = (l: SerialLink) => `${l.baudRate} baudios, ${l.stopBits} bit(s) de stop`;

async function closeQuietly(port: SerialPort) {
  try {
    if (port.readable || port.writable) await port.close();
  } catch {
    // ya cerrado
  }
}

/** Lee lo que llegue hasta `ms` (o hasta EOT si `untilEot`). Una sola lectura pendiente a la vez. */
async function collect(port: SerialPort, ms: number, untilEot: boolean): Promise<number[]> {
  const reader = port.readable!.getReader();
  const got: number[] = [];
  const deadline = Date.now() + ms;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  try {
    while (Date.now() < deadline) {
      pending ??= reader.read();
      const r = await Promise.race([pending, new Promise<null>((res) => setTimeout(() => res(null), Math.max(1, deadline - Date.now())))]);
      if (r === null) break;
      pending = null;
      if (r.done) break;
      if (r.value) got.push(...r.value);
      if (untilEot && got.includes(0x04)) {
        // la respuesta Kretz termina en EOT; esperar un instante por si llega algo más
        const extra = await Promise.race([reader.read(), new Promise<null>((res) => setTimeout(() => res(null), 30))]);
        if (extra && !extra.done && extra.value) got.push(...extra.value);
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // lectura pendiente: se cancela al cerrar
    }
  }
  return got;
}

/** Abre el puerto; si Windows lo tiene ocupado un momento (otra pestaña, Mostrador leyendo el peso,
 * otro programa), espera y reintenta: con la Aura real pasó que los primeros segundos fallaba
 * ("Failed to open serial port") y se perdían justo las pruebas importantes (2026-10-01). */
async function openWithRetry(port: SerialPort, options: SerialOptions, tries = 4, waitMs = 1000): Promise<void> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const wasOpen = Boolean(port.readable || port.writable);
    const before = `readable=${port.readable ? (port.readable.locked ? "bloqueado" : "sí") : "no"} writable=${port.writable ? (port.writable.locked ? "bloqueado" : "sí") : "no"}`;
    const settings = `${options.baudRate}/${options.dataBits ?? 8}/${options.parity ?? "none"}/${options.stopBits ?? 1}`;
    await closeQuietly(port);
    // Algunos adaptadores (CH340) fallan si se reabre enseguida de cerrar.
    if (wasOpen || i > 0) await new Promise((r) => setTimeout(r, 400));
    try {
      await port.open(options);
      openLog.push({ at: new Date().toISOString(), settings, try: i + 1, ok: true, before });
      return;
    } catch (err) {
      last = err;
      openLog.push({ at: new Date().toISOString(), settings, try: i + 1, ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), before });
      // Caso real (Aura de un cliente, adaptador CH340, 2026-10-01): Windows rechazaba
      // abrir en 9600 una y otra vez, pero abría en 115200 o 4800, y justo después de
      // abrir en 4800 la 9600 sí abrió. Entonces: abrir un instante en otra velocidad,
      // cerrar y volver a intentar. No se manda nada a la balanza en esa apertura.
      await primePort(port, options);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

const PRIME_RATES = [4800, 115200];

async function primePort(port: SerialPort, target: SerialOptions): Promise<void> {
  for (const baudRate of PRIME_RATES) {
    if (baudRate === target.baudRate) continue;
    const settings = `${baudRate}/8/none/1 (destrabar)`;
    try {
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none" });
      openLog.push({ at: new Date().toISOString(), settings, try: 0, ok: true, before: "cerrado" });
      await new Promise((r) => setTimeout(r, 150));
      await closeQuietly(port);
      await new Promise((r) => setTimeout(r, 300));
      return;
    } catch (err) {
      openLog.push({ at: new Date().toISOString(), settings, try: 0, ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), before: "cerrado" });
    }
  }
}

async function openLink(port: SerialPort, link: SerialLink) {
  await openWithRetry(port, { baudRate: link.baudRate, dataBits: 8, stopBits: link.stopBits, parity: "none" });
}

async function sendRead(
  port: SerialPort,
  log: DiagnosticExchange[],
  step: string,
  link: SerialLink,
  deviceType: string,
  equipmentId: string,
  command: string,
  data: string,
  timeoutMs: number
): Promise<DiagnosticExchange> {
  assertReadOnly(command);
  const frame = buildKretzFrame(deviceType, equipmentId, command, data);
  const writer = port.writable!.getWriter();
  const t0 = Date.now();
  try {
    await writer.write(frame);
  } finally {
    writer.releaseLock();
  }
  const rx = await collect(port, timeoutMs, true);
  const exchange: DiagnosticExchange = {
    step,
    link: linkLabel(link),
    tx: toHex(frame),
    rx: toHex(rx),
    rxText: toPrintable(rx),
    ms: Date.now() - t0,
    kretz: parseKretzResponse(rx),
    echo: rx.length >= frame.length && toHex(rx.slice(0, frame.length)) === toHex(frame)
  };
  log.push(exchange);
  return exchange;
}

/** Comandos de lectura que se piden cuando aparece una balanza que contesta (todos de solo lectura). */
const READS: { command: string; data: string; label: string }[] = [
  { command: "0002", data: "", label: "Test de conexión silencioso" },
  { command: "1500", data: "", label: "Datos técnicos del equipo" },
  { command: "5002", data: "05", label: "Modelo de datos de los PLU (largo de cada campo)" },
  { command: "5005", data: "000000", label: "Primer PLU guardado en la balanza" }
];

export async function runKretzDiscovery(port: SerialPort, portLabel: string, model: KretzModel, options: DiscoveryOptions = {}): Promise<DiagnosticRecord> {
  const progress = options.onProgress ?? (() => {});
  const stop = options.shouldStop ?? (() => false);
  const timeout = options.frameTimeoutMs ?? 500;
  const tries = options.openTries ?? 4;
  const balanceNumber = (options.balanceNumber ?? "").replace(/\D/g, "").slice(-2) || "1";
  const id = balanceNumber.padStart(2, "0");
  const stages: Record<StageId, Stage> = {
    dispositivo: { id: "dispositivo", status: "no_llego", detail: "" },
    abrir: { id: "abrir", status: "no_llego", detail: "" },
    enviar: { id: "enviar", status: "no_llego", detail: "" },
    recibir: { id: "recibir", status: "no_llego", detail: "" },
    interpretar: { id: "interpretar", status: "no_llego", detail: "" }
  };
  const record: DiagnosticRecord = {
    version: 1,
    model: model.id,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    port: portLabel,
    balanceNumber,
    weight: { kg: null, raw: "", passiveBytes: 0 },
    responder: null,
    reads: [],
    exchanges: [],
    verdict: "nada",
    anyBytes: false,
    codeVersion: DISCOVERY_VERSION,
    openLog: [],
    portsSeen: options.portsSeen ?? [],
    otherTabs: []
  };
  openLog = record.openLog!;
  const finishStages = () => {
    record.stages = (Object.keys(STAGE_LABELS) as StageId[]).map((k) => stages[k]);
  };

  // Lleva la cuenta de qué etapas se alcanzaron en cada intercambio.
  const noteExchange = (ex: DiagnosticExchange) => {
    stages.enviar = { id: "enviar", status: "ok", detail: `se mandaron instrucciones (última: ${ex.tx})` };
    if (ex.rx && !ex.echo) {
      record.anyBytes = true;
      stages.recibir = { id: "recibir", status: "ok", detail: `llegaron bytes (${ex.link}): ${ex.rx.slice(0, 60)}` };
    }
    if (ex.kretz) {
      stages.interpretar = {
        id: "interpretar",
        status: ex.kretz.checksumOk ? "ok" : "falla",
        detail: ex.kretz.checksumOk ? `respuesta Kretz válida: equipo "${ex.kretz.deviceType}${ex.kretz.equipmentId}", código ${ex.kretz.code}` : "llegó una respuesta con forma Kretz pero el checksum no cierra"
      };
    }
  };

  try {
    // Etapa 1: el aparato. Quien llama ya eligió el puerto; acá queda anotado qué ve Chrome.
    stages.dispositivo = {
      id: "dispositivo",
      status: "ok",
      detail: `puerto elegido: ${portLabel}. Autorizados en este Chrome: ${record.portsSeen!.length ? record.portsSeen!.join(" | ") : "?"}`
    };

    // Otras pestañas de Patagonia que tengan el puerto tomado: pedirles que lo suelten.
    if (options.releaseOtherTabs !== false) {
      progress("Pidiendo a otras pestañas de Patagonia que suelten la balanza…");
      record.otherTabs = await askOtherTabs("release");
    }

    // Etapa 2: abrir la conexión con la configuración más probable del modelo.
    const primary = model.links[0];
    progress(`Abriendo la conexión (${linkLabel(primary)})…`);
    try {
      await openWithRetry(port, { baudRate: primary.baudRate, dataBits: 8, stopBits: primary.stopBits, parity: "none" }, tries);
      stages.abrir = { id: "abrir", status: "ok", detail: `abrió en ${linkLabel(primary)}` };
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      // ¿Abre en alguna otra velocidad? Distingue "puerto tomado del todo" de "adaptador trabado en una velocidad".
      let opensElsewhere = "";
      for (const link of model.links.slice(1)) {
        try {
          await openWithRetry(port, { baudRate: link.baudRate, dataBits: 8, stopBits: link.stopBits, parity: "none" }, 1, 200);
          opensElsewhere = linkLabel(link);
          await closeQuietly(port);
          break;
        } catch {
          // sigue
        }
      }
      stages.abrir = {
        id: "abrir",
        status: "falla",
        detail: opensElsewhere
          ? `Windows no deja abrir en ${linkLabel(primary)} (${msg}), pero sí en ${opensElsewhere}: el adaptador USB quedó trabado.`
          : `Windows no deja abrir el puerto en ninguna velocidad (${msg}): lo tiene tomado otra pestaña, otra ventana de Chrome u otro programa, o el adaptador quedó trabado.`
      };
      record.verdict = "puerto";
      return record;
    }

    // Etapas 3-5 con la combinación más probable (para la Aura: "H", 9600, 2 bits de stop, ya comprobada con una Aura real).
    progress(`Probando la balanza (equipo "${model.deviceTypes[0]}${id}")…`);
    let first = await sendRead(port, record.exchanges, "test de conexión", primary, model.deviceTypes[0], id, "0001", "", timeout);
    noteExchange(first);
    if (!first.kretz) {
      first = await sendRead(port, record.exchanges, "test de conexión (reintento)", primary, model.deviceTypes[0], id, "0001", "", timeout);
      noteExchange(first);
    }
    if (first.kretz) {
      record.responder = { link: primary, deviceType: first.kretz.deviceType || model.deviceTypes[0], equipmentId: first.kretz.equipmentId || id };
    }

    // Si no contestó: modo peso (prueba el cable) y el resto de las combinaciones.
    if (!record.responder) {
      progress("No contestó en modo Datos. Probando si manda el peso…");
      try {
        await openWithRetry(port, WEIGHT_PORT_OPTIONS, tries);
        const passive = await collect(port, options.listenMs ?? 1200, false);
        const exchange = await exchangeWeightFrame(port);
        record.weight = { kg: exchange.frame?.weightKg ?? null, raw: toPrintable(passive) + exchange.raw, passiveBytes: passive.length };
        if (passive.length > 0 || exchange.raw.length > 0) {
          record.anyBytes = true;
          stages.recibir = { id: "recibir", status: "ok", detail: `en modo peso llegaron bytes: ${JSON.stringify(record.weight.raw.slice(0, 60))}` };
        }
        if (record.weight.kg !== null) {
          stages.interpretar = { id: "interpretar", status: "ok", detail: `peso leído: ${record.weight.kg} kg (la balanza está en modo peso, no en Datos)` };
          record.verdict = "peso";
          return record;
        }
      } catch (err) {
        record.weight.raw = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      await closeQuietly(port);

      const attempts: { link: SerialLink; letter: string; id: string }[] = [];
      for (const link of model.links.slice(1)) attempts.push({ link, letter: model.deviceTypes[0], id });
      for (const link of model.links.slice(0, 2)) {
        for (const letter of model.deviceTypes.slice(1)) attempts.push({ link, letter, id });
      }
      if (id !== "00") attempts.push({ link: primary, letter: model.deviceTypes[0], id: "00" });

      let openKey = "";
      const deadLinks = new Set<string>();
      for (let i = 0; i < attempts.length && !stop(); i++) {
        const a = attempts[i];
        const key = `${a.link.baudRate}/${a.link.stopBits}`;
        if (deadLinks.has(key)) continue; // no insistir con una velocidad que no abre
        progress(`Probando otras combinaciones ${i + 1}/${attempts.length}: ${linkLabel(a.link)}, equipo "${a.letter}${a.id}"…`);
        if (key !== openKey) {
          try {
            await openWithRetry(port, { baudRate: a.link.baudRate, dataBits: 8, stopBits: a.link.stopBits, parity: "none" }, 1, 200);
            openKey = key;
          } catch {
            deadLinks.add(key);
            openKey = "";
            continue;
          }
        }
        try {
          const ex = await sendRead(port, record.exchanges, "test de conexión", a.link, a.letter, a.id, "0001", "", timeout);
          noteExchange(ex);
          if (ex.kretz) {
            record.responder = { link: a.link, deviceType: ex.kretz.deviceType || a.letter, equipmentId: ex.kretz.equipmentId || a.id };
            break;
          }
        } catch {
          openKey = "";
          await closeQuietly(port);
        }
      }
    }

    if (!record.responder) {
      if (stages.recibir.status === "no_llego") stages.recibir = { id: "recibir", status: "falla", detail: "la balanza no mandó ni un byte en ninguna prueba" };
      else if (stages.interpretar.status === "no_llego") stages.interpretar = { id: "interpretar", status: "falla", detail: "llegaron bytes pero no con el formato Kretz" };
      record.verdict = record.anyBytes ? "bytes" : "nada";
      return record;
    }

    // Contestó: lecturas de solo lectura para identificar el protocolo (todas pasan por assertReadOnly).
    const r = record.responder;
    if (r.link.baudRate !== primary.baudRate || r.link.stopBits !== primary.stopBits) await openLink(port, r.link);
    for (const read of READS) {
      if (stop()) break;
      progress(`La balanza contestó. Leyendo: ${read.label}…`);
      try {
        const ex = await sendRead(port, record.exchanges, read.label, r.link, a2(r.deviceType), r.equipmentId, read.command, read.data, Math.max(timeout, 1500));
        noteExchange(ex);
        record.reads.push({
          command: read.command,
          data: read.data,
          label: read.label,
          code: ex.kretz?.code ?? null,
          codeLabel: describeKretzCode(ex.kretz?.code ?? null),
          dataText: ex.kretz?.data ?? ex.rxText
        });
      } catch (err) {
        record.reads.push({ command: read.command, data: read.data, label: read.label, code: null, codeLabel: `error: ${err instanceof Error ? err.message : String(err)}`, dataText: "" });
      }
    }
    record.verdict = "datos";
    return record;
  } finally {
    finishStages();
    await closeQuietly(port);
    record.finishedAt = new Date().toISOString();
  }
}

const a2 = (letter: string) => letter.slice(0, 1) || "C";

/* ------------------------------ leer todos los PLU (solo lectura) ------------------------------ */

export interface KretzResponder {
  link: SerialLink;
  deviceType: string;
  equipmentId: string;
}

export interface PluScan {
  model: string;
  startedAt: string;
  finishedAt: string;
  responder: KretzResponder;
  /** Cada registro tal cual vino en los datos de la respuesta 5005. */
  records: { plu: number; data: string }[];
  stoppedBy: "fin" | "limite" | "cancelado" | "error";
  /** Código de la última respuesta (el que cortó la lectura, si fue "fin"). */
  lastCode: string | null;
  lastDetail: string;
  /** Los primeros intercambios, byte por byte, para soporte. */
  sample: DiagnosticExchange[];
  codeVersion?: string;
  openLog?: OpenAttempt[];
}

/**
 * Lee todos los PLU con 5005 (devuelve el siguiente mayor al argumento: se
 * pide 0, después el último leído, y así). Solo lectura: pasa por assertReadOnly.
 * Sirve para comprobar el formato contra lo que imprime la balanza y como
 * copia de seguridad antes de que alguna vez se escriba algo.
 */
export async function scanAllPlus(
  port: SerialPort,
  responder: KretzResponder,
  modelId: string,
  options: { max?: number; timeoutMs?: number; onProgress?: (text: string) => void; shouldStop?: () => boolean } = {}
): Promise<PluScan> {
  const max = options.max ?? 10000;
  const timeout = options.timeoutMs ?? 1500;
  const log: DiagnosticExchange[] = [];
  const scan: PluScan = {
    model: modelId,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    responder,
    records: [],
    stoppedBy: "fin",
    lastCode: null,
    lastDetail: "",
    sample: [],
    codeVersion: DISCOVERY_VERSION,
    openLog: []
  };
  openLog = scan.openLog!;
  try {
    try {
      await openLink(port, responder.link);
    } catch (err) {
      scan.stoppedBy = "error";
      scan.lastDetail = `no se pudo abrir el puerto: está ocupado por otra pestaña de Patagonia OS u otro programa (iTegra, etc.). Cerralos, desenchufá y volvé a enchufar el USB, y probá de nuevo. (${err instanceof Error ? err.message : String(err)})`;
      return scan;
    }
    // Primero el test de conexión, como en "Probar todo" (con la Aura real, la
    // lectura que vino después del 0001 contestó; una lectura sola, más tarde, no:
    // 2026-10-01). Si ni el 0001 contesta, el problema es el estado de la balanza.
    let hello = await sendRead(port, log, "test de conexión", responder.link, responder.deviceType, responder.equipmentId, "0001", "", timeout);
    if (!hello.kretz) hello = await sendRead(port, log, "test de conexión (reintento)", responder.link, responder.deviceType, responder.equipmentId, "0001", "", timeout);
    if (!hello.kretz) {
      scan.stoppedBy = "error";
      scan.lastCode = null;
      scan.lastDetail =
        "la balanza no contestó ni el test de conexión. Fijate que esté prendida, en la pantalla de venta (no dentro del menú), y en modo Datos (menú → COMUNI → MODO = dAtOS). Tocá una tecla para despertarla y probá de nuevo";
      return scan;
    }
    let after = 0;
    for (;;) {
      if (options.shouldStop?.()) {
        scan.stoppedBy = "cancelado";
        break;
      }
      if (scan.records.length >= max) {
        scan.stoppedBy = "limite";
        break;
      }
      const arg = String(after).padStart(6, "0");
      let ex = await sendRead(port, log, "leer PLU", responder.link, responder.deviceType, responder.equipmentId, "5005", arg, timeout);
      if (!ex.kretz) ex = await sendRead(port, log, "leer PLU (reintento)", responder.link, responder.deviceType, responder.equipmentId, "5005", arg, timeout);
      if (log.length > 40) log.splice(20, 1); // guardar los primeros 20 y los últimos, no miles
      scan.lastCode = ex.kretz?.code ?? null;
      if (!ex.kretz || ex.kretz.code !== "01") {
        scan.stoppedBy = ex.kretz ? "fin" : "error";
        scan.lastDetail = ex.kretz ? describeKretzCode(ex.kretz.code) : ex.rx ? `respuesta no reconocida: ${ex.rx}` : "sin respuesta";
        break;
      }
      const plu = Number(ex.kretz.data.slice(0, 6));
      if (!Number.isFinite(plu) || plu <= after) {
        scan.stoppedBy = "error";
        scan.lastDetail = `la balanza devolvió el PLU ${ex.kretz.data.slice(0, 6)} después del ${after}: se corta para no dar vueltas`;
        break;
      }
      scan.records.push({ plu, data: ex.kretz.data });
      after = plu;
      options.onProgress?.(`Leyendo productos de la balanza… ${scan.records.length} (va por el PLU ${plu})`);
    }
  } catch (err) {
    scan.stoppedBy = "error";
    scan.lastDetail = err instanceof Error ? err.message : String(err);
  } finally {
    await closeQuietly(port);
    scan.sample = log;
    scan.finishedAt = new Date().toISOString();
  }
  return scan;
}

const BACKUP_KEY = "patagonia-scale-plu-backup";

export function savePluScan(scan: PluScan): void {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(scan));
  } catch {
    // muy grande o bloqueado: igual se puede descargar
  }
}

export function getLastPluScan(): PluScan | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? (JSON.parse(raw) as PluScan) : null;
  } catch {
    return null;
  }
}

/* ------------------------------ guardar el registro ------------------------------ */

const RECORD_KEY = "patagonia-scale-diagnostic-last";

export function saveDiagnosticRecord(record: DiagnosticRecord): void {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(record));
  } catch {
    // no crítico: igual se muestra en pantalla
  }
}

export function getLastDiagnosticRecord(): DiagnosticRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    return raw ? (JSON.parse(raw) as DiagnosticRecord) : null;
  } catch {
    return null;
  }
}

/** Resumen en texto para soporte (el registro completo va aparte, como JSON). */
export function summarizeDiagnosticRecord(r: DiagnosticRecord): string {
  const lines = [
    `Diagnóstico de balanza (${r.model}) ${r.startedAt} → ${r.finishedAt}`,
    `Puerto: ${r.port}. Número de balanza usado como ID: ${r.balanceNumber}.`,
    `Peso (9600/2): ${r.weight.kg !== null ? `${r.weight.kg} kg` : "no"}; bytes sin pedir: ${r.weight.passiveBytes}; recibido: ${JSON.stringify(r.weight.raw.slice(0, 120))}`,
    `Contestó en modo datos: ${r.responder ? `${linkLabel(r.responder.link)}, equipo "${r.responder.deviceType}${r.responder.equipmentId}"` : "nadie"}.`,
    ...r.reads.map((x) => `Lectura ${x.command}${x.data ? ` (${x.data})` : ""} ${x.label}: código ${x.code ?? "—"} (${x.codeLabel}); datos: ${JSON.stringify(x.dataText.slice(0, 300))}`),
    `Intercambios registrados: ${r.exchanges.length}; con respuesta: ${r.exchanges.filter((e) => e.rx).length}; eco del cable: ${r.exchanges.filter((e) => e.echo).length}.`,
    ...r.exchanges.filter((e) => e.rx).slice(0, 20).map((e) => `  [${e.link}] TX ${e.tx} → RX ${e.rx}${e.echo ? " (ECO)" : ""}`)
  ];
  return lines.join("\n");
}
