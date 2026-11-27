// Clave pública Ed25519 con la que se verifican los manifiestos de actualización.
//
// Va DENTRO del ejecutable: el build (scripts/build.mjs) la toma de la variable SCALE_CONNECT_UPDATE_PUBKEY (en el CI,
// la variable del repo del mismo nombre) y la inyecta con un define de esbuild. No hay forma de cambiarla desde
// config.json, una variable de entorno ni la nube: un servidor de Patagonia comprometido no puede hacer instalar un
// binario que no firmó quien tiene la clave privada.
//
// Sin clave (desarrollo, o un build armado sin la variable) la actualización automática queda APAGADA: falla cerrada.

import type { KeyObject } from "node:crypto";
import { keyIdOf, loadPublicKey } from "../../scripts/lib/update-manifest.mjs";

declare const __SCALE_CONNECT_UPDATE_PUBKEY__: string | undefined;

export interface EmbeddedUpdateKey {
  key: KeyObject | null;
  keyId: string | null;
  /** Por qué está apagada (null = prendida). */
  disabledReason: string | null;
}

export function parseUpdateKey(raw: string | undefined | null): EmbeddedUpdateKey {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { key: null, keyId: null, disabledReason: "Este programa se armó sin la clave pública de actualización." };
  try {
    const key = loadPublicKey(text);
    return { key, keyId: keyIdOf(key), disabledReason: null };
  } catch (error) {
    return { key: null, keyId: null, disabledReason: `La clave pública de actualización es inválida: ${error instanceof Error ? error.message : String(error)}` };
  }
}

let cached: EmbeddedUpdateKey | null = null;

export function embeddedUpdateKey(): EmbeddedUpdateKey {
  if (!cached) cached = parseUpdateKey(typeof __SCALE_CONNECT_UPDATE_PUBKEY__ === "string" ? __SCALE_CONNECT_UPDATE_PUBKEY__ : "");
  return cached;
}
