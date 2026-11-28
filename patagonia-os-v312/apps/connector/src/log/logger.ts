// Bitácora del servicio: una línea JSON por evento, rotación por tamaño y
// borrado de secretos. Nunca tira excepciones (una bitácora llena o sin
// permiso no puede tumbar al servicio).

import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /pass(word)?|secret|token|credential|authorization|api[-_]?key|cookie|private[-_]?key|^pin$|^pin[-_]|[-_]pin$|dpapi|scale-connector|^protected$/i;
const REDACTED = "[oculto]";
const MAX_DEPTH = 6;
const MAX_STRING = 4000;

/** Borra lo que parezca un secreto dentro de un texto libre. */
export function redactText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(
      /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|credential|pin)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
    // Credencial de la PC tal como viaja (encabezado x-scale-connector: <id>.<secreto>): queda el id, nunca el secreto.
    .replace(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{20,}/gi, `$1.${REDACTED}`);
}

/** Copia el valor borrando campos con nombre de secreto. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const clean = redactText(value);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…(${clean.length} caracteres)` : clean;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return { bytes: value.length, hex: Buffer.from(value.subarray(0, 64)).toString("hex") };
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redactText(value.message) };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    if (value.cause !== undefined && depth < MAX_DEPTH) out.cause = redact(value.cause, depth + 1);
    return out;
  }
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface FileLoggerOptions {
  dir: string;
  fileName?: string;
  level?: LogLevel;
  /** Tamaño máximo de cada archivo antes de rotar. */
  maxBytes?: number;
  /** Cuántos archivos viejos se conservan (connector.1.log … connector.N.log). */
  maxFiles?: number;
  /** También imprime en la consola (desarrollo). */
  console?: boolean;
  now?: () => Date;
}

export class RotatingFileSink {
  private size = -1;
  readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly fileName: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {
    this.file = path.join(dir, fileName);
  }

  write(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.size < 0) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    }
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    fs.appendFileSync(this.file, line);
    this.size += bytes;
  }

  rotatedName(index: number): string {
    const ext = path.extname(this.fileName);
    const stem = this.fileName.slice(0, this.fileName.length - ext.length);
    return path.join(this.dir, `${stem}.${index}${ext}`);
  }

  private rotate(): void {
    fs.rmSync(this.rotatedName(this.maxFiles), { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const from = this.rotatedName(i);
      if (fs.existsSync(from)) fs.renameSync(from, this.rotatedName(i + 1));
    }
    if (this.maxFiles >= 1) fs.renameSync(this.file, this.rotatedName(1));
    else fs.rmSync(this.file, { force: true });
    this.size = 0;
  }
}

export function createLogger(options: FileLoggerOptions): Logger {
  const sink = new RotatingFileSink(
    options.dir,
    options.fileName ?? "connector.log",
    options.maxBytes ?? 5 * 1024 * 1024,
    options.maxFiles ?? 5,
  );
  const min = LEVELS[options.level ?? "info"];
  const now = options.now ?? (() => new Date());
  let sinkBroken = false;

  const make = (bound: LogFields): Logger => {
    const emit = (level: LogLevel, message: string, fields?: LogFields) => {
      if (LEVELS[level] < min) return;
      const entry = {
        t: now().toISOString(),
        level,
        msg: redactText(message),
        ...(redact({ ...bound, ...fields }) as Record<string, unknown>),
      };
      const line = `${JSON.stringify(entry)}\n`;
      if (options.console) (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
      try {
        sink.write(line);
        sinkBroken = false;
      } catch (error) {
        if (!sinkBroken) {
          sinkBroken = true;
          process.stderr.write(`No se pudo escribir la bitácora: ${(error as Error).message}\n`);
        }
      }
    };
    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };
  return make({});
}

/** Bitácora en memoria para pruebas. */
export function createMemoryLogger(): Logger & { entries: Array<{ level: LogLevel; message: string; fields: LogFields }> } {
  const entries: Array<{ level: LogLevel; message: string; fields: LogFields }> = [];
  const make = (bound: LogFields): Logger => {
    const emit = (level: LogLevel, message: string, fields?: LogFields) =>
      entries.push({ level, message, fields: redact({ ...bound, ...fields }) as LogFields });
    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };
  return Object.assign(make({}), { entries });
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
