// Punto de entrada del servicio. En producción lo arranca WinSW
// (PatagoniaScaleConnect.xml); en desarrollo: npm run dev -w @patagonia/connector

import { resolvePaths } from "./config/paths";
import { startService } from "./service";

async function main(): Promise<void> {
  const dev = process.argv.includes("--dev");
  const paths = resolvePaths({ dev, env: process.env, cwd: process.cwd() });
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
