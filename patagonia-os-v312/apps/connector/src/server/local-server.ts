// Canal local en 127.0.0.1:9120. Solo lectura: informa versión, balanzas y
// estado. No hay ningún endpoint que escriba en una balanza (plan 5.4: una
// página maliciosa abierta en esta PC no puede mandarle productos).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { isAllowedHost, isAllowedOrigin, isLoopbackBindAddress } from "./security";
import { silentLogger, type Logger } from "../log/logger";

export interface LocalServerOptions {
  port: number;
  host?: string;
  getStatus: () => unknown;
  logger?: Logger;
}

export interface LocalServer {
  readonly server: http.Server;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  extraHeaders: Record<string, string> = {},
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Allow-Private-Network"] = "true";
  }
  res.writeHead(status, headers);
  res.end(body === null ? undefined : JSON.stringify(body));
}

export function createLocalServer(options: LocalServerOptions): LocalServer {
  const bindHost = options.host ?? "127.0.0.1";
  if (!isLoopbackBindAddress(bindHost)) {
    throw new Error(`El canal local solo puede escuchar en 127.0.0.1 (se pidió ${bindHost}).`);
  }
  const log = options.logger ?? silentLogger;
  let boundPort = options.port;

  const server = http.createServer((req, res) => {
    try {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const host = req.headers.host;

      // 1) Defensa contra DNS rebinding: el Host tiene que ser esta PC.
      if (!isAllowedHost(host, boundPort)) {
        log.warn("Pedido rechazado: host no permitido", { host });
        return send(res, 403, { ok: false, error: "host no permitido" }, undefined);
      }
      // 2) Si viene de un navegador, el origen tiene que ser Patagonia (o localhost).
      if (origin !== undefined && !isAllowedOrigin(origin)) {
        log.warn("Pedido rechazado: origen no permitido", { origin });
        return send(res, 403, { ok: false, error: "origen no permitido" }, undefined);
      }

      const url = new URL(req.url ?? "/", `http://${host}`);

      if (req.method === "OPTIONS") {
        if (!origin) return send(res, 403, { ok: false, error: "falta el origen" }, undefined);
        return send(res, 204, null, origin, {
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Max-Age": "600",
        });
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return send(res, 405, { ok: false, error: "método no permitido" }, origin, { Allow: "GET, OPTIONS" });
      }

      if (url.pathname === "/status") {
        return send(res, 200, { ok: true, ...(options.getStatus() as Record<string, unknown>) }, origin);
      }

      return send(res, 404, { ok: false, error: "no existe" }, origin);
    } catch (error) {
      log.error("Error atendiendo un pedido local", { error });
      if (!res.headersSent) send(res, 500, { ok: false, error: "error interno" }, undefined);
      else res.end();
    }
  });
  // Pedidos lentos o abiertos de más no pueden trabar el canal.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  return {
    server,
    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: bindHost, port: options.port, exclusive: true }, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo;
          boundPort = address.port;
          resolve(address);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
