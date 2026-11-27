// Tipos de update-manifest.mjs para el servicio (src/update/). La lógica vive en el .mjs: la misma que usa el CI.
import type { KeyObject } from "node:crypto";

export type ManifestChannel = "interno" | "piloto" | "general";

export interface UpdateManifest {
  schema: 1;
  product: "patagonia-scale-connect";
  version: string;
  channel: ManifestChannel;
  minVersion: string;
  url: string;
  sha256: string;
  size: number;
  publishedAt: string;
  keyId: string;
  signature: string;
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

export const MANIFEST_SCHEMA: 1;
export const PRODUCT: "patagonia-scale-connect";
export const CHANNELS: ManifestChannel[];
export function compareVersions(a: string, b: string): number;
export function validateManifest(m: unknown): string[];
export function signedBytes(m: unknown): Buffer;
export function loadPrivateKey(text: string | undefined | null): KeyObject;
export function loadPublicKey(text: string | undefined | null): KeyObject;
export function keyIdOf(key: KeyObject): string;
export function createSignedManifest(
  fields: { version: string; channel: string; minVersion: string; url: string; sha256: string; size: number; publishedAt?: string },
  privateKey: KeyObject,
): UpdateManifest;
export function verifyManifest(manifest: unknown, publicKey: KeyObject): CheckResult;
export function checkUpdateOffer(
  manifest: unknown,
  publicKey: KeyObject,
  options?: { currentVersion?: string; channel?: string; now?: Date },
): CheckResult;
export function verifyInstaller(bytes: Uint8Array, manifest: { size: number; sha256: string }): CheckResult;
