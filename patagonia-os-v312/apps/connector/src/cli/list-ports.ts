// Lista los puertos COM/USB/Bluetooth reales de esta PC, ya clasificados.
// Uso: npm run ports -w @patagonia/connector   (agregá --raw para ver lo que devuelve Windows)

import { SerialportLister, discoverPorts } from "../discovery/port-lister";

async function main(): Promise<void> {
  const lister = new SerialportLister();
  if (process.argv.includes("--raw")) {
    process.stdout.write(`${JSON.stringify(await lister.list(), null, 2)}\n`);
    return;
  }
  const result = await discoverPorts(lister);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (result.ports.length === 0) {
    process.stdout.write("No hay puertos serie en esta PC (ni COM, ni USB-serie, ni Bluetooth).\n");
    return;
  }
  for (const p of result.ports) {
    const ids = p.vendorId ? ` ${p.vendorId}:${p.productId ?? "????"}` : "";
    process.stdout.write(`${p.path.padEnd(6)} ${p.kind.padEnd(9)} ${p.chipLabel}${ids}  huella=${p.fingerprint}\n`);
    for (const note of p.notes) process.stdout.write(`        · ${note}\n`);
  }
}

void main();
