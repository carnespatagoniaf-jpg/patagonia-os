// TcpByteLink: balanza por red (Kretz puerto 1001, Systel 10001) con node:net.

import net from "node:net";
import { BaseByteLink } from "./byte-link";
import { LinkError, classifyOpenError } from "./link-error";

export interface TcpByteLinkOptions {
  host: string;
  port: number;
  /** Tiempo máximo para conectar, en ms. */
  connectTimeoutMs?: number;
  /** Keep-alive de TCP para notar un cable cortado sin tráfico. */
  keepAliveMs?: number;
}

export class TcpByteLink extends BaseByteLink {
  readonly label: string;
  private socket: net.Socket | null = null;
  private readonly options: Required<TcpByteLinkOptions>;

  constructor(options: TcpByteLinkOptions) {
    super();
    this.options = { connectTimeoutMs: 5000, keepAliveMs: 10_000, ...options };
    this.label = `${options.host}:${options.port}`;
  }

  protected doOpen(): Promise<void> {
    const { host, port, connectTimeoutMs, keepAliveMs } = this.options;
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let connected = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new LinkError("unreachable", `No se pudo conectar con ${this.label} en ${connectTimeoutMs} ms.`),
        );
      }, connectTimeoutMs);

      socket.once("connect", () => {
        connected = true;
        clearTimeout(timer);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, keepAliveMs);
        this.socket = socket;
        resolve();
      });
      socket.on("data", (chunk: Buffer) => this.receive(chunk));
      socket.on("error", (error) => {
        if (!connected) {
          clearTimeout(timer);
          reject(classifyOpenError(error, this.label));
          return;
        }
        this.lost(error);
      });
      socket.on("close", () => {
        if (connected) this.lost(new Error("la balanza cerró la conexión"));
      });
    });
  }

  protected doWrite(data: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new LinkError("closed", `${this.label} no está abierto.`));
    return new Promise<void>((resolve, reject) => {
      socket.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  protected async doClose(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
  }
}
