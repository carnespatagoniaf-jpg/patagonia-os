// Genera el par Ed25519 de la actualización automática y lo carga en GitHub SIN mostrar ni guardar la clave privada:
//   - privada → secreto SCALE_CONNECT_UPDATE_KEY (DER PKCS#8 en base64), por la entrada estándar de `gh secret set`
//     (nunca en la línea de comandos, que otros procesos pueden ver);
//   - pública → variable SCALE_CONNECT_UPDATE_PUBKEY (DER SPKI en base64), que el CI embebe en el ejecutable.
// La privada solo existe en la memoria de este proceso. Lo corre scripts/preparar-claves-actualizacion.ps1.
//
//   node keys-to-github.mjs --repo dueño/repo [--reemplazar] [--gh <ruta de gh>]
//
// Se niega si el secreto ya existe (sin --reemplazar): cambiar la clave deja a las PC instaladas con la vieja sin
// poder actualizarse solas (hay que reinstalarlas a mano).

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyIdOf } from "./update-manifest.mjs";

const SECRET = "SCALE_CONNECT_UPDATE_KEY";
const VARIABLE = "SCALE_CONNECT_UPDATE_PUBKEY";

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function run(argv, { log = console.log, spawn = spawnSync } = {}) {
  const repo = arg(argv, "repo");
  const gh = arg(argv, "gh") ?? "gh";
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Falta --repo dueño/repo");
  const ghRun = (args, input) => {
    const r = spawn(gh, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], shell: false });
    if (r.error) throw new Error(`No se pudo correr gh: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} falló: ${(r.stderr || "").trim().slice(0, 300)}`);
    return r.stdout ?? "";
  };

  const existing = ghRun(["secret", "list", "--repo", repo]);
  if (existing.split(/\r?\n/).some((l) => l.split(/\s+/)[0] === SECRET) && !argv.includes("--reemplazar")) {
    throw new Error(`${SECRET} ya existe en ${repo}. Cambiarla deja a las PC instaladas sin actualización automática: si es lo que querés, repetí con -Reemplazar.`);
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  // Primero la variable pública (si falla, no quedó un secreto sin su pareja).
  ghRun(["variable", "set", VARIABLE, "--repo", repo, "--body", pub]);
  ghRun(["secret", "set", SECRET, "--repo", repo], privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  const keyId = keyIdOf(publicKey);
  log(`Listo. Secreto ${SECRET} cargado (la clave privada no se mostró ni se guardó en ningún archivo).`);
  log(`Variable ${VARIABLE} = ${pub}`);
  log(`keyId: ${keyId}`);
  return { keyId, publicKey: pub };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
