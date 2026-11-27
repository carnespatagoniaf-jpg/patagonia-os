// Reglas de seguridad del canal local, las mismas del programa de impresión
// actual (apps/web/public/patagonia-print-agent.ps1):
// - Origin permitido: https://*.patagoniasystem.com.ar (y el dominio pelado),
//   o http://localhost / http://127.0.0.1 con cualquier puerto (desarrollo).
// - Host exacto "127.0.0.1:<puerto>" o "localhost:<puerto>": frena el
//   "DNS rebinding" (una página que hace que su dominio apunte a 127.0.0.1).

const PRODUCTION_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*patagoniasystem\.com\.ar$/i;
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/i;

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  return PRODUCTION_ORIGIN.test(origin) || DEV_ORIGIN.test(origin);
}

export function isAllowedHost(host: string | undefined | null, port: number): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** Solo se escucha en loopback IPv4. */
export function isLoopbackBindAddress(address: string): boolean {
  return address === "127.0.0.1";
}
