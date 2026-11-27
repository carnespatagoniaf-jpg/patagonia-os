// Programas de Windows que corre el servicio (powershell.exe para DPAPI, reg.exe para la huella), SIEMPRE con la
// ruta completa dentro de %SystemRoot%\System32. Con el nombre pelado, Windows lo busca también en las carpetas del
// PATH del sistema: si algún programa instalado dejó ahí una carpeta donde cualquier usuario puede escribir, un
// "powershell.exe" puesto en esa carpeta correría con la cuenta del servicio y vería el secreto (que viaja por su
// entrada estándar).

import path from "node:path";

/** Ruta completa de un programa de System32 ("WindowsPowerShell\\v1.0\\powershell.exe", "reg.exe"). */
export function systemExe(relative: string, env: Record<string, string | undefined> = process.env): string {
  const raw = (env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "").trim();
  // Solo una ruta absoluta de disco (C:\Windows). Cualquier otra cosa (vacía, relativa, de red) = la de fábrica.
  const root = /^[A-Za-z]:\\[^"<>|?*]*$/.test(raw) && !raw.includes("..") ? raw : "C:\\Windows";
  return path.win32.join(root, "System32", relative);
}

export const POWERSHELL_RELATIVE = "WindowsPowerShell\\v1.0\\powershell.exe";
export const REG_RELATIVE = "reg.exe";
