// Build: todo el servicio en UN solo archivo CommonJS (dist/scale-connect.cjs),
// listo para correr con `node` o para meterlo en un ejecutable Node SEA.
// `serialport` queda afuera (es nativo: el .node va al lado del .exe).
//
// Antes se empaqueta aparte el código de protocolos de la WEB (src/protocols/web-entry.ts,
// que importa apps/web/src/...) como un texto IIFE: el servicio lo evalúa una vez por
// balanza, con su propio localStorage y navigator.serial (src/protocols/web-runtime.ts).

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyIdOf, loadPublicKey } from "./lib/update-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const protocols = await build({
  entryPoints: [path.join(root, "src", "protocols", "web-entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "__patagoniaWebProtocols",
  platform: "neutral",
  target: "node22",
  mainFields: ["module", "main"],
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});
const protocolSource = protocols.outputFiles[0].text;
// El código de protocolos tiene que ser lógica pura: nada de Supabase, React ni paquetes de node_modules.
const forbidden = Object.keys(protocols.metafile.inputs).filter((f) => /node_modules|lib\/supabase|\.tsx$/.test(f));
if (forbidden.length) throw new Error(`Los protocolos de la web arrastran código que no corre en el servicio: ${forbidden.join(", ")}`);

// Si viene una clave, tiene que ser una pública Ed25519 válida: mejor frenar el build que publicar un programa que
// nunca se va a poder actualizar.
const updatePublicKey = (process.env.SCALE_CONNECT_UPDATE_PUBKEY ?? "").trim();
if (updatePublicKey) {
  loadPublicKey(updatePublicKey);
  console.log(`Actualización automática: prendida (keyId ${keyIdOf(loadPublicKey(updatePublicKey))})`);
} else {
  console.log("Actualización automática: APAGADA (falta SCALE_CONNECT_UPDATE_PUBKEY)");
}

const result = await build({
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "dist", "scale-connect.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // esbuild solo se usa en desarrollo para empaquetar los protocolos al vuelo (web-runtime.ts).
  external: ["serialport", "esbuild"],
  sourcemap: "linked",
  legalComments: "none",
  metafile: true,
  // __SCALE_CONNECT_UPDATE_PUBKEY__: clave PÚBLICA Ed25519 de los manifiestos (variable SCALE_CONNECT_UPDATE_PUBKEY; en el
  // CI, la variable del repo). Vacía = la actualización automática queda apagada (src/update/update-key.ts).
  define: {
    __CONNECTOR_VERSION__: JSON.stringify(pkg.version),
    __WEB_PROTOCOLS_SOURCE__: JSON.stringify(protocolSource),
    __SCALE_CONNECT_UPDATE_PUBKEY__: JSON.stringify(updatePublicKey),
  },
  // web-runtime.ts usa import.meta.url solo en desarrollo (cuando no hay __WEB_PROTOCOLS_SOURCE__).
  logOverride: { "empty-import-meta": "silent" },
  banner: { js: `/* Patagonia Scale Connect ${pkg.version} */` },
  logLevel: "warning",
});

const out = Object.entries(result.metafile.outputs).find(([file]) => file.endsWith(".cjs"));
const kb = out ? Math.round(out[1].bytes / 1024) : 0;
console.log(`dist/scale-connect.cjs (${kb} KB) versión ${pkg.version}`);
console.log(`  protocolos de la web: ${Math.round(protocolSource.length / 1024)} KB (${Object.keys(protocols.metafile.inputs).length} archivos)`);
