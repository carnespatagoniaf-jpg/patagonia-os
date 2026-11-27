// Versión del conector. El build de esbuild la reemplaza por la de package.json
// (define __CONNECTOR_VERSION__); en desarrollo (tsx) queda "dev".
declare const __CONNECTOR_VERSION__: string | undefined;

export const CONNECTOR_VERSION: string =
  typeof __CONNECTOR_VERSION__ === "string" ? __CONNECTOR_VERSION__ : "0.1.0-dev";

export const SERVICE_NAME = "patagonia-scale-connect";
