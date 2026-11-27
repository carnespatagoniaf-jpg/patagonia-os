// Punto de entrada del servicio. En producción lo arranca WinSW
// (PatagoniaScaleConnect.xml); en desarrollo: npm run dev -w @patagonia/connector

import { resolvePaths } from "./config/paths";
import { startService } from "./service";
import { CONNECTOR_VERSION } from "./version";
import { cloudUrlFor, describeCloud, setCloudInConfig } from "./cloud/cloud-targets";

async function main(): Promise<void> {
  // `scale-connect.exe --version`: lo usan el instalador, el CI y soporte. No toca datos ni puertos.
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${CONNECTOR_VERSION}\n`);
    return;
  }
  const dev = process.argv.includes("--dev");
  const paths = resolvePaths({ dev, env: process.env, cwd: process.cwd() });

  // `scale-connect.exe --set-cloud produccion|pruebas|https://… [--if-missing]`: lo corre el instalador (/NUBE=).
  // Escribe solo cloud.url en config.json y sale. No arranca el servicio ni toca puertos.
  const setCloud = process.argv.indexOf("--set-cloud");
  if (setCloud >= 0) {
    const value = process.argv[setCloud + 1] ?? "";
    const url = cloudUrlFor(value);
    if (!url) {
      process.stderr.write(`Nube inválida: "${value}". Usá produccion, pruebas o una dirección https://…/functions/v1
`);
      process.exitCode = 2;
      return;
    }
    const r = await setCloudInConfig(paths.configFile, url, { ifMissing: process.argv.includes("--if-missing") });
    process.stdout.write(`${r.reason}: ${r.url} (${describeCloud(r.url).label}) en ${paths.configFile}
`);
    return;
  }

  const service = await startService({ paths, dev });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    service.logger.info("Señal de apagado", { signal });
    // Si algo se traba al apagar, se sale igual: WinSW no debe esperar para siempre.
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    service
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  // WinSW manda Ctrl+C (SIGINT); SIGBREAK es Ctrl+Break en Windows.
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, () => shutdown(signal));

  // Una falla inesperada se anota; el servicio se apaga prolijo y WinSW lo reinicia.
  process.on("uncaughtException", (error) => {
    service.logger.error("Error no controlado", { error });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    service.logger.error("Promesa rechazada sin manejar", { error: reason });
  });

  if (dev) {
    process.stdout.write(
      `\nPatagonia Scale Connect (desarrollo)\n  Datos: ${paths.root}\n  Estado: http://127.0.0.1:${service.port}/status\n  Ctrl+C para salir.\n\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`No arrancó Patagonia Scale Connect: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
