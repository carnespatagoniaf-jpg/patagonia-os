// El actualizador corre como SYSTEM: si el servicio (NT SERVICE\PatagoniaScaleConnect, sin privilegios) pudiera
// escribir donde está lo que corre SYSTEM, se escalaría a administrador. No se puede correr Inno Setup ni registrar
// tareas en las pruebas: se revisa el texto de packaging/installer.iss y packaging/updater-task.ps1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packaging = path.join(here, "..", "..", "packaging");
const iss = readFileSync(path.join(packaging, "installer.iss"), "utf8");
const task = readFileSync(path.join(packaging, "updater-task.ps1"), "utf8");
const code = iss.split(/\r?\n/).filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith(";"));
const icacls = code.filter((l) => l.includes("icacls.exe"));
const onUpdater = icacls.filter((l) => l.includes("UpdaterDir"));

test("la carpeta del actualizador es solo de SYSTEM y Administradores (sin herencia, sin el servicio)", () => {
  assert.ok(onUpdater.some((l) => /\/setowner \*S-1-5-32-544 \/T/.test(l)), onUpdater.join("\n"));
  const grant = onUpdater.find((l) => l.includes("/inheritance:r"));
  assert.ok(grant, "falta /inheritance:r en la carpeta del actualizador");
  assert.match(grant, /\/grant:r \*S-1-5-18:\(OI\)\(CI\)F \*S-1-5-32-544:\(OI\)\(CI\)F \/T/);
  for (const l of onUpdater) {
    assert.doesNotMatch(l, /NT SERVICE|LocalService|S-1-5-19|S-1-5-32-545|S-1-1-0|S-1-5-11|Users|Usuarios|Everyone|Todos/i, l);
    // El servicio aparece SOLO en avisos\, y solo para leer.
    if (l.includes("ServiceAccountUsed")) {
      assert.match(l, /UpdaterDir \+ '\\avisos" \/grant "' \+ ServiceAccountUsed \+ ':\(OI\)\(CI\)RX" /, l);
    }
  }
  assert.equal(onUpdater.filter((l) => l.includes("ServiceAccountUsed")).length, 1);
});

test("avisos\\ se le abre al servicio DESPUÉS de cerrar y reiniciar los permisos (si no, /reset lo borraría)", () => {
  const body = iss.slice(iss.indexOf("procedure SetupUpdater"), iss.indexOf("procedure CurStepChanged"));
  assert.ok(body.indexOf("/reset") > 0 && body.indexOf("\\avisos\" /grant") > body.indexOf("/reset"));
});

test("si no se pudieron cerrar los permisos, no se registra la tarea", () => {
  const body = iss.slice(iss.indexOf("procedure SetupUpdater"), iss.indexOf("procedure CurStepChanged"));
  const acl = body.indexOf("/inheritance:r");
  const exitAfterAcl = body.indexOf("exit;", acl);
  const taskAt = body.indexOf("updater-task.ps1");
  assert.ok(acl > 0 && exitAfterAcl > acl && taskAt > exitAfterAcl);
});

test("al servicio solo se le da lectura y ejecución en la carpeta del programa (de donde corre la tarea)", () => {
  const onApp = icacls.filter((l) => l.includes("{app}"));
  assert.equal(onApp.length, 1, onApp.join("\n"));
  assert.match(onApp[0], /ServiceAccountUsed \+ ':\(OI\)\(CI\)RX"/);
  assert.doesNotMatch(onApp[0], /:\(OI\)\(CI\)(F|M|W)|\(W\)|\(M\)|\(F\)/);
  // La carpeta del programa es la de Program Files (solo administradores escriben ahí).
  assert.match(iss, /DefaultDirName=\{autopf\}\\Patagonia\\Scale Connect/);
});

test("la tarea corre como SYSTEM el ejecutable de Program Files, y nada del área del servicio", () => {
  assert.match(task, /New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest/);
  assert.match(task, /New-ScheduledTaskAction -Execute \$Exe -Argument '--update'/);
  assert.match(task, /-AtStartup/);
  assert.match(task, /-RepetitionInterval \(New-TimeSpan -Minutes 15\)/);
  assert.match(task, /-MultipleInstances IgnoreNew/);
  const register = code.find((l) => l.includes("updater-task.ps1") && l.includes("-Exe"));
  assert.ok(register, "el instalador registra la tarea");
  assert.match(register, /\{app\}\\scale-connect\.exe/);
  assert.doesNotMatch(register, /commonappdata|DataDir/);
  // PowerShell por ruta completa (no por el PATH).
  assert.match(iss, /\{sys\}\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
});

test("el instalador guarda su propio .exe como el de la versión instalada (para volver atrás)", () => {
  assert.match(iss, /ExpandConstant\('\{srcexe\}'\)/);
  assert.match(iss, /'\\instaladores\\actual\.exe'/);
  assert.match(iss, /#define UpdaterSubdir "Patagonia\\ScaleConnect-Updater"/);
});

test("desinstalar saca la tarea y la carpeta del actualizador", () => {
  assert.match(iss, /updater-task\.ps1'\) \+ '" -Remove'/);
  assert.match(iss, /DelTree\(UpdaterDir, True, True, True\)/);
});

test("el script de la tarea es ASCII (PowerShell 5.1 sin BOM lo lee como ANSI)", () => {
  assert.ok(/^[\x00-\x7F]*$/.test(task));
});
