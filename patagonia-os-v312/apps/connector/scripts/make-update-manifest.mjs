// Genera latest.json (manifiesto de actualización firmado con Ed25519). Formato: lib/update-manifest.mjs.
//
// Firmar (la clave privada viene SOLO de la variable de entorno; nunca de un archivo del repo):
//   set SCALE_CONNECT_UPDATE_KEY=<PEM PKCS#8, o el DER en base64 en una línea>
//   npm run update-manifest -w @patagonia/connector -- \
//     --url https://…/PatagoniaScaleConnect-Setup-0.2.0.exe \
//     --file dist/installer/PatagoniaScaleConnect-Setup-0.2.0.exe \
//     --channel interno --min-version 0.1.0 [--version 0.2.0] [--out dist/installer/latest.json]
//   (en vez de --file se puede pasar --sha256 <hex> --size <bytes>)
//
// Verificar un latest.json con la clave pública:
//   node scripts/make-update-manifest.mjs verify --manifest latest.json --public-key publica.pem
//
// Crear un par de claves nuevo (solo en una carpeta FUERA del repo; el script se niega si no):
//   node scripts/make-update-manifest.mjs keygen --out-dir C:\claves-scale-connect

import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/download.mjs";
import { createSignedManifest, keyIdOf, loadPrivateKey, loadPublicKey, verifyManifest } from "./lib/update-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const KEY_ENV = "SCALE_CONNECT_UPDATE_KEY";

function args(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) result[a.slice(2)] = true;
      else {
        result[a.slice(2)] = next;
        i++;
      }
    } else result._.push(a);
  }
  return result;
}

function insideGitRepo(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

async function keygen(opts) {
  if (!opts["out-dir"] || opts["out-dir"] === true) throw new Error("Falta --out-dir (una carpeta fuera del repo).");
  const dir = path.resolve(opts["out-dir"]);
  if (insideGitRepo(dir)) throw new Error(`${dir} está dentro de un repositorio git: la clave privada no puede quedar ahí.`);
  await mkdir(dir, { recursive: true });
  const priv = path.join(dir, "scale-connect-update-private.pem");
  if (existsSync(priv)) throw new Error(`Ya existe ${priv}: no se pisa una clave.`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(priv, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await writeFile(path.join(dir, "scale-connect-update-public.pem"), publicKey.export({ format: "pem", type: "spki" }));
  console.log(
    [
      `Clave privada: ${priv}  (guardarla fuera de la PC y como secreto ${KEY_ENV} del CI)`,
      `Clave pública: ${path.join(dir, "scale-connect-update-public.pem")}  (va dentro del servicio)`,
      `keyId: ${keyIdOf(publicKey)}`,
      `${KEY_ENV} acepta el PEM tal cual o, en una sola línea, el DER PKCS#8 en base64.`,
    ].join("\n"),
  );
}

async function make(opts) {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const privateKey = loadPrivateKey(process.env[KEY_ENV]);
  let sha256 = opts.sha256;
  let size = opts.size === undefined ? undefined : Number(opts.size);
  if (opts.file && opts.file !== true) {
    const file = path.resolve(opts.file);
    sha256 = await sha256File(file);
    size = (await stat(file)).size;
  }
  if (!sha256 || !size) throw new Error("Indicar --file <instalador> o --sha256 <hex> y --size <bytes>.");
  const manifest = createSignedManifest(
    {
      version: opts.version && opts.version !== true ? opts.version : pkg.version,
      channel: opts.channel && opts.channel !== true ? opts.channel : "interno",
      minVersion: opts["min-version"] && opts["min-version"] !== true ? opts["min-version"] : "0.1.0",
      url: opts.url,
      sha256,
      size,
    },
    privateKey,
  );
  const out = path.resolve(opts.out && opts.out !== true ? opts.out : path.join(root, "dist", "installer", "latest.json"));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json firmado (keyId ${manifest.keyId}, canal ${manifest.channel}, versión ${manifest.version}): ${out}`);
}

async function verifyCommand(opts) {
  const manifest = JSON.parse(await readFile(path.resolve(opts.manifest), "utf8"));
  const result = verifyManifest(manifest, loadPublicKey(await readFile(path.resolve(opts["public-key"]), "utf8")));
  console.log(result.ok ? "Firma válida." : `NO válido: ${result.reason}`);
  if (!result.ok) process.exitCode = 1;
}

const opts = args(process.argv.slice(2));
const command = opts._[0] ?? "make";
try {
  if (command === "keygen") await keygen(opts);
  else if (command === "verify") await verifyCommand(opts);
  else if (command === "make") await make(opts);
  else throw new Error(`Comando desconocido: ${command} (make | verify | keygen)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
