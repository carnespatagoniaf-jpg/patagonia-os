// Nube FALSA local para la prueba de actualización en una PC limpia (.github/workflows/scale-connect-update-e2e.yml).
// En vez de staging: la PC del runner habla con esto en 127.0.0.1. Nada sale de la máquina.
//
// - scale-connect-pair + scale-connect-api en http://127.0.0.1:<nube>/functions/v1: es la nube simulada de las pruebas
//   del conector (src/cloud/test-fake-cloud.ts, mismas rutas, encabezado y códigos que las migraciones 226/227), con
//   /update y /update-report validados con la lógica pura de la Edge Function (supabase/functions/scale-connect-api/
//   connect.ts) y la oferta con la forma de scale_connector_update_offer (migración 229):
//   {ok, channel, offer: {version, channel, url, sha256, size, manifest}}.
// - Los instaladores por HTTPS en https://127.0.0.1:<archivos>/instaladores/… (el manifiesto exige https: el
//   certificado lo arma el workflow y el runner lo agrega con NODE_EXTRA_CA_CERTS).
// - Los manifiestos se firman acá, en memoria, con la clave EFÍMERA del runner (variable SCALE_CONNECT_UPDATE_KEY o
//   --clave <archivo> en RUNNER_TEMP; nunca un archivo del repo), con createSignedManifest (scripts/lib/update-manifest.mjs).
//
// Control en http://127.0.0.1:<control> (solo el workflow):
//   GET  /estado                         conectores (sin secretos), pedidos e informes de actualización, descargas
//   GET  /llamadas?desde=<ms>            cada pedido a la nube (ruta, código HTTP, versión del conector)
//   POST /codigo      {codigo}           código de vinculación (un uso)
//   POST /oferta      {version|null, variante?, de?}   variante: buena | firma-mala | sha-malo
//   POST /identificar {host, port}       trabajo "read" identify (como "Agregar balanza → En esta computadora")
//   POST /registrar   {jobId, key}       registra la Kretz encontrada y la vincula a su puerto (bind_scale_to_connector)
//   POST /envio       {key, productos}   trabajo "send" con N productos (sendPayload de la web)
//   GET  /trabajo?id=<id>                estado del trabajo y resultado por producto
//
// Uso: node --import tsx e2e/nube-falsa.ts --dir <instaladores> --cert <pem> --key <pem> --clave <pem> [--nube 9400]
//      [--control 9401] [--archivos 9443]

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { FakeCloud } from "../src/cloud/test-fake-cloud";
import { catalog } from "../src/protocols/testing/harness";
import { createSignedManifest, loadPrivateKey } from "../scripts/lib/update-manifest.mjs";
import { foundScales, IDENTIFY_SCALE_KEY, parseJobItems, sendPayload } from "../../web/src/features/scales/connect/scale-connect-jobs";

type Obj = Record<string, any>;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v) return v;
  if (fallback === undefined) throw new Error(`Falta --${name}`);
  return fallback;
}

const DIR = path.resolve(arg("dir"));
const CLOUD_PORT = Number(arg("nube", "9400"));
const CONTROL_PORT = Number(arg("control", "9401"));
const FILES_PORT = Number(arg("archivos", "9443"));
const TLS = { cert: readFileSync(arg("cert")), key: readFileSync(arg("key")) };
// --clave <archivo>: PEM de la privada efímera (en RUNNER_TEMP, fuera del repo; el workflow lo borra al final).
const privateKey = loadPrivateKey(process.env.SCALE_CONNECT_UPDATE_KEY || readFileSync(arg("clave"), "utf8"));
// La clave ya está en memoria: que no la herede nada que arranque este proceso.
delete process.env.SCALE_CONNECT_UPDATE_KEY;

const log = (text: string) => process.stdout.write(`${new Date().toISOString()} ${text}\n`);

// ── Nube ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const cloud = new FakeCloud();
// Consulta larga más parecida a la real (la función espera hasta 25 s; acá 5 s alcanza y no demora la prueba).
cloud.claimWaitMs = 5000;
const calls: Array<{ at: number; path: string; status: number; connectorVersion: string | null }> = [];
cloud.server.prependListener("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
  const at = Date.now();
  const p = (req.url ?? "").replace(/^\/functions\/v1\//, "");
  const id = String(req.headers["x-scale-connector"] ?? "").split(".")[0];
  res.on("finish", () => {
    calls.push({ at, path: p, status: res.statusCode, connectorVersion: cloud.connectors.get(id)?.version ?? null });
    if (calls.length > 20000) calls.shift();
    if (p.includes("update")) log(`nube: ${p} → ${res.statusCode}`);
  });
});
// Cada informe de actualización con la hora en que llegó.
const reportsAt: string[] = [];
const pushReport = cloud.updateReports.push.bind(cloud.updateReports);
cloud.updateReports.push = (...items: Obj[]) => {
  for (const i of items) {
    reportsAt.push(new Date().toISOString());
    log(`nube: informe de actualización ${JSON.stringify(i)}`);
  }
  return pushReport(...items);
};

// ── Ofertas ──────────────────────────────────────────────────────────────────────────────────────────────────────
const installerName = (v: string) => `PatagoniaScaleConnect-Setup-${v}.exe`;
const fileUrl = (name: string) => `https://127.0.0.1:${FILES_PORT}/instaladores/${name}`;
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function makeOffer(input: Obj): Promise<Obj | null> {
  const version = input.version;
  if (version === null || version === undefined) return null;
  const variante = String(input.variante ?? "buena");
  // `de`: de qué instalador se toman los bytes (por omisión, el de esa versión).
  const source = path.join(DIR, installerName(String(input.de ?? version)));
  if (!existsSync(source)) throw new Error(`No está ${source}`);
  const bytes = await readFile(source);
  let name = path.basename(source);
  if (variante === "sha-malo") {
    // Mismo tamaño, un byte cambiado: lo único que lo delata es el SHA-256.
    const bad = Buffer.from(bytes);
    bad[bad.length - 1] ^= 0xff;
    name = `adulterado-${version}.exe`;
    await writeFile(path.join(DIR, name), bad);
  }
  const manifest: Obj = createSignedManifest(
    { version, channel: "general", minVersion: "9.0.0", url: fileUrl(name), sha256: sha256(bytes), size: bytes.length },
    privateKey,
  );
  if (variante === "firma-mala") {
    // Firma con el largo correcto pero que no es de este manifiesto (como si alguien cambiara la URL y no la firma).
    const sig = Buffer.from(manifest.signature, "base64");
    sig[10] ^= 0x01;
    manifest.signature = sig.toString("base64");
  } else if (variante !== "buena" && variante !== "sha-malo") throw new Error(`Variante desconocida: ${variante}`);
  // La forma de scale_connector_update_offer (229).
  return { version, channel: "stable", url: manifest.url, sha256: manifest.sha256, size: manifest.size, manifest };
}

// ── Archivos (HTTPS) ─────────────────────────────────────────────────────────────────────────────────────────────
const downloads: Array<{ at: string; name: string; bytes: number }> = [];
const files = https.createServer(TLS, (req, res) => {
  void (async () => {
    const m = /^\/instaladores\/([A-Za-z0-9._-]+\.exe)$/.exec(req.url ?? "");
    const file = m ? path.join(DIR, m[1]) : null;
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const body = await readFile(file);
    downloads.push({ at: new Date().toISOString(), name: m![1], bytes: body.length });
    log(`archivos: bajaron ${m![1]} (${body.length} bytes)`);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
    res.end(body);
  })().catch(() => res.writeHead(500).end());
});

// ── Trabajos ─────────────────────────────────────────────────────────────────────────────────────────────────────
function jobView(id: string): Obj | null {
  const j = cloud.jobs.find((x) => x.id === id);
  if (!j) return null;
  // El último resultado de cada producto (el avance y el cierre pueden repetir alguno).
  const byPlu = new Map<string, ReturnType<typeof parseJobItems>[number]>();
  for (const item of parseJobItems(j.items)) byPlu.set(item.plu ?? `${byPlu.size}`, item);
  const items = [...byPlu.values()];
  const count = (s: string) => items.filter((i) => i.status === s).length;
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    error: j.error,
    queuedAt: new Date(j.queuedAt).toISOString(),
    claimedAt: j.claimedAt ? new Date(j.claimedAt).toISOString() : null,
    finishedAt: j.finishedAt ? new Date(j.finishedAt).toISOString() : null,
    progress: j.progress.at(-1) ?? null,
    items: items.length,
    confirmed: count("confirmed"),
    failed: count("failed"),
    skipped: count("skipped"),
    reasons: items.filter((i) => i.status !== "confirmed").map((i) => `${i.plu}: ${i.reason}`).slice(0, 20),
  };
}

function onlyConnector(): string {
  const list = [...cloud.connectors.values()].filter((c) => !c.revoked);
  if (list.length !== 1) throw new Error(`Se esperaba una sola PC vinculada (hay ${list.length})`);
  return list[0].id;
}

// ── Control ──────────────────────────────────────────────────────────────────────────────────────────────────────
const control = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  };
  void (async () => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body: Obj = text ? JSON.parse(text) : {};
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /estado":
        return send(200, {
          at: new Date().toISOString(),
          connectors: [...cloud.connectors.values()].map((c) => ({
            id: c.id,
            name: c.name,
            fingerprint: c.fingerprint,
            version: c.version,
            revoked: c.revoked,
            lastSeen: c.lastSeen ? new Date(c.lastSeen).toISOString() : null,
            scales: c.scales.map((s) => s.key),
          })),
          offer: cloud.updateOffer ? { version: cloud.updateOffer.version, url: (cloud.updateOffer as Obj).url } : null,
          updateRequests: cloud.updateRequests,
          updateReports: cloud.updateReports.map((r, i) => ({ ...r, recibido: reportsAt[i] ?? null })),
          downloads,
          jobs: cloud.jobs.map((j) => jobView(j.id)),
        });
      case "GET /llamadas": {
        const since = Number(url.searchParams.get("desde") ?? "0");
        return send(200, calls.filter((c) => c.at >= since).map((c) => ({ ...c, at: new Date(c.at).toISOString() })));
      }
      case "POST /codigo":
        cloud.addCode(String(body.codigo).replace(/[\s-]/g, "").toUpperCase());
        return send(200, { ok: true });
      case "POST /oferta": {
        const offer = await makeOffer(body);
        cloud.updateOffer = offer as FakeCloud["updateOffer"];
        log(`oferta: ${offer ? `${offer.version} (${body.variante ?? "buena"})` : "ninguna"}`);
        return send(200, { ok: true, offer: offer ? { version: offer.version, url: offer.url, sha256: offer.sha256, size: offer.size } : null });
      }
      case "POST /identificar": {
        const job = cloud.queueJob({
          scaleKey: IDENTIFY_SCALE_KEY,
          kind: "read",
          connectorId: onlyConnector(),
          payload: { mode: "identify", network: [{ host: String(body.host), port: Number(body.port ?? 1001) }] },
        });
        return send(200, { ok: true, id: job.id });
      }
      case "POST /registrar": {
        const job = cloud.jobs.find((j) => j.id === body.jobId);
        if (!job) return send(404, { error: "no existe el trabajo" });
        const kretz = foundScales(parseJobItems(job.items)).find((f) => f.family === "kretz");
        if (!kretz) return send(400, { error: "el trabajo no encontró una Kretz", items: job.items });
        const key = String(body.key ?? "kretz-1");
        cloud.scales.push({ key, name: kretz.label, family: "kretz", model: kretz.model, identity: kretz.identity, active: true, connectorId: onlyConnector(), device: kretz.device as Obj });
        return send(200, { ok: true, key, device: kretz.device });
      }
      case "POST /envio": {
        const products = catalog(Number(body.productos ?? 40), 1, 26).map((p) => ({ ...p, priceRetail: p.priceRetail + Number(body.suma ?? 0) }));
        const job = cloud.queueJob({ scaleKey: String(body.key ?? "kretz-1"), kind: "send", connectorId: onlyConnector(), payload: sendPayload(products, { canManageLinks: true }) });
        return send(200, { ok: true, id: job.id });
      }
      case "GET /trabajo": {
        const view = jobView(url.searchParams.get("id") ?? "");
        return view ? send(200, view) : send(404, { error: "no existe" });
      }
      default:
        return send(404, { error: `no existe ${route}` });
    }
  })().catch((error) => send(500, { error: error instanceof Error ? error.message : String(error) }));
});

await cloud.start(CLOUD_PORT);
await new Promise<void>((resolve) => files.listen(FILES_PORT, "127.0.0.1", resolve));
await new Promise<void>((resolve) => control.listen(CONTROL_PORT, "127.0.0.1", resolve));
log(`Nube falsa en ${cloud.baseUrl}, instaladores en https://127.0.0.1:${FILES_PORT}/instaladores/, control en http://127.0.0.1:${CONTROL_PORT}`);
