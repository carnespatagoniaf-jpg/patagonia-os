// Carpetas de la actualización automática.
//
// - Del ACTUALIZADOR (tarea programada como SYSTEM): %ProgramData%\Patagonia\ScaleConnect-Updater\
//   Solo SYSTEM y Administradores (lo pone el instalador, sin herencia de ProgramData). El servicio NO puede ni leerla:
//   ahí están los instaladores guardados para volver atrás y la copia del ejecutable que corre como SYSTEM.
//     estado.json                 versión instalada, la anterior (con su SHA-256), versiones bloqueadas, última revisión
//     instaladores\actual.exe     el instalador de la versión instalada (lo copia el propio instalador y el actualizador)
//     instaladores\anterior.exe   el de la versión anterior (para volver atrás)
//     descargas\                  el instalador nuevo, ya verificado
//     bin\scale-connect-updater-<versión>.exe   copia del ejecutable que corre la actualización
//     logs\                       bitácora del actualizador y de cada instalación
//     avisos\pausa.json           el servicio no toma trabajos nuevos mientras tanto
//     avisos\resultado.json       qué pasó la última vez (el servicio lo muestra en /status)
//     (avisos\ es lo ÚNICO que el servicio puede leer, y no puede escribir nada en toda la carpeta)
// - Del SERVICIO: <datos>\update\pedido.json, que deja cuando la nube ofrece una versión nueva. El actualizador solo
//   mira si existe y su fecha (lo "despierta" antes de las 6 h); nunca lee su contenido ni escribe ni borra nada en la
//   carpeta de datos: si lo hiciera, el servicio podría poner ahí un enlace (junction) y hacer que SYSTEM escriba o
//   borre en otro lado.

import path from "node:path";

export interface UpdaterPaths {
  root: string;
  stateFile: string;
  installersDir: string;
  currentInstaller: string;
  previousInstaller: string;
  downloadsDir: string;
  binDir: string;
  logsDir: string;
  lockFile: string;
}

export interface UpdateSignalPaths {
  /** Del servicio (carpeta de datos). */
  requestFile: string;
  /** Del actualizador (avisos\, el servicio solo lee). */
  pauseFile: string;
  resultFile: string;
}

export function resolveUpdaterPaths(input: { dev: boolean; env: Record<string, string | undefined>; cwd: string }): UpdaterPaths {
  const override = input.env.PATAGONIA_UPDATER_HOME?.trim();
  const programData = input.env.ProgramData ?? input.env.PROGRAMDATA ?? "C:\\ProgramData";
  const root = override
    ? path.resolve(input.cwd, override)
    : input.dev
      ? path.join(input.cwd, ".data-updater")
      : path.win32.join(programData, "Patagonia", "ScaleConnect-Updater");
  const join = override || input.dev ? path.join : path.win32.join;
  return {
    root,
    stateFile: join(root, "estado.json"),
    installersDir: join(root, "instaladores"),
    currentInstaller: join(root, "instaladores", "actual.exe"),
    previousInstaller: join(root, "instaladores", "anterior.exe"),
    downloadsDir: join(root, "descargas"),
    binDir: join(root, "bin"),
    logsDir: join(root, "logs"),
    lockFile: join(root, "en-curso.json"),
  };
}

/** `dataRoot` = la carpeta de datos del servicio (ConnectorPaths.root); `updaterRoot` = UpdaterPaths.root. */
export function updateSignalPaths(dataRoot: string, updaterRoot: string): UpdateSignalPaths {
  const j = (p: string) => (/^[A-Za-z]:\\/.test(p) ? path.win32.join : path.join);
  return {
    requestFile: j(dataRoot)(dataRoot, "update", "pedido.json"),
    pauseFile: j(updaterRoot)(updaterRoot, "avisos", "pausa.json"),
    resultFile: j(updaterRoot)(updaterRoot, "avisos", "resultado.json"),
  };
}
