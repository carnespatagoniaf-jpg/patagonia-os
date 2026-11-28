// La configuración de WinSW (packaging/PatagoniaScaleConnect.xml) tiene que dejar arrancar al servicio con una cuenta
// que NO es administrador. Visto en una PC limpia (scale-connect-e2e): con autoRefresh (el valor por omisión de WinSW)
// el servicio intenta reconfigurarse al arrancar, Windows le niega el acceso y no arranca (error 1053).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(path.join(here, "..", "..", "packaging", "PatagoniaScaleConnect.xml"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
const iss = readFileSync(path.join(here, "..", "..", "packaging", "installer.iss"), "utf8");

test("WinSW no se reconfigura solo al arrancar (autoRefresh apagado)", () => {
  assert.match(xml, /<autoRefresh>\s*false\s*<\/autoRefresh>/);
});

test("el instalador aplica la configuración como administrador (install o refresh)", () => {
  assert.match(iss, /Run\(WinSW, 'refresh'/);
  assert.match(iss, /Run\(WinSW, 'install'/);
});

test("la cuenta del servicio no es SYSTEM ni va en el XML", () => {
  assert.doesNotMatch(xml, /<serviceaccount>/i);
  assert.match(iss, /NT SERVICE\\PatagoniaScaleConnect/);
});
