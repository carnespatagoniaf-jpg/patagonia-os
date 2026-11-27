// Publica una versión de Scale Connect para la actualización automática (lo corre el CI con un tag
// scale-connect-vX.Y.Z; ver .github/workflows/scale-connect.yml y el README, "Actualización automática").
//
//   1. Sube el instalador al bucket PÚBLICO de Supabase Storage "scale-connect" (migración 229), en
//      <versión>/PatagoniaScaleConnect-Setup-<versión>.exe, sin pisar nunca uno que ya esté (si ya está, tiene que ser
//      idéntico). El hosting no da la integridad: la da la firma.
//   2. Arma latest.json con esa URL y lo firma con SCALE_CONNECT_UPDATE_KEY (Ed25519; solo en memoria).
//   3. Lo verifica con SCALE_CONNECT_UPDATE_PUBKEY, la misma clave que se embebió en el ejecutable: si no coinciden,
//      se frena (un manifiesto que ninguna PC aceptaría no se publica).
//   4. Sube latest.json al lado del instalador y deja en dist/installer/ el latest.json y publicar-<versión>.sql (la
//      llamada a publish_scale_connect_release para el administrador de plataforma, al 0 % en piloto).
// Sin secretos se saltea con un aviso (::warning::) y sale bien: el resto del build no depende de esto.
//
// Variables: SCALE_CONNECT_UPDATE_KEY (secreto), SCALE_CONNECT_UPDATE_PUBKEY (variable), SCALE_CONNECT_STORAGE_URL
// (variable, https://<proyecto>.supabase.co), SCALE_CONNECT_STORAGE_KEY (secreto: clave service_role o "secret" del
// proyecto), SCALE_CONNECT_MIN_VERSION (variable, opcional; por omisión 0.1.0).
//
//   node scripts/publish-release.mjs --file dist/installer/PatagoniaScaleConnect-Setup-0.3.0.exe [--version 0.3.0]

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSignedManifest, loadPrivateKey, loadPublicKey, verifyManifest } from "./lib/update-manifest.mjs";

export const BUCKET = "scale-connect";

export function missingSettings(env) {
  return ["SCALE_CONNECT_UPDATE_KEY", "SCALE_CONNECT_UPDATE_PUBKEY", "SCALE_CONNECT_STORAGE_URL", "SCALE_CONNECT_STORAGE_KEY"].filter(
    (name) => !String(env[name] ?? "").trim(),
  );
}

export function storageBase(raw) {
  const url = new URL(String(raw).trim());
  if (url.protocol !== "https:") throw new Error("SCALE_CONNECT_STORAGE_URL tiene que ser https://<proyecto>.supabase.co");
  return url.origin;
}

export function objectPath(version, name) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Versión inválida: ${version}`);
  return `${version}/${name}`;
}

export const publicUrl = (base, objPath) => `${base}/storage/v1/object/public/${BUCKET}/${objPath}`;

export function publishSql(manifest, channel = "pilot", percent = 0) {
  const json = JSON.stringify(manifest).replace(/'/g, "''");
  return [
    `-- Publicar Scale Connect ${manifest.version} (keyId ${manifest.keyId}). Editor SQL de Supabase, como administrador de plataforma:`,
    "begin;",
    "select set_config('request.jwt.claim.sub', '<user_id de platform_admins>', true);",
    `select public.publish_scale_connect_release('${json}'::jsonb, '${channel}', ${percent});`,
    "commit;",
    "-- Después, de a poco: select public.set_scale_connect_release('<id>', true, 10);  ... 50 ... 100",
    "-- Frenar:            select public.set_scale_connect_release('<id>', false);",
    "",
  ].join("\n");
}

/** Sube sin pisar. Si ya existe, tiene que ser idéntico (mismo SHA-256) al que se quiere subir. */
export async function uploadOnce({ base, key, objPath, bytes, contentType, doFetch = fetch }) {
  const res = await doFetch(`${base}/storage/v1/object/${BUCKET}/${objPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": contentType, "x-upsert": "false", "cache-control": "max-age=300" },
    body: bytes,
  });
  if (res.ok) return "subido";
  const text = await res.text().catch(() => "");
  if (res.status === 409 || /exists|Duplicate/i.test(text)) {
    const existing = await doFetch(publicUrl(base, objPath));
    const got = existing.ok ? Buffer.from(await existing.arrayBuffer()) : null;
    const same = got && createHash("sha256").update(got).digest("hex") === createHash("sha256").update(bytes).digest("hex");
    if (same) return "ya estaba";
    throw new Error(`Ya hay otro ${objPath} en el bucket: no se pisa. Subí la versión.`);
  }
  throw new Error(`No se pudo subir ${objPath} (HTTP ${res.status}): ${text.slice(0, 200)}`);
}

export async function publish({ env, file, version, outDir, doFetch = fetch, log = console.log }) {
  const missing = missingSettings(env);
  if (missing.length) {
    log(`::warning::No se publica la actualización automática: faltan ${missing.join(", ")} (ver apps/connector/README.md).`);
    return { skipped: true, missing };
  }
  const privateKey = loadPrivateKey(env.SCALE_CONNECT_UPDATE_KEY);
  const publicKey = loadPublicKey(env.SCALE_CONNECT_UPDATE_PUBKEY);
  const base = storageBase(env.SCALE_CONNECT_STORAGE_URL);
  const key = String(env.SCALE_CONNECT_STORAGE_KEY).trim();
  const bytes = await readFile(file);
  const name = path.basename(file);
  const exePath = objectPath(version, name);
  const manifest = createSignedManifest(
    {
      version,
      channel: "general",
      minVersion: String(env.SCALE_CONNECT_MIN_VERSION ?? "").trim() || "0.1.0",
      url: publicUrl(base, exePath),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    },
    privateKey,
  );
  const check = verifyManifest(manifest, publicKey);
  if (!check.ok) throw new Error(`El manifiesto no verifica con SCALE_CONNECT_UPDATE_PUBKEY (${check.reason}): ¿la clave privada y la pública son del mismo par?`);

  log(`Instalador: ${await uploadOnce({ base, key, objPath: exePath, bytes, contentType: "application/octet-stream", doFetch })} → ${manifest.url}`);
  let manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = objectPath(version, "latest.json");
  // Reintento del CI con el mismo instalador: el latest.json que ya está (otra fecha, misma firma válida) se reutiliza.
  const existing = await doFetch(publicUrl(base, manifestPath)).catch(() => null);
  const previous = existing?.ok ? await existing.json().catch(() => null) : null;
  if (previous && previous.sha256 === manifest.sha256 && previous.url === manifest.url && verifyManifest(previous, publicKey).ok) {
    manifestText = `${JSON.stringify(previous, null, 2)}\n`;
    log(`Manifiesto: ya estaba → ${publicUrl(base, manifestPath)}`);
  } else {
    log(`Manifiesto: ${await uploadOnce({ base, key, objPath: manifestPath, bytes: Buffer.from(manifestText), contentType: "application/json", doFetch })} → ${publicUrl(base, manifestPath)}`);
  }
  const published = JSON.parse(manifestText);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "latest.json"), manifestText);
  await writeFile(path.join(outDir, `publicar-${version}.sql`), publishSql(published));
  log(`Listo: ${version} (keyId ${published.keyId}). Falta publicarla en la base: dist/installer/publicar-${version}.sql`);
  return { skipped: false, manifest: published };
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const pkg = JSON.parse(await readFile(path.join(here, "..", "package.json"), "utf8"));
    const version = opt("version") ?? pkg.version;
    const file = path.resolve(opt("file") ?? path.join(here, "..", "dist", "installer", `PatagoniaScaleConnect-Setup-${version}.exe`));
    await publish({ env: process.env, file, version, outDir: path.dirname(file) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
