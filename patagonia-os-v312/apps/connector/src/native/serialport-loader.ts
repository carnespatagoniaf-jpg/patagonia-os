// Carga del módulo nativo `serialport`, aislada en un solo lugar.
//
// - En desarrollo (tsx) y en el bundle de esbuild es un import normal
//   (`serialport` queda "external" en el bundle).
// - Dentro de un ejecutable Node SEA, `require` solo ve los módulos internos de
//   Node; por eso se carga con createRequire desde la carpeta del .exe, donde
//   el empaquetado deja `node_modules/serialport` y el `.node` precompilado.
//
// Si el módulo nativo no carga, el resto del servicio sigue andando (servidor
// local, balanzas por red); solo los puertos serie quedan no disponibles.

import path from "node:path";
import { createRequire } from "node:module";

export type SerialportModule = typeof import("serialport");

let cached: Promise<SerialportModule> | null = null;

async function runningInsideSea(): Promise<boolean> {
  try {
    const sea = (await import("node:sea")) as { isSea?: () => boolean };
    return typeof sea.isSea === "function" && sea.isSea();
  } catch {
    return false;
  }
}

export function loadSerialport(): Promise<SerialportModule> {
  if (!cached) {
    cached = (async () => {
      if (await runningInsideSea()) {
        const requireFromExe = createRequire(path.join(path.dirname(process.execPath), "noop.js"));
        return requireFromExe("serialport") as SerialportModule;
      }
      return (await import("serialport")) as SerialportModule;
    })();
    // Si falló, se permite reintentar más tarde (por ejemplo después de reparar la instalación).
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}
