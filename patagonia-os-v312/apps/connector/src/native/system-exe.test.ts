import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POWERSHELL_RELATIVE, REG_RELATIVE, systemExe } from "./system-exe";

const here = path.dirname(fileURLToPath(import.meta.url));

test("powershell.exe y reg.exe van siempre con la ruta completa de System32", () => {
  assert.equal(systemExe(POWERSHELL_RELATIVE, { SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(systemExe(REG_RELATIVE, { SystemRoot: "D:\\WINNT" }), "D:\\WINNT\\System32\\reg.exe");
  assert.equal(systemExe(REG_RELATIVE, { windir: "C:\\Windows" }), "C:\\Windows\\System32\\reg.exe");
});

test("un SystemRoot raro (vacío, relativo, de red, con ..) no se usa: queda C:\\Windows", () => {
  for (const bad of ["", "Windows", "\\\\servidor\\c$\\Windows", "C:\\Windows\\..\\Usuarios\\x", "C:Windows"]) {
    assert.equal(systemExe(REG_RELATIVE, { SystemRoot: bad }), "C:\\Windows\\System32\\reg.exe", bad);
  }
  assert.equal(systemExe(REG_RELATIVE, {}), "C:\\Windows\\System32\\reg.exe");
});

test("el código del servicio no llama a powershell.exe ni a reg.exe por el nombre pelado", () => {
  for (const file of ["../cloud/credential-store.ts", "../cloud/fingerprint.ts"]) {
    const source = readFileSync(path.join(here, file), "utf8");
    assert.doesNotMatch(source, /execFile\(\s*"(powershell|reg)(\.exe)?"/i, file);
  }
});
