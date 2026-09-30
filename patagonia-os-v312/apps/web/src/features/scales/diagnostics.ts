import type { ScaleDriver } from "./types";

/**
 * Diagnóstico automático (punto 7 del diseño): a diferencia de "Probar"
 * (una prueba puntual al configurar), esto corre una secuencia de pasos
 * completa y devuelve un reporte en criollo, paso por paso -- pensado para
 * cuando algo que antes andaba dejó de andar, y hay que decirle al dueño
 * qué mirar antes de mandar el problema a soporte.
 */
export interface DiagnosticStep {
  label: string;
  ok: boolean;
  detail: string;
}

export interface DiagnosticReport {
  steps: DiagnosticStep[];
  overallOk: boolean;
  /** Resumen de una línea, para mostrar arriba de todo. */
  summary: string;
}

export async function runScaleDiagnostics(driver: ScaleDriver, port: SerialPort, settings: Record<string, unknown>): Promise<DiagnosticReport> {
  const steps: DiagnosticStep[] = [];

  // 1) Conectividad física: ping si el driver lo tiene; si no, un identify()
  //    nuevo sirve como prueba de que el cable/puerto responde algo.
  if (driver.ping) {
    try {
      const ping = await driver.ping(port, settings);
      steps.push({ label: "Conexión con la balanza", ok: ping.ok, detail: ping.message ?? (ping.ok ? "Responde" : "Sin respuesta") });
    } catch (err) {
      steps.push({ label: "Conexión con la balanza", ok: false, detail: err instanceof Error ? err.message : "Sin respuesta" });
    }
  } else {
    try {
      const identify = await driver.identify(port);
      steps.push({ label: "Conexión con la balanza", ok: identify.matched, detail: identify.matched ? "Responde" : "Sin respuesta" });
    } catch (err) {
      steps.push({ label: "Conexión con la balanza", ok: false, detail: err instanceof Error ? err.message : "Sin respuesta" });
    }
  }

  // 2) Si el paso 1 falló, no tiene sentido seguir probando lectura/escritura.
  if (!steps[0].ok) {
    return { steps, overallOk: false, summary: "No se pudo hablar con la balanza -- revisá el cable y que esté encendida." };
  }

  // 3) Capacidad principal: lectura de peso, o prueba de certificación PLU.
  if (driver.capabilities.includes("readWeight") && driver.readWeight) {
    try {
      const reading = await driver.readWeight(port, settings);
      steps.push({ label: "Lectura de peso", ok: true, detail: `Leyó ${reading.weightKg.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` });
    } catch (err) {
      steps.push({ label: "Lectura de peso", ok: false, detail: err instanceof Error ? err.message : "No se pudo leer el peso" });
    }
  } else if (driver.runCertificationTest) {
    try {
      const result = await driver.runCertificationTest(port, settings);
      steps.push({ label: "Envío y lectura de productos", ok: result.passed, detail: result.message });
    } catch (err) {
      steps.push({ label: "Envío y lectura de productos", ok: false, detail: err instanceof Error ? err.message : "Falló la prueba" });
    }
  }

  const overallOk = steps.every((s) => s.ok);
  const summary = overallOk
    ? "Todo funciona correctamente."
    : "Hay un problema -- mirá el detalle de cada paso abajo antes de escribir a soporte.";
  return { steps, overallOk, summary };
}
