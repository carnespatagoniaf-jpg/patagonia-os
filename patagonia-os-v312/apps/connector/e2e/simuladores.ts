// Balanzas simuladas POR RED para la prueba de punta a punta en una PC limpia (.github/workflows/scale-connect-e2e.yml).
//
// Reusa los simuladores de las pruebas del conector (src/protocols/testing/simulators.ts), que a su vez son los de la
// web: una Kretz Report LT por TCP (puerto 1001, como la real) y una Systel Cuora Max por TCP (puerto 10001, módulo de
// red Lantronix). El conector las ve como balanzas de la red local: escucha en la IP de la PC, no en 127.0.0.1 (el
// conector solo habla con IP de red local, ver isLocalNetworkIPv4).
//
// Control en http://127.0.0.1:9301 (solo esta PC):
//   GET  /estado                     → lo que tiene grabado cada balanza (PLU, nombre, precio, código de barras)
//   POST /borrar                     → vacía las dos balanzas (el próximo envío escribe todo de nuevo)
//   POST /cortar-report?despues=N    → la Report se "desenchufa" de la red después del N-ésimo producto grabado
//   POST /reiniciar-report           → la Report vuelve a la red
//   POST /lento?ms=N                 → cada respuesta de las dos balanzas tarda N ms (para cortar la red a mitad)
//
// Uso: node --import tsx e2e/simuladores.ts --host 10.1.0.4 [--report 1001] [--systel 10001] [--control 9301]

import http from "node:http";
import net from "node:net";
import { FakeCuora, FakeReportDevice } from "../src/protocols/testing/simulators";
import { parsePluAs, pluEanSetting, rawToPesos } from "../../web/src/features/inventory/systel/systel-plu";
import { fakeReadRecord } from "../../web/src/features/inventory/systel/systel-fake";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg("host", "0.0.0.0");
const REPORT_PORT = Number(arg("report", "1001"));
const SYSTEL_PORT = Number(arg("systel", "10001"));
const CONTROL_PORT = Number(arg("control", "9301"));
const SYSTEL_LAYOUT = "max60" as const;

let report = new FakeReportDevice();
/** Una Cuora como viene de fábrica: con un producto modelo (de él se copian sector y formato al crear los nuevos). */
function newCuora(): FakeCuora {
  const f = new FakeCuora(SYSTEL_LAYOUT, { address: 1, protocol: "0060" });
  f.plus.set(900, fakeReadRecord(SYSTEL_LAYOUT, { number: 900, name: "MODELO KILO", price: 100, code: 900, type: "P" }));
  return f;
}

let cuora = newCuora();
let delayMs = 0;
let cutAfter: number | null = null;
let reportWritesSinceArm = 0;
const events: string[] = [];
const log = (text: string) => {
  const line = `${new Date().toISOString()} ${text}`;
  events.push(line);
  if (events.length > 2000) events.shift();
  process.stdout.write(`${line}\n`);
};

const later = (fn: () => void) => (delayMs > 0 ? setTimeout(fn, delayMs) : fn());

// ── Report por TCP ────────────────────────────────────────────────────────────────────────────────────────────────
const reportSockets = new Set<net.Socket>();
let reportServer: net.Server | null = null;

function wireReport(device: FakeReportDevice): void {
  device.onWrite = (plu) => {
    reportWritesSinceArm += 1;
    if (cutAfter !== null && reportWritesSinceArm >= cutAfter) {
      log(`Report: CORTE de red después del producto ${plu} (${reportWritesSinceArm} grabados)`);
      cutAfter = null;
      void stopReport();
    }
  };
}

function startReport(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      reportSockets.add(socket);
      const peer = `${socket.remoteAddress}:${socket.remotePort}`;
      log(`Report: conexión de ${peer}`);
      socket.on("data", (chunk) => {
        const out = report.receive(chunk);
        if (out.length) later(() => socket.destroyed || socket.write(Uint8Array.from(out)));
      });
      socket.on("close", () => {
        reportSockets.delete(socket);
        log(`Report: se cerró la conexión de ${peer}`);
      });
      socket.on("error", () => undefined);
    });
    server.once("error", reject);
    server.listen(REPORT_PORT, HOST, () => {
      reportServer = server;
      log(`Report escuchando en ${HOST}:${REPORT_PORT}`);
      resolve();
    });
  });
}

async function stopReport(): Promise<void> {
  const server = reportServer;
  reportServer = null;
  for (const s of reportSockets) s.destroy();
  reportSockets.clear();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  log("Report fuera de la red");
}

// ── Systel Cuora por TCP (la trama termina con el silencio, como en el cable) ──────────────────────────────────────
function startSystel(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      log(`Systel: conexión de ${socket.remoteAddress}:${socket.remotePort}`);
      let buffer: number[] = [];
      let timer: NodeJS.Timeout | null = null;
      socket.on("data", (chunk) => {
        buffer.push(...chunk);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const frame = Uint8Array.from(buffer);
          buffer = [];
          void cuora.exchange(frame).then((reply) => {
            if (reply) later(() => socket.destroyed || socket.write(reply));
          });
        }, 15);
      });
      socket.on("error", () => undefined);
    });
    server.once("error", reject);
    server.listen(SYSTEL_PORT, HOST, () => {
      log(`Systel escuchando en ${HOST}:${SYSTEL_PORT}`);
      resolve();
    });
  });
}

// ── Estado ────────────────────────────────────────────────────────────────────────────────────────────────────────
const PLU_FIELD_WIDTHS = [6, 3, 3, 26, 26, 5, 1, 7, 6, 6, 6, 6, 6, 5, 5, 2, 4, 4, 4, 4];
function reportFields(data: string): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const w of PLU_FIELD_WIDTHS) {
    out.push(data.slice(pos, pos + w));
    pos += w;
  }
  return out;
}

function estado(): Record<string, unknown> {
  const reportPlus = [...report.records.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([plu, data]) => {
      const f = reportFields(data);
      return { plu, nombre: f[3].trimEnd(), porPeso: f[6] === "P", precio: Number(f[8]), codigo: Number(f[5]), etiqueta: f[15], decimales: f[10] };
    });
  const systelPlus = [...cuora.plus.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, raw]) => {
      const p = parsePluAs(SYSTEL_LAYOUT, raw, n);
      const ean = pluEanSetting(raw, SYSTEL_LAYOUT);
      return p
        ? { plu: n, nombre: p.name.trim(), precio: rawToPesos(p.prices[0] ?? 0, 0), tipo: p.saleType, codigo: p.code, ean: { tipo: ean.type, formato: ean.config } }
        : { plu: n, ilegible: raw };
    });
  return {
    at: new Date().toISOString(),
    report: { enRed: reportServer !== null, plus: reportPlus, codigoDeBarras1070: report.barcodeConfigs, grabados: report.writes.length, comandos: report.commands.length },
    systel: {
      plus: systelPlus,
      escrituras: cuora.received.filter((r) => r.fn === 61 || r.fn === 4 || r.fn === 33).length,
      pedidos: cuora.received.length,
    },
    lentoMs: delayMs,
    eventos: events.slice(-200),
  };
}

// ── Control ───────────────────────────────────────────────────────────────────────────────────────────────────────
const control = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  };
  void (async () => {
    if (req.method === "GET" && url.pathname === "/estado") return send(200, estado());
    if (req.method !== "POST") return send(405, { error: "método" });
    if (url.pathname === "/borrar") {
      report = new FakeReportDevice();
      wireReport(report);
      cuora = newCuora();
      log("Las dos balanzas quedaron vacías");
      return send(200, { ok: true });
    }
    if (url.pathname === "/cortar-report") {
      cutAfter = Math.max(1, Number(url.searchParams.get("despues") ?? "3"));
      reportWritesSinceArm = 0;
      log(`Report: se corta después de ${cutAfter} productos grabados`);
      return send(200, { ok: true, cutAfter });
    }
    if (url.pathname === "/reiniciar-report") {
      cutAfter = null;
      if (!reportServer) await startReport();
      return send(200, { ok: true });
    }
    if (url.pathname === "/lento") {
      delayMs = Math.max(0, Math.min(5000, Number(url.searchParams.get("ms") ?? "0")));
      log(`Respuestas con ${delayMs} ms de demora`);
      return send(200, { ok: true, delayMs });
    }
    return send(404, { error: "no existe" });
  })().catch((error) => send(500, { error: String(error) }));
});

wireReport(report);
await startReport();
await startSystel();
await new Promise<void>((resolve) => control.listen(CONTROL_PORT, "127.0.0.1", resolve));
log(`Control en http://127.0.0.1:${CONTROL_PORT}`);
