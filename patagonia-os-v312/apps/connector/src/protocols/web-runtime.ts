// Corre el código de protocolos de la web (web-entry.ts) dentro del conector.
//
// El código se empaqueta UNA vez (esbuild, IIFE) y se evalúa UNA VEZ POR BALANZA con
// `new Function`, pasándole como parámetros lo que en el navegador es global:
//   localStorage → el almacén de esa balanza (ScaleStateStore, en disco)
//   navigator    → { serial } que devuelve solo el puerto de esa balanza
//   window, BroadcastChannel, document → undefined (el código ya sabe vivir sin ellos)
// Así cada balanza tiene sus propias variables de módulo (scale-serial.ts guarda "el
// puerto elegido" y el formato de etiqueta en variables de módulo) y nada del
// navegador se instala en el `globalThis` del servicio.
//
// En el ejecutable el texto viene ya empaquetado (__WEB_PROTOCOLS_SOURCE__, lo
// define scripts/build.mjs). En desarrollo y pruebas (tsx) se empaqueta al vuelo con
// esbuild la primera vez.

import path from "node:path";
import { fileURLToPath } from "node:url";

export type WebProtocols = typeof import("./web-entry");

declare const __WEB_PROTOCOLS_SOURCE__: string | undefined;

const GLOBAL_NAME = "__patagoniaWebProtocols";

let sourcePromise: Promise<string> | null = null;

async function buildFromSource(): Promise<string> {
  const { build } = await import("esbuild");
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "web-entry.ts");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    globalName: GLOBAL_NAME,
    platform: "neutral",
    target: "node22",
    mainFields: ["module", "main"],
    legalComments: "none",
    logLevel: "error",
  });
  return result.outputFiles[0].text;
}

/** El texto empaquetado del código de protocolos de la web. */
export function loadWebProtocolSource(): Promise<string> {
  if (typeof __WEB_PROTOCOLS_SOURCE__ === "string") return Promise.resolve(__WEB_PROTOCOLS_SOURCE__);
  sourcePromise ??= buildFromSource();
  return sourcePromise;
}

/** Lo que el código de la web ve como `navigator`. */
export interface WebNavigatorLike {
  serial: EventTarget & {
    getPorts(): Promise<unknown[]>;
    requestPort(options?: unknown): Promise<unknown>;
  };
}

export interface WebEnvironment {
  localStorage: Storage;
  navigator: WebNavigatorLike;
}

/** Un `navigator.serial` que solo conoce el puerto de esta balanza. */
export function serialFor(getPort: () => unknown): WebNavigatorLike["serial"] {
  const serial = new EventTarget() as WebNavigatorLike["serial"];
  serial.getPorts = async () => [getPort()];
  serial.requestPort = async () => getPort();
  return serial;
}

/** Una instancia nueva y aislada del código de protocolos de la web. */
export function instantiateWebProtocols(source: string, env: WebEnvironment): WebProtocols {
  const factory = new Function("localStorage", "navigator", "window", "BroadcastChannel", "document", `${source}\nreturn ${GLOBAL_NAME};`) as (
    localStorage: Storage,
    navigator: WebNavigatorLike,
    window: undefined,
    broadcastChannel: undefined,
    document: undefined,
  ) => WebProtocols;
  return factory(env.localStorage, env.navigator, undefined, undefined, undefined);
}
