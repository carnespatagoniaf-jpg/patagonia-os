// keys-to-github.mjs (lo usa preparar-claves-actualizacion.ps1) contra un `gh` simulado: la privada va solo por la
// entrada estándar del secreto, nunca en argumentos ni en lo que se imprime, y la pública verifica lo que firma.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./keys-to-github.mjs";
import { createSignedManifest, loadPrivateKey, loadPublicKey, verifyManifest } from "./update-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeGh(existing = "") {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts.input });
    if (args[0] === "secret" && args[1] === "list") return { status: 0, stdout: existing, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, spawn };
}

test("carga la privada por stdin y la pública como variable; no imprime ni pasa la privada por argumentos", () => {
  const gh = fakeGh();
  const lines = [];
  const r = run(["--repo", "dueno/repo"], { spawn: gh.spawn, log: (l) => lines.push(l) });
  const secret = gh.calls.find((c) => c.args[0] === "secret" && c.args[1] === "set");
  const variable = gh.calls.find((c) => c.args[0] === "variable");
  assert.deepEqual(secret.args, ["secret", "set", "SCALE_CONNECT_UPDATE_KEY", "--repo", "dueno/repo"]);
  assert.deepEqual(variable.args.slice(0, 5), ["variable", "set", "SCALE_CONNECT_UPDATE_PUBKEY", "--repo", "dueno/repo"]);
  const priv = secret.input;
  for (const c of gh.calls) assert.ok(!c.args.join(" ").includes(priv), "la privada nunca va en argumentos");
  for (const l of lines) assert.ok(!l.includes(priv), "la privada nunca se imprime");
  // Es un par de verdad: lo que firma la privada lo verifica la pública de la variable.
  const m = createSignedManifest(
    { version: "1.0.0", channel: "general", minVersion: "0.1.0", url: "https://x/y.exe", sha256: "a".repeat(64), size: 1 },
    loadPrivateKey(priv),
  );
  assert.deepEqual(verifyManifest(m, loadPublicKey(variable.args[6])), { ok: true });
  assert.equal(r.publicKey, variable.args[6]);
});

test("si el secreto ya existe se niega (salvo --reemplazar)", () => {
  const listing = "SCALE_CONNECT_UPDATE_KEY\t2026-11-27\n";
  assert.throws(() => run(["--repo", "dueno/repo"], { spawn: fakeGh(listing).spawn, log: () => undefined }), /ya existe/);
  const gh = fakeGh(listing);
  run(["--repo", "dueno/repo", "--reemplazar"], { spawn: gh.spawn, log: () => undefined });
  assert.ok(gh.calls.some((c) => c.args[1] === "set" && c.args[0] === "secret"));
});

test("el script de PowerShell no escribe la clave en ningún archivo y es ASCII", () => {
  const ps1 = readFileSync(path.join(here, "..", "preparar-claves-actualizacion.ps1"), "utf8");
  assert.ok(/^[\x00-\x7F]*$/.test(ps1));
  assert.doesNotMatch(ps1, /Out-File|Set-Content|Add-Content|>\s*\S+\.(pem|txt|key)|WriteAllText/i);
  const js = readFileSync(path.join(here, "keys-to-github.mjs"), "utf8");
  assert.doesNotMatch(js, /writeFile|appendFile|createWriteStream/);
});
