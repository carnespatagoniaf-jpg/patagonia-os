// Lado del SERVICIO de la actualización automática (ver updater.ts y update-paths.ts).
//
// El servicio no instala nada (no puede: no es administrador). Solo:
// - deja <datos>\update\pedido.json cuando la nube le ofrece una versión más nueva (así la tarea programada, que mira
//   cada 15 minutos, no espera las 6 horas);
// - mientras exista <datos>\update\pausa.json vigente (lo escribe el actualizador), no toma trabajos nuevos de la nube,
//   para que el actualizador encuentre /status sin trabajos en curso;
// - muestra en /status el último resultado (resultado.json).

import { promises as fs } from "node:fs";
import { silentLogger, type Logger } from "../log/logger";
import { writeFileAtomic } from "../storage/atomic-file";
import type { UpdateSignalPaths } from "./update-paths";
import { isNewer, type UpdateResult } from "./updater";

/** Una pausa nunca dura más que esto, aunque el archivo diga otra cosa (un archivo viejo no frena al servicio). */
export const MAX_PAUSE_MS = 60 * 60_000;

export interface UpdateSignalsOptions {
  paths: UpdateSignalPaths;
  currentVersion: string;
  /** false = el ejecutable no trae clave pública: no se pide nada. */
  enabled: boolean;
  disabledReason?: string | null;
  logger?: Logger;
  now?: () => Date;
}

export class UpdateSignals {
  private readonly log: Logger;
  private readonly now: () => Date;
  private requested: string | null = null;
  private offered: string | null = null;
  private pauseCache: { at: number; until: number | null } = { at: 0, until: null };
  private lastResult: UpdateResult | null = null;

  constructor(private readonly options: UpdateSignalsOptions) {
    this.log = (options.logger ?? silentLogger).child({ module: "actualizacion" });
    this.now = options.now ?? (() => new Date());
  }

  /** Con cada configuración de la nube: la versión que le corresponde a esta PC (o null). */
  async onOffer(version: string | null): Promise<void> {
    this.offered = version;
    if (!this.options.enabled || !isNewer(version, this.options.currentVersion) || this.requested === version) return;
    try {
      await writeFileAtomic(this.options.paths.requestFile, `${JSON.stringify({ version, at: this.now().toISOString() })}\n`);
      this.requested = version;
      this.log.info("Hay una versión nueva: se avisó al actualizador", { version });
    } catch (error) {
      this.log.warn("No se pudo dejar el pedido de actualización", { error });
    }
  }

  /** ¿El actualizador pidió no tomar trabajos nuevos? (lee el archivo como mucho cada 5 s) */
  async claimsPaused(): Promise<boolean> {
    const now = this.now().getTime();
    if (now - this.pauseCache.at >= 5_000) {
      let until: number | null = null;
      try {
        const raw = JSON.parse(await fs.readFile(this.options.paths.pauseFile, "utf8")) as { until?: unknown; writtenAt?: unknown };
        const parsed = typeof raw.until === "string" ? Date.parse(raw.until) : NaN;
        const written = typeof raw.writtenAt === "string" ? Date.parse(raw.writtenAt) : NaN;
        // Acotada desde que se escribió: si el actualizador se cortó y dejó el archivo, el servicio sigue solo.
        if (!Number.isNaN(parsed) && !Number.isNaN(written)) until = Math.min(parsed, written + MAX_PAUSE_MS, now + MAX_PAUSE_MS);
      } catch {
        until = null;
      }
      this.pauseCache = { at: now, until };
    }
    return this.pauseCache.until !== null && this.pauseCache.until > now;
  }

  async refreshResult(): Promise<void> {
    try {
      this.lastResult = JSON.parse(await fs.readFile(this.options.paths.resultFile, "utf8")) as UpdateResult;
    } catch {
      this.lastResult = null;
    }
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.options.enabled,
      disabledReason: this.options.enabled ? null : (this.options.disabledReason ?? null),
      offered: this.offered,
      requested: this.requested,
      paused: this.pauseCache.until !== null && this.pauseCache.until > this.now().getTime(),
      lastResult: this.lastResult,
    };
  }
}

/** Lado del actualizador: escribe o borra pausa.json. */
export async function writePause(paths: UpdateSignalPaths, until: Date | null, version: string | null, now = new Date()): Promise<void> {
  if (!until) {
    await fs.rm(paths.pauseFile, { force: true });
    return;
  }
  await writeFileAtomic(paths.pauseFile, `${JSON.stringify({ until: until.toISOString(), writtenAt: now.toISOString(), version })}\n`);
}
