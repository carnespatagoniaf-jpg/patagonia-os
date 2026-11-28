// Versión con la que se arma el programa: la de package.json, o la de la variable SCALE_CONNECT_VERSION (solo para
// pruebas: la e2e de actualización arma 9.0.0, 9.0.1 y 9.0.2 sin tocar package.json). La usan build.mjs (la que queda
// adentro del ejecutable), package-sea.mjs (build-info.json), build-installer.mjs (el instalador) y smoke-exe.mjs.

export const VERSION_ENV = "SCALE_CONNECT_VERSION";

/** Inno Setup (VersionInfoVersion) solo acepta números: X.Y.Z. */
export function buildVersion(pkgVersion, env = process.env) {
  const override = String(env[VERSION_ENV] ?? "").trim();
  if (!override) return pkgVersion;
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(override)) throw new Error(`${VERSION_ENV}="${override}" no es una versión X.Y.Z.`);
  return override;
}
