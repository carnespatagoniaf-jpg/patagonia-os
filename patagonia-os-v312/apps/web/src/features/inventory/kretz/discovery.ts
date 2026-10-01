import { exchangeWeightFrame, WEIGHT_PORT_OPTIONS } from "../../sale/scale-weight-protocol";
import { buildKretzFrame, describeKretzCode, parseKretzResponse, toHex, toPrintable, type KretzResponse } from "./kretz-frame";
import type { KretzModel, SerialLink } from "./models";

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

export type DiscoveryVerdict = "datos" | "peso" | "bytes" | "nada";

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
}

export interface DiscoveryOptions {
  /** Número de balanza (Aura: menú DATOS → n_bal). Se usa como ID de equipo. */
  balanceNumber?: string;
  frameTimeoutMs?: number;
  listenMs?: number;
  onProgress?: (text: string) => void;
  shouldStop?: () => boolean;
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

async function openLink(port: SerialPort, link: SerialLink) {
  await closeQuietly(port);
  await port.open({ baudRate: link.baudRate, dataBits: 8, stopBits: link.stopBits, parity: "none" });
}

async function sendRead(
  port: SerialPort,
  record: DiagnosticRecord,
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
  record.exchanges.push(exchange);
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
  const balanceNumber = (options.balanceNumber ?? "").replace(/\D/g, "").slice(-2) || "1";
  const id = balanceNumber.padStart(2, "0");
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
    anyBytes: false
  };

  try {
    // 1) Modo peso (9600, 2 bits de stop, según el manual de la Aura): escucha y pide "W".
    progress("Probando si la balanza manda el peso…");
    try {
      await port.open(WEIGHT_PORT_OPTIONS);
      const passive = await collect(port, options.listenMs ?? 1200, false);
      const exchange = await exchangeWeightFrame(port);
      record.weight = { kg: exchange.frame?.weightKg ?? null, raw: toPrintable(passive) + exchange.raw, passiveBytes: passive.length };
      if (passive.length > 0 || exchange.raw.length > 0) record.anyBytes = true;
    } catch (err) {
      record.weight.raw = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    await closeQuietly(port);
    if (record.weight.kg !== null) {
      record.verdict = "peso";
      return record;
    }

    // 2) Modo datos: test de conexión 0001 (solo hace un bip) con cada velocidad y letra.
    const attempts: { link: SerialLink; letter: string; id: string }[] = [];
    for (const link of model.links) attempts.push({ link, letter: model.deviceTypes[0], id });
    for (const link of model.links.slice(0, 2)) {
      for (const letter of model.deviceTypes.slice(1)) attempts.push({ link, letter, id });
    }
    if (id !== "00") attempts.push({ link: model.links[0], letter: model.deviceTypes[0], id: "00" });

    let openKey = "";
    for (let i = 0; i < attempts.length && !stop(); i++) {
      const a = attempts[i];
      const key = `${a.link.baudRate}/${a.link.stopBits}`;
      progress(`Probando modo datos ${i + 1}/${attempts.length}: ${linkLabel(a.link)}, equipo "${a.letter}${a.id}"…`);
      try {
        if (key !== openKey) {
          await openLink(port, a.link);
          openKey = key;
        }
        const ex = await sendRead(port, record, "test de conexión", a.link, a.letter, a.id, "0001", "", timeout);
        if (ex.rx.length > 0 && !ex.echo) record.anyBytes = true;
        if (ex.kretz) {
          record.responder = { link: a.link, deviceType: ex.kretz.deviceType || a.letter, equipmentId: ex.kretz.equipmentId || a.id };
          break;
        }
      } catch {
        openKey = "";
        await closeQuietly(port);
      }
    }

    // 3) Si alguien contestó como Kretz: lecturas de solo lectura para identificar el protocolo.
    if (record.responder) {
      const r = record.responder;
      for (const read of READS) {
        if (stop()) break;
        progress(`La balanza contestó. Leyendo: ${read.label}…`);
        try {
          const ex = await sendRead(port, record, read.label, r.link, a2(r.deviceType), r.equipmentId, read.command, read.data, Math.max(timeout, 1500));
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
    } else {
      record.verdict = record.anyBytes ? "bytes" : "nada";
    }
    return record;
  } finally {
    await closeQuietly(port);
    record.finishedAt = new Date().toISOString();
  }
}

const a2 = (letter: string) => letter.slice(0, 1) || "C";

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
