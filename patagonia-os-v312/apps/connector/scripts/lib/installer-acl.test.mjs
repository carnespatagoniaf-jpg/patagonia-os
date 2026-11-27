// El instalador (packaging/installer.iss) cierra la carpeta de datos: ahí está la credencial de la PC cifrada con
// DPAPI de MÁQUINA, que cualquier usuario de la PC puede descifrar si puede leer el archivo. No se puede correr Inno
// Setup en las pruebas: se revisa el texto de los comandos icacls que corre.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const iss = readFileSync(path.join(here, "..", "..", "packaging", "installer.iss"), "utf8");
const icacls = iss
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith(";") && l.includes("icacls.exe"));
const onData = icacls.filter((l) => l.includes("DataDir"));

test("la carpeta de datos queda con dueño Administradores", () => {
  assert.ok(onData.some((l) => /\/setowner \*S-1-5-32-544 \/T/.test(l)), onData.join("\n"));
});

test("la carpeta de datos no hereda de ProgramData y solo tiene SYSTEM, Administradores y el servicio", () => {
  const grant = onData.find((l) => l.includes("/inheritance:r"));
  assert.ok(grant, "falta /inheritance:r");
  assert.match(grant, /\/grant:r /, "los permisos se reemplazan, no se suman");
  assert.match(grant, /\*S-1-5-18:\(OI\)\(CI\)F/);
  assert.match(grant, /\*S-1-5-32-544:\(OI\)\(CI\)F/);
  assert.match(grant, /ServiceAccountUsed \+ ':\(OI\)\(CI\)M"/);
  assert.match(grant, /\/T /);
});

test("ningún comando le da permisos a Usuarios, Todos o Usuarios autenticados", () => {
  for (const l of icacls) {
    assert.doesNotMatch(l, /S-1-5-32-545|S-1-1-0|S-1-5-11|\bUsers\b|Usuarios|Everyone|Todos/i, l);
  }
});

test("los permisos se ponen ANTES de iniciar el servicio (la credencial nunca existe con los de ProgramData)", () => {
  const acl = iss.indexOf("/inheritance:r");
  const start = iss.indexOf("Run(WinSW, 'start'");
  assert.ok(acl > 0 && start > acl);
});
