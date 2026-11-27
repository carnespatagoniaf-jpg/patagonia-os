// Build: todo el servicio en UN solo archivo CommonJS (dist/scale-connect.cjs),
// listo para correr con `node` o para meterlo en un ejecutable Node SEA.
// `serialport` queda afuera (es nativo: el .node va al lado del .exe).

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const result = await build({
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "dist", "scale-connect.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["serialport"],
  sourcemap: "linked",
  legalComments: "none",
  metafile: true,
  define: { __CONNECTOR_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `/* Patagonia Scale Connect ${pkg.version} */` },
  logLevel: "warning",
});

const out = Object.entries(result.metafile.outputs).find(([file]) => file.endsWith(".cjs"));
const kb = out ? Math.round(out[1].bytes / 1024) : 0;
console.log(`dist/scale-connect.cjs (${kb} KB) versión ${pkg.version}`);
