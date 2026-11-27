import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createLocalServer } from "./local-server";
import { isAllowedHost, isAllowedOrigin } from "./security";

test("orígenes permitidos: los mismos que el programa de impresión", () => {
  for (const ok of [
    "https://patagoniasystem.com.ar",
    "https://app.patagoniasystem.com.ar",
    "https://a.b.patagoniasystem.com.ar",
    "http://localhost",
    "http://localhost:5173",
    "http://127.0.0.1:8080",
  ]) assert.equal(isAllowedOrigin(ok), true, ok);
  for (const bad of [
    "http://app.patagoniasystem.com.ar",
    "https://patagoniasystem.com.ar.evil.com",
    "https://evilpatagoniasystem.com.ar",
    "https://localhost:5173",
    "http://localhost.evil.com",
    "null",
    "",
    undefined,
  ]) assert.equal(isAllowedOrigin(bad), false, String(bad));
});

test("host permitido: solo 127.0.0.1 o localhost con el puerto exacto", () => {
  assert.equal(isAllowedHost("127.0.0.1:9120", 9120), true);
  assert.equal(isAllowedHost("LOCALHOST:9120", 9120), true);
  assert.equal(isAllowedHost("evil.com:9120", 9120), false);
  assert.equal(isAllowedHost("127.0.0.1", 9120), false);
  assert.equal(isAllowedHost("127.0.0.1:9121", 9120), false);
  assert.equal(isAllowedHost(undefined, 9120), false);
});

test("no se puede escuchar fuera de loopback", () => {
  assert.throws(() => createLocalServer({ port: 0, host: "0.0.0.0", getStatus: () => ({}) }), /127\.0\.0\.1/);
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function request(port: number, options: { method?: string; path?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? "/status", headers: options.headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data ? JSON.parse(data) : null }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withServer(fn: (port: number) => Promise<void>) {
  const server = createLocalServer({ port: 0, getStatus: () => ({ version: "9.9.9", devices: [{ id: "b1", state: "ready" }] }) });
  const address = await server.listen();
  assert.equal(address.address, "127.0.0.1");
  try {
    await fn(address.port);
  } finally {
    await server.close();
  }
}

test("GET /status devuelve versión y dispositivos, con CORS para Patagonia", async () => {
  await withServer(async (port) => {
    const r = await request(port, { headers: { Host: `127.0.0.1:${port}`, Origin: "https://app.patagoniasystem.com.ar" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.version, "9.9.9");
    assert.equal(r.body.devices[0].id, "b1");
    assert.equal(r.headers["access-control-allow-origin"], "https://app.patagoniasystem.com.ar");
    assert.equal(r.headers["cache-control"], "no-store");
  });
});

test("GET /status sin Origin (curl, soporte) también responde, sin CORS", async () => {
  await withServer(async (port) => {
    const r = await request(port, { headers: { Host: `localhost:${port}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  });
});

test("Host ajeno (DNS rebinding) = 403", async () => {
  await withServer(async (port) => {
    const r = await request(port, { headers: { Host: `atacante.com:${port}`, Origin: "https://app.patagoniasystem.com.ar" } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "host no permitido");
  });
});

test("Origin ajeno = 403 y sin CORS", async () => {
  await withServer(async (port) => {
    const r = await request(port, { headers: { Host: `127.0.0.1:${port}`, Origin: "https://evil.example" } });
    assert.equal(r.status, 403);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  });
});

test("preflight: permitido para Patagonia (con red privada), rechazado sin origen", async () => {
  await withServer(async (port) => {
    const ok = await request(port, {
      method: "OPTIONS",
      headers: { Host: `127.0.0.1:${port}`, Origin: "http://localhost:5173", "Access-Control-Request-Private-Network": "true" },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-private-network"], "true");
    assert.equal(ok.headers["access-control-allow-methods"], "GET, OPTIONS");
    const bad = await request(port, { method: "OPTIONS", headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(bad.status, 403);
  });
});

test("no hay escrituras: POST/PUT/DELETE = 405, rutas desconocidas = 404", async () => {
  await withServer(async (port) => {
    const headers = { Host: `127.0.0.1:${port}`, Origin: "https://app.patagoniasystem.com.ar" };
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await request(port, { method, path: "/status", headers });
      assert.equal(r.status, 405, method);
    }
    for (const p of ["/scale/send", "/write", "/"]) {
      const r = await request(port, { path: p, headers });
      assert.equal(r.status, 404, p);
    }
  });
});
