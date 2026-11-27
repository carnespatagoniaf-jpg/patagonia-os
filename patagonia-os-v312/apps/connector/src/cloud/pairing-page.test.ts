import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createLocalServer } from "../server/local-server";
import { CloudAgent } from "./cloud-agent";
import { CloudClient } from "./cloud-client";
import { MemoryCredentialStore } from "./credential-store";
import { UnavailableExecutor } from "./job-executor";
import { createPairingRoute, escapeHtml, isSelfOrigin } from "./pairing-page";
import { FakeCloud } from "./test-fake-cloud";

const CSRF = "token-de-prueba-123";

function request(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path ?? "/vincular", headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function setup(t: test.TestContext) {
  const cloud = new FakeCloud();
  await cloud.start();
  const store = new MemoryCredentialStore();
  const agent = new CloudAgent({
    client: new CloudClient({ baseUrl: cloud.baseUrl }),
    store,
    executor: new UnavailableExecutor(),
    version: "1",
    seenScales: () => [],
    fingerprint: async () => "c".repeat(64),
    heartbeatMs: 1000,
    pollWaitSec: 0,
    minPollGapMs: 50,
  });
  await agent.start();
  const server = createLocalServer({ port: 0, getStatus: () => ({ cloud: agent.status() }), routes: [createPairingRoute({ agent, csrfToken: CSRF })] });
  const { port } = await server.listen();
  t.after(async () => {
    await agent.stop();
    await server.close();
    await cloud.stop();
  });
  const post = (fields: Record<string, string>, origin: string | null = `http://127.0.0.1:${port}`) =>
    request(port, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}) }, body: form(fields) });
  return { cloud, agent, store, port, post };
}

test("Origin propio exacto", () => {
  assert.equal(isSelfOrigin("http://127.0.0.1:9120", 9120), true);
  assert.equal(isSelfOrigin("http://localhost:9120", 9120), true);
  assert.equal(isSelfOrigin("http://localhost:5173", 9120), false);
  assert.equal(isSelfOrigin("https://app.patagoniasystem.com.ar", 9120), false);
  assert.equal(isSelfOrigin(undefined, 9120), false);
  assert.equal(escapeHtml(`<b a="x">'&`), "&lt;b a=&quot;x&quot;&gt;&#39;&amp;");
});

test("la página muestra el formulario con token, sin iframes, y /status sigue andando", async (t) => {
  const { port } = await setup(t);
  const page = await request(port, {});
  assert.equal(page.status, 200);
  assert.match(page.body, /Vincular esta computadora/);
  assert.match(page.body, new RegExp(`name="csrf" value="${CSRF}"`));
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  const status = await request(port, { path: "/status" });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).cloud.state, "sin_vincular");
  // Host ajeno (DNS rebinding): ni la página.
  assert.equal((await request(port, { headers: { Host: `evil.com:${port}` } })).status, 403);
});

test("una página de afuera no puede vincular esta PC", async (t) => {
  const { post, cloud, agent } = await setup(t);
  cloud.addCode("ABCDEFGH", "OTRA");
  // La web de Patagonia, otro puerto local o sin Origin: no.
  assert.equal((await post({ csrf: CSRF, code: "ABCDEFGH", name: "x" }, "https://app.patagoniasystem.com.ar")).status, 403);
  assert.equal((await post({ csrf: CSRF, code: "ABCDEFGH", name: "x" }, "http://localhost:5173")).status, 403);
  assert.equal((await post({ csrf: CSRF, code: "ABCDEFGH", name: "x" }, null)).status, 403);
  assert.equal((await post({ csrf: CSRF, code: "ABCDEFGH", name: "x" }, "https://evil.com")).status, 403);
  // Mismo origen pero sin el token.
  assert.equal((await post({ csrf: "otro", code: "ABCDEFGH", name: "x" })).status, 403);
  assert.equal(agent.isPaired, false);
  assert.equal(cloud.codes.get("ABCDEFGH")!.used, false);
});

test("código malo → mensaje claro; código bueno → vinculada; después no hay formulario", async (t) => {
  const { post, cloud, agent, port } = await setup(t);
  const bad = await post({ csrf: CSRF, code: "ZZZZ-ZZZZ", name: "Caja 1" });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /no es válido/);
  assert.match(bad.body, /value="Caja 1"/, "conserva lo escrito");

  cloud.addCode("ABCDEFGH");
  const ok = await post({ csrf: CSRF, code: "abcd-efgh", name: "Caja <1>" });
  assert.equal(ok.status, 200);
  assert.match(ok.body, /vinculada como <b>Caja &lt;1&gt;<\/b>/);
  assert.equal(agent.isPaired, true);
  assert.equal(ok.body.includes([...cloud.connectors.values()][0].secret), false, "el secreto no aparece en la página");

  const again = await request(port, {});
  assert.doesNotMatch(again.body, /<form/);
  cloud.addCode("JKLMNPQR");
  assert.equal((await post({ csrf: CSRF, code: "JKLMNPQR", name: "Otra" })).status, 409);
  assert.equal(cloud.codes.get("JKLMNPQR")!.used, false);
});

test("reinstalación desde la página: ¿Es Caja 1? → Sí", async (t) => {
  const { post, cloud, agent } = await setup(t);
  cloud.connectors.set("3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b", {
    id: "3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b",
    secret: "viejo",
    company: "A",
    name: "Caja 1",
    fingerprint: "c".repeat(64),
    revoked: false,
    version: null,
    lastSeen: null,
    scales: [],
  });
  cloud.addCode("ABCDEFGH");
  const ask = await post({ csrf: CSRF, code: "ABCDEFGH", name: "PC nueva" });
  assert.equal(ask.status, 200);
  assert.match(ask.body, /¿Es Caja 1\?/);
  assert.match(ask.body, /name="recover_id" value="3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b"/);
  assert.match(ask.body, /No, es otra computadora/);
  const yes = await post({ csrf: CSRF, code: "ABCDEFGH", recover_id: "3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b" });
  assert.equal(yes.status, 200);
  assert.match(yes.body, /Computadora recuperada/);
  assert.equal(agent.status().connectorId, "3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b");
});
