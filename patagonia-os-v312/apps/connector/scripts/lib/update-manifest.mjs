// Manifiesto de actualización de Scale Connect (PLAN_BALANZAS_V2 §5.6): latest.json firmado
// con Ed25519. La clave privada NO vive en el servidor ni en el repo; el servicio trae la
// pública y no instala nada cuya firma o hash no cierren.
//
// Formato (schema 1):
// {
//   "schema": 1,
//   "product": "patagonia-scale-connect",
//   "version": "0.2.0",              versión que se ofrece
//   "channel": "interno",            interno | piloto | general
//   "minVersion": "0.1.0",           una instalación más vieja que esto no se actualiza sola (reinstalar)
//   "url": "https://…/PatagoniaScaleConnect-Setup-0.2.0.exe",
//   "sha256": "<64 hex>",            del instalador
//   "size": 12345678,                bytes del instalador
//   "publishedAt": "2026-11-27T12:00:00.000Z",
//   "keyId": "<16 hex>",             primeros 8 bytes del SHA-256 de la clave pública (DER)
//   "signature": "<base64>"          Ed25519 sobre signedBytes(manifiesto sin "signature")
// }
//
// Lo firmado es un prefijo de dominio + el JSON canónico (claves ordenadas, sin espacios) de
// todos los campos menos "signature". Así reordenar o reformatear el archivo no rompe la firma,
// y cambiar cualquier valor sí.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const MANIFEST_SCHEMA = 1;
export const PRODUCT = "patagonia-scale-connect";
export const CHANNELS = ["interno", "piloto", "general"];
const DOMAIN = "patagonia-scale-connect/update-manifest/v1\n";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const FIELDS = ["schema", "product", "version", "channel", "minVersion", "url", "sha256", "size", "publishedAt", "keyId"];

export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`Versión inválida: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Errores de formato (lista vacía = válido). No mira la firma. */
export function validateManifest(m) {
  const errors = [];
  if (typeof m !== "object" || m === null || Array.isArray(m)) return ["El manifiesto no es un objeto."];
  for (const key of Object.keys(m)) if (![...FIELDS, "signature"].includes(key)) errors.push(`Campo desconocido: ${key}`);
  if (m.schema !== MANIFEST_SCHEMA) errors.push(`schema debe ser ${MANIFEST_SCHEMA}.`);
  if (m.product !== PRODUCT) errors.push(`product debe ser ${PRODUCT}.`);
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) errors.push("version inválida (X.Y.Z).");
  if (typeof m.minVersion !== "string" || !SEMVER.test(m.minVersion)) errors.push("minVersion inválida (X.Y.Z).");
  else if (typeof m.version === "string" && SEMVER.test(m.version) && compareVersions(m.minVersion, m.version) > 0) {
    errors.push("minVersion no puede ser mayor que version.");
  }
  if (!CHANNELS.includes(m.channel)) errors.push(`channel debe ser ${CHANNELS.join(" | ")}.`);
  let url = null;
  try {
    url = new URL(m.url);
  } catch {
    // se informa abajo
  }
  if (!url || url.protocol !== "https:") errors.push("url debe ser https://…");
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) errors.push("sha256 debe ser 64 caracteres hex en minúscula.");
  if (!Number.isSafeInteger(m.size) || m.size <= 0) errors.push("size debe ser un entero positivo.");
  if (typeof m.publishedAt !== "string" || Number.isNaN(Date.parse(m.publishedAt))) errors.push("publishedAt debe ser una fecha ISO.");
  if (typeof m.keyId !== "string" || !/^[0-9a-f]{16}$/.test(m.keyId)) errors.push("keyId debe ser 16 caracteres hex.");
  return errors;
}

/** Bytes que se firman: prefijo de dominio + JSON canónico sin "signature". */
export function signedBytes(m) {
  const canonical = {};
  for (const key of [...FIELDS].sort()) canonical[key] = m[key];
  return Buffer.from(DOMAIN + JSON.stringify(canonical), "utf8");
}

/**
 * Lee una clave privada Ed25519 de un texto: PEM (PKCS#8) o el DER PKCS#8 en base64 en una
 * sola línea (cómodo para un secreto del CI).
 */
export function loadPrivateKey(text) {
  const value = String(text ?? "").trim();
  if (!value) throw new Error("Falta la clave privada.");
  const key = value.includes("-----BEGIN")
    ? createPrivateKey(value)
    : createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`La clave es ${key.asymmetricKeyType}, se espera ed25519.`);
  return key;
}

export function loadPublicKey(text) {
  const value = String(text ?? "").trim();
  const key = value.includes("-----BEGIN")
    ? createPublicKey(value)
    : createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`La clave es ${key.asymmetricKeyType}, se espera ed25519.`);
  return key;
}

export function keyIdOf(key) {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Arma y firma el manifiesto. Tira error si algún campo es inválido. */
export function createSignedManifest(fields, privateKey) {
  const manifest = {
    schema: MANIFEST_SCHEMA,
    product: PRODUCT,
    version: fields.version,
    channel: fields.channel,
    minVersion: fields.minVersion,
    url: fields.url,
    sha256: String(fields.sha256 ?? "").toLowerCase(),
    size: fields.size,
    publishedAt: fields.publishedAt ?? new Date().toISOString(),
    keyId: keyIdOf(privateKey),
  };
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`Manifiesto inválido:\n  ${errors.join("\n  ")}`);
  return { ...manifest, signature: sign(null, signedBytes(manifest), privateKey).toString("base64") };
}

/**
 * Verificación (la misma que hará el servicio antes de bajar nada):
 * formato válido + keyId de la clave conocida + firma Ed25519 correcta.
 */
export function verifyManifest(manifest, publicKey) {
  const errors = validateManifest(manifest);
  if (errors.length) return { ok: false, reason: errors.join(" ") };
  if (manifest.keyId !== keyIdOf(publicKey)) return { ok: false, reason: "Firmado con otra clave (keyId distinto)." };
  if (typeof manifest.signature !== "string" || manifest.signature.length === 0) return { ok: false, reason: "Sin firma." };
  const signature = Buffer.from(manifest.signature, "base64");
  if (signature.length !== 64) return { ok: false, reason: "Firma con largo inválido." };
  return verify(null, signedBytes(manifest), publicKey, signature) ? { ok: true } : { ok: false, reason: "La firma no coincide." };
}

/** Canales que acepta una PC de cada canal: una PC "interno" recibe todo; una "general", solo lo general. */
const ACCEPTS = { interno: ["interno", "piloto", "general"], piloto: ["piloto", "general"], general: ["general"] };

/**
 * ¿El servicio instala lo que ofrece este manifiesto? Además de la firma (verifyManifest):
 * - Solo una versión MÁS NUEVA que la instalada. Un latest.json viejo (firmado de verdad, pero de una versión con un
 *   error ya arreglado) que alguien vuelva a servir no hace bajar de versión a nadie, y la misma versión no se reinstala.
 * - Del canal de esta PC (un piloto no le llega a todos).
 * - La instalada no puede ser más vieja que minVersion (esa PC se reinstala a mano).
 * - publishedAt no puede venir del futuro (más de un día: reloj o manifiesto armado a mano).
 */
export function checkUpdateOffer(manifest, publicKey, { currentVersion, channel = "general", now = new Date() } = {}) {
  const signed = verifyManifest(manifest, publicKey);
  if (!signed.ok) return signed;
  if (typeof currentVersion !== "string" || !SEMVER.test(currentVersion)) return { ok: false, reason: "Versión instalada desconocida." };
  const accepted = ACCEPTS[channel];
  if (!accepted) return { ok: false, reason: `Canal de esta PC desconocido: ${channel}` };
  if (!accepted.includes(manifest.channel)) return { ok: false, reason: `Es del canal ${manifest.channel} y esta PC es ${channel}.` };
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return { ok: false, reason: `Ofrece ${manifest.version} y ya está ${currentVersion}: nunca se baja de versión ni se reinstala la misma.` };
  }
  if (compareVersions(currentVersion, manifest.minVersion) < 0) {
    return { ok: false, reason: `La instalada (${currentVersion}) es anterior a ${manifest.minVersion}: hay que reinstalar a mano.` };
  }
  if (Date.parse(manifest.publishedAt) > now.getTime() + 24 * 3600 * 1000) return { ok: false, reason: "publishedAt está en el futuro." };
  return { ok: true };
}

/** El instalador bajado es EXACTAMENTE el del manifiesto (tamaño y SHA-256). Si no, no se ejecuta. */
export function verifyInstaller(bytes, manifest) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (data.length !== manifest.size) return { ok: false, reason: `Pesa ${data.length} bytes y el manifiesto dice ${manifest.size}.` };
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== manifest.sha256) return { ok: false, reason: "El SHA-256 no coincide con el manifiesto." };
  return { ok: true };
}
