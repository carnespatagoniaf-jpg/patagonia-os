import assert from "node:assert/strict";
import { describe, it } from "node:test";
// La lógica pura de las Edge Functions scale-connect-pair y scale-connect-api se prueba desde acá
// (el repo no corre tests de Deno).
import {
  apiRoute,
  clientAddress,
  formatConnectorCredential,
  formatPairingCode,
  generateSecret,
  isJsonRequest,
  isPairingCodeFormat,
  longPollClaim,
  maxBodyFor,
  MAX_FINISH_BODY,
  MAX_SMALL_BODY,
  normalizePairingCode,
  pairStatus,
  parseClaimRequest,
  parseConnectorCredential,
  parseEngineRequest,
  parseFinishRequest,
  parseHeartbeatRequest,
  parsePairRequest,
  parseProgressRequest,
  readJsonLimited,
  rpcErrorBody,
  rpcErrorStatus,
  sha256Hex
} from "../../../../../supabase/functions/scale-connect-api/connect";

const ID = "3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b";
const HEX = "a".repeat(64);

describe("credencial del conector", () => {
  it("el secreto tiene 256 bits en base64url y cambia cada vez", () => {
    const a = generateSecret();
    const b = generateSecret();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.equal(generateSecret((bytes) => bytes.fill(255)), "_".repeat(42) + "8");
  });

  it("lee id.secreto y rechaza lo raro", async () => {
    const secret = generateSecret();
    const header = formatConnectorCredential({ id: ID, secret });
    assert.deepEqual(parseConnectorCredential(header), { id: ID, secret });
    assert.deepEqual(parseConnectorCredential(` ${ID.toUpperCase()}.${secret} `), { id: ID, secret });
    for (const bad of [null, "", "x", `${ID}`, `${ID}.`, `${ID}.corto`, `no-uuid.${secret}`, `${ID}.${secret}!`, `${ID}.${"a".repeat(300)}`]) {
      assert.equal(parseConnectorCredential(bad), null, String(bad));
    }
  });

  it("SHA-256 en hex (lo único que va a la base)", async () => {
    assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("código de vinculación", () => {
  it("normaliza como lo escribe la gente y valida el alfabeto sin 0/O/1/I", () => {
    assert.equal(normalizePairingCode(" abcd-efgh "), "ABCDEFGH");
    assert.equal(isPairingCodeFormat("ABCDEFGH"), true);
    assert.equal(isPairingCodeFormat("ABCDEFG2"), true);
    for (const bad of ["ABCDEFG0", "ABCDEFGO", "ABCDEFG1", "ABCDEFGI", "ABCDEFG", "ABCDEFGHJ"]) assert.equal(isPairingCodeFormat(bad), false, bad);
    assert.equal(formatPairingCode("abcdefgh"), "ABCD-EFGH");
  });

  it("pedido de canje: código, nombre, huella y recuperación", () => {
    const ok = parsePairRequest({ code: "abcd-efgh", name: "  Caja   1 ", fingerprint: HEX, version: "0.2.0" });
    assert.deepEqual(ok, { ok: true, value: { code: "ABCDEFGH", name: "Caja 1", fingerprintHash: HEX, version: "0.2.0", recoverId: null, forceNew: false } });
    // Recuperar no necesita nombre (se queda con el que tenía).
    const rec = parsePairRequest({ code: "ABCDEFGH", fingerprint: HEX, recover_id: ID.toUpperCase() });
    assert.equal(rec.ok && rec.value.recoverId, ID);
    assert.equal(parsePairRequest({ code: "ABCDEFGH", name: "Caja", force_new: true }).ok && true, true);
    assert.deepEqual(parsePairRequest({ code: "ABCDEFGH" }), { ok: false, error: "nombre_invalido" });
    assert.deepEqual(parsePairRequest({ code: "", name: "x" }), { ok: false, error: "falta_codigo" });
    assert.deepEqual(parsePairRequest({ code: "ABCDEFGH", name: "x".repeat(41) }), { ok: false, error: "nombre_invalido" });
    assert.deepEqual(parsePairRequest({ code: "ABCDEFGH", name: "x", fingerprint: "pc-de-juan" }), { ok: false, error: "huella_invalida" });
    assert.deepEqual(parsePairRequest({ code: "ABCDEFGH", name: "x", recover_id: "1" }), { ok: false, error: "datos_invalidos" });
    assert.deepEqual(parsePairRequest([]), { ok: false, error: "datos_invalidos" });
  });

  it("estado HTTP del canje", () => {
    assert.equal(pairStatus({ ok: true }), 200);
    assert.equal(pairStatus({ ok: false, error: "elegir" }), 409);
    assert.equal(pairStatus({ ok: false, error: "demasiados_intentos" }), 429);
    assert.equal(pairStatus({ ok: false, error: "codigo_invalido" }), 400);
  });

  it("IP de quien pide: la primera de x-forwarded-for", () => {
    const h = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? null });
    assert.equal(clientAddress(h({ "x-forwarded-for": "200.1.2.3, 10.0.0.1" })), "200.1.2.3");
    assert.equal(clientAddress(h({ "x-real-ip": "200.9.9.9" })), "200.9.9.9");
    assert.equal(clientAddress(h({})), "desconocido");
  });

  it("solo JSON: un navegador no puede mandarlo desde otra página sin la consulta previa de CORS", () => {
    const h = (type?: string) => ({ get: (k: string) => (k === "content-type" ? type ?? null : null) });
    assert.equal(isJsonRequest(h("application/json")), true);
    assert.equal(isJsonRequest(h("Application/JSON; charset=utf-8")), true);
    // Los tres tipos "simples" que un formulario o fetch sin CORS puede mandar, y sin tipo.
    for (const t of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", undefined, "application/jsonx"]) {
      assert.equal(isJsonRequest(h(t)), false, String(t));
    }
  });
});

describe("api del conector", () => {
  it("rutas y topes de tamaño", () => {
    assert.equal(apiRoute("/functions/v1/scale-connect-api/claim"), "claim");
    assert.equal(apiRoute("/scale-connect-api/heartbeat/"), "heartbeat");
    assert.equal(apiRoute("/scale-connect-api"), null);
    assert.equal(apiRoute("/scale-connect-api/borrar"), null);
    assert.equal(maxBodyFor("finish"), MAX_FINISH_BODY);
    assert.equal(maxBodyFor("claim"), MAX_SMALL_BODY);
  });

  it("consulta larga: 0 a 25 segundos", () => {
    assert.deepEqual(parseClaimRequest({ wait: 60 }), { ok: true, value: { waitSec: 25 } });
    assert.deepEqual(parseClaimRequest({ wait: -3 }), { ok: true, value: { waitSec: 0 } });
    assert.deepEqual(parseClaimRequest({}), { ok: true, value: { waitSec: 0 } });
    assert.deepEqual(parseClaimRequest({ wait: "x" }), { ok: true, value: { waitSec: 0 } });
    assert.equal(parseClaimRequest([1]).ok, false);
  });

  it("latido: limpia la lista de balanzas", () => {
    const r = parseHeartbeatRequest({ version: "0.2.0", scales: [{ key: "kretz-1", name: "Report", online: true }, { key: "" }, "x", { key: "aura" }] });
    assert.deepEqual(r, { ok: true, value: { version: "0.2.0", scales: [{ key: "kretz-1", name: "Report", online: true }, { key: "aura", name: "aura", online: false }] } });
    assert.equal(parseHeartbeatRequest({ scales: Array.from({ length: 51 }, (_, i) => ({ key: `k${i}` })) }).ok, false);
    assert.equal(parseHeartbeatRequest({ scales: {} }).ok, false);
  });

  it("avance y cierre: trabajo, secuencia, estado, contadores y productos", () => {
    const p = parseProgressRequest({ job_id: ID, seq: 3, done: 5, total: 10, text: "Nalga", items: [{ plu: "1", action: "write", status: "confirmed" }] });
    assert.equal(p.ok && p.value.seq, 3);
    assert.deepEqual(parseProgressRequest({ job_id: ID, seq: 0 }), { ok: false, error: "secuencia_invalida" });
    assert.deepEqual(parseProgressRequest({ job_id: "x", seq: 1 }), { ok: false, error: "trabajo_invalido" });
    assert.deepEqual(parseProgressRequest({ job_id: ID, seq: 1, items: Array.from({ length: 2001 }, () => ({})) }), { ok: false, error: "demasiados_productos" });
    assert.deepEqual(parseProgressRequest({ job_id: ID, seq: 1, items: [1] }), { ok: false, error: "productos_invalidos" });

    const f = parseFinishRequest({ job_id: ID, status: "partial", counters: { confirmed: 2, failed: 1 }, items: [], error: "no_contesta" });
    assert.deepEqual(f, { ok: true, value: { jobId: ID, status: "partial", counters: { confirmed: 2, failed: 1 }, items: [], error: "no_contesta" } });
    assert.deepEqual(parseFinishRequest({ job_id: ID, status: "running" }), { ok: false, error: "estado_invalido" });
    assert.deepEqual(parseFinishRequest({ job_id: ID, status: "done", counters: { confirmed: -1 } }), { ok: false, error: "contadores_invalidos" });
    assert.deepEqual(parseFinishRequest({ job_id: ID, status: "done", counters: { confirmed: 10001 } }), { ok: false, error: "contadores_invalidos" });
  });

  it("errores de la base → HTTP, sin filtrar detalles internos", () => {
    assert.equal(rpcErrorStatus("PT401"), 401);
    assert.equal(rpcErrorStatus("PT403"), 403);
    assert.equal(rpcErrorStatus("PT404"), 404);
    assert.equal(rpcErrorStatus("PT409"), 409);
    assert.equal(rpcErrorStatus("PT429"), 429);
    assert.equal(rpcErrorStatus("P0001"), 400);
    assert.equal(rpcErrorStatus("42883"), 500);
    assert.equal(rpcErrorStatus(undefined), 500);
    assert.deepEqual(rpcErrorBody({ code: "42P01", message: "relation scale_connectors does not exist" }), { ok: false, error: "error_interno" });
    assert.deepEqual(rpcErrorBody({ code: "PT403", message: "Esta computadora fue desvinculada" }), { ok: false, error: "revocado", message: "Esta computadora fue desvinculada" });
  });

  it("cuerpo con tope de tamaño", async () => {
    const small = await readJsonLimited(new Request("http://x", { method: "POST", body: JSON.stringify({ a: 1 }) }), 100);
    assert.deepEqual(small, { ok: true, value: { a: 1 } });
    const big = await readJsonLimited(new Request("http://x", { method: "POST", body: "x".repeat(200) }), 100);
    assert.deepEqual(big, { ok: false, error: "muy_grande" });
    const lying = new Request("http://x", { method: "POST", body: JSON.stringify({ a: "y".repeat(500) }), headers: { "content-length": "10" } });
    assert.deepEqual(await readJsonLimited(lying, 100), { ok: false, error: "muy_grande" });
    assert.deepEqual(await readJsonLimited(new Request("http://x", { method: "POST", body: "{no" }), 100), { ok: false, error: "json_invalido" });
  });
});

describe("motor del conector y huella (migración 227)", () => {
  it("la ruta engine existe y acepta cuerpos como el avance", () => {
    assert.equal(apiRoute("/functions/v1/scale-connect-api/engine"), "engine");
    assert.equal(maxBodyFor("engine"), maxBodyFor("progress"));
  });

  it("engine: solo acciones conocidas, con un trabajo válido", () => {
    assert.deepEqual(parseEngineRequest({ job_id: ID.toUpperCase(), action: "save_branch_config", args: { config: { pluLength: 5 } } }), {
      ok: true,
      value: { jobId: ID, action: "save_branch_config", args: { config: { pluLength: 5 } } }
    });
    assert.deepEqual(parseEngineRequest({ job_id: ID, action: "list_branch_scales" }), { ok: true, value: { jobId: ID, action: "list_branch_scales", args: {} } });
    assert.deepEqual(parseEngineRequest({ job_id: ID, action: "drop_table" }), { ok: false, error: "accion_invalida" });
    assert.deepEqual(parseEngineRequest({ job_id: "x", action: "report" }), { ok: false, error: "trabajo_invalido" });
    assert.deepEqual(parseEngineRequest({ job_id: ID, action: "report", args: [1] }), { ok: false, error: "datos_invalidos" });
  });

  it("el latido lleva la huella física, la marca y la identidad, acotadas", () => {
    const r = parseHeartbeatRequest({
      version: "0.3.0",
      scales: [
        {
          key: "dev:usb-1",
          name: "Report",
          online: true,
          family: "kretz",
          model: "kretz-report-lt",
          identity: { letter: "C", equipment: "01" },
          device: { id: "usb-1", kind: "serial", fingerprint: "serial:A1", path: "COM3", port: "x", extra: "no" }
        },
        { key: "dev:2", family: "otra", identity: { big: "z".repeat(400) }, device: { kind: "tcp" } }
      ]
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.value.scales[0], {
      key: "dev:usb-1",
      name: "Report",
      online: true,
      family: "kretz",
      model: "kretz-report-lt",
      identity: { letter: "C", equipment: "01" },
      device: { id: "usb-1", kind: "serial", fingerprint: "serial:A1", path: "COM3" }
    });
    assert.deepEqual(r.value.scales[1], { key: "dev:2", name: "dev:2", online: false });
  });
});

describe("scale-connect-api: consulta larga de /claim", () => {
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("nunca toma un trabajo si el conector ya cortó el pedido (se reinició o se cayó la red)", async () => {
    const clock = fakeClock();
    let aborted = false;
    let claims = 0;
    const r = await longPollClaim({
      claim: async () => {
        claims += 1;
        // Primer intento: no hay nada. Mientras espera, el conector corta; recién ahí aparece un trabajo.
        if (claims === 1) {
          aborted = true;
          return { data: null, error: null };
        }
        return { data: { id: "j1" }, error: null };
      },
      waitSec: 25,
      aborted: () => aborted,
      sleep: clock.sleep,
      now: clock.now
    });
    assert.equal(r.job, null);
    assert.equal(claims, 1, "después del corte no se vuelve a tomar");
  });

  it("devuelve el trabajo apenas aparece y espera como mucho waitSec", async () => {
    const clock = fakeClock();
    let claims = 0;
    const found = await longPollClaim({
      claim: async () => ({ data: ++claims === 3 ? { id: "j2" } : null, error: null }),
      waitSec: 25,
      aborted: () => false,
      sleep: clock.sleep,
      now: clock.now
    });
    assert.deepEqual(found.job, { id: "j2" });
    const clock2 = fakeClock();
    let tries = 0;
    const none = await longPollClaim({
      claim: async () => {
        tries += 1;
        return { data: null, error: null };
      },
      waitSec: 25,
      aborted: () => false,
      sleep: clock2.sleep,
      now: clock2.now
    });
    assert.equal(none.job, null);
    assert.ok(clock2.now() <= 25_000 && tries === 11,`${tries} intentos en ${clock2.now()} ms`);
  });

  it("un error de la base corta la consulta", async () => {
    const r = await longPollClaim({ claim: async () => ({ data: null, error: { code: "PT401" } }), waitSec: 25, aborted: () => false, sleep: async () => undefined });
    assert.deepEqual(r.error, { code: "PT401" });
  });
});
