// Instalador FALSO para las pruebas del actualizador (updater.test.ts). Nunca se corre un instalador real.
// Uso: node fake-installer.mjs <"instalador"> <archivo-del-servicio>
// El "instalador" es un JSON {version, exit, starts}: si starts, deja el servicio "corriendo" esa versión
// (escribe {version} en el archivo del servicio); si no, lo deja caído. Sale con `exit`.
import { readFileSync, writeFileSync } from "node:fs";

const [installer, serviceFile] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(installer, "utf8"));
writeFileSync(serviceFile, JSON.stringify(spec.starts ? { version: spec.version } : {}));
process.exit(spec.exit ?? 0);
