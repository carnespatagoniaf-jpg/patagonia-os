/**
 * Captura de lo que manda iTegra / JDataGate a una Kretz Aura, SIN la balanza.
 *
 * Levanta un servidor TCP local que se hace pasar por la Aura (H01) y guarda
 * cada byte recibido y enviado en un archivo JSON. Ver docs/AURA_CAPTURA_ITEGRA.md.
 *
 * Uso (desde patagonia-os-v312):
 *   npx tsx scripts/aura-captura.ts [puerto] [archivo]
 * Por defecto: puerto 1001 (el del ejemplo de COM.JDG en el protocolo de Kretz)
 * y archivo captura-aura-<fecha>.json.
 *
 * Solo escucha en 127.0.0.1 (esta misma PC). No se conecta a ninguna balanza real.
 */
import fs from "node:fs";
import net from "node:net";
import { FakeAuraDevice } from "../apps/web/src/features/inventory/kretz/aura-fake-device";

const port = Number(process.argv[2] ?? 1001);
const file = process.argv[3] ?? `captura-aura-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const device = new FakeAuraDevice();

function save() {
  fs.writeFileSync(file, JSON.stringify({ port, savedAt: new Date().toISOString(), log: device.log, records: device.records }, null, 2));
}

const server = net.createServer((socket) => {
  console.log(`Conexión de ${socket.remoteAddress}:${socket.remotePort}`);
  socket.on("data", (chunk) => {
    const before = device.log.length;
    const reply = device.receive(chunk);
    if (reply.length) socket.write(Buffer.from(reply));
    for (const e of device.log.slice(before)) console.log(`${e.note}\n  recibido: ${e.rxAscii}\n  hex: ${e.rxHex}`);
    save();
  });
  socket.on("close", () => console.log("Conexión cerrada"));
  socket.on("error", (err) => console.log(`Error de conexión: ${err.message}`));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Aura de prueba escuchando en 127.0.0.1:${port}. Guardando en ${file}`);
  console.log("Configurá en iTegra una balanza Aura por TCP con IP 127.0.0.1 y este puerto. Ctrl+C para terminar.");
});
