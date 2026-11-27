// Carpetas del servicio.
//   Producción: %ProgramData%\Patagonia\ScaleConnect\
//   Desarrollo (--dev): apps/connector/.data/
//   Siempre se puede forzar con PATAGONIA_CONNECT_HOME.

import path from "node:path";

export interface ConnectorPaths {
  root: string;
  configFile: string;
  logsDir: string;
  journalFile: string;
}

export function resolvePaths(input: {
  dev: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
}): ConnectorPaths {
  const override = input.env.PATAGONIA_CONNECT_HOME?.trim();
  const programData = input.env.ProgramData ?? input.env.PROGRAMDATA ?? "C:\\ProgramData";
  const root = override
    ? path.resolve(input.cwd, override)
    : input.dev
      ? path.join(input.cwd, ".data")
      : path.win32.join(programData, "Patagonia", "ScaleConnect");
  const join = override || input.dev ? path.join : path.win32.join;
  return {
    root,
    configFile: join(root, "config.json"),
    logsDir: join(root, "logs"),
    journalFile: join(root, "journal", "jobs.json"),
  };
}
