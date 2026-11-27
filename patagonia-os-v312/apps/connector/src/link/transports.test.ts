// Pruebas de los transportes reales: TCP contra un servidor local de verdad y
// serie contra SerialPortMock (el simulador oficial de serialport).

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { SerialPortMock } from "serialport";
import { TcpByteLink } from "./tcp-byte-link";
import { SerialByteLink, type SerialPortLike } from "./serial-byte-link";
import { isLinkError } from "./link-error";

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

function startEchoServer(onSocket?: (s: net.Socket) => void): Promise<{ port: number; server: net.Server; sockets: net.Socket[] }> {
  return new Promise((resolve) => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      if (onSocket) onSocket(socket);
      else socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("R:"), d])));
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, server, sockets }));
  });
}

test("TcpByteLink: conecta, escribe y lee la respuesta", async () => {
  const { port, server } = await startEchoServer();
  const link = new TcpByteLink({ host: "127.0.0.1", port });
  await link.open();
  await link.write(Buffer.from("0001"));
  assert.equal(text(await link.read({ timeoutMs: 1000, until: (b) => b.length >= 6 })), "R:0001");
  await link.close();
  server.close();
});

test("TcpByteLink: si la balanza corta, avisa desconexión", async () => {
  const { port, server, sockets } = await startEchoServer(() => undefined);
  const link = new TcpByteLink({ host: "127.0.0.1", port });
  await link.open();
  const disconnected = new Promise((resolve) => link.onDisconnect(resolve));
  const reading = link.read({ timeoutMs: 2000 });
  sockets[0].destroy();
  await disconnected;
  await assert.rejects(reading, (e) => isLinkError(e, "closed"));
  server.close();
});

test("TcpByteLink: puerto cerrado = 'refused'", async () => {
  const { port, server } = await startEchoServer();
  await new Promise<void>((r) => server.close(() => r()));
  const link = new TcpByteLink({ host: "127.0.0.1", port, connectTimeoutMs: 2000 });
  await assert.rejects(link.open(), (e) => isLinkError(e, "refused"));
});

test("SerialByteLink: abre, escribe y lee con SerialPortMock", async () => {
  SerialPortMock.binding.reset();
  SerialPortMock.binding.createPort("COM7", { echo: true, record: true });
  const link = new SerialByteLink({
    path: "COM7",
    baudRate: 9600,
    stopBits: 2,
    createPort: (s) => new SerialPortMock({ ...s, autoOpen: false }) as unknown as SerialPortLike,
  });
  await link.open();
  await link.write(Buffer.from("W"));
  assert.equal(text(await link.read({ timeoutMs: 1000 })), "W");
  await link.close();
  assert.equal(link.isOpen, false);
});

test("SerialByteLink: un puerto que no existe no queda abierto y da un error claro", async () => {
  SerialPortMock.binding.reset();
  const link = new SerialByteLink({
    path: "COM42",
    baudRate: 9600,
    createPort: (s) => new SerialPortMock({ ...s, autoOpen: false }) as unknown as SerialPortLike,
  });
  await assert.rejects(link.open(), (e) => isLinkError(e));
  assert.equal(link.isOpen, false);
});
