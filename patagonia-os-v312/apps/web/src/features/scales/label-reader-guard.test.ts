import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * UN SOLO MOTOR DE LECTURA DE ETIQUETAS (pedido del dueño, 28/11/2026).
 *
 * Las pantallas que escanean etiquetas de balanza (Mostrador, venta a cuenta, prueba de etiqueta, Ingreso de stock,
 * Freezer, Decomisos, anular ticket, y cualquier pantalla futura) tienen que usar el lector común:
 *   - resolveScaleLabel (sale/scale-label-resolver.ts): Mostrador y venta a cuenta (Systel + Kretz + ambigüedad).
 *   - readScaleCode (sale/scale-profile-scan.ts): una etiqueta con los perfiles de cada balanza (balanzas_v2) o el
 *     formato del local, igual que Mostrador.
 *   - describeScaleTicket / resolveEntryScan / resolveChargeScan, que ya lo usan por dentro.
 * Las funciones de bajo nivel de abajo solo se pueden llamar desde el propio motor. Si esta prueba falla, la pantalla
 * nueva está interpretando etiquetas por su cuenta: es justo lo que hizo que unas pantallas leyeran distinto que otras.
 */
const LOW_LEVEL = [
  "resolveScan",
  "resolveScanByProfiles",
  "parseWeightBarcode",
  "parseAuraSumTicket",
  "parseSumTicketWithConfig",
  "parseTicketTotalBarcode",
  "parseSystelSumTicket",
  "decodeAcross",
  "decodeScaleCode"
];

/** El motor (y lo que solo existe para probarlo). */
const ENGINE = [
  "features/sale/scan-resolve.ts",
  "features/sale/scale-barcode.ts",
  "features/sale/scale-profile-scan.ts",
  "features/sale/scale-label-resolver.ts",
  "features/sale/scale-control.ts",
  "features/sale/useScalePapers.ts",
  "features/sale/scale-labels-regression-run.ts",
  "features/scales/label-test.ts",
  "features/scales/sale/",
  "features/scales/comparativa/",
  "features/scales/engine/test-"
];

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
  });
}

describe("un solo motor de lectura de etiquetas de balanza", () => {
  it("ninguna pantalla llama directo a las funciones internas del motor", () => {
    const calls = new RegExp(`\\b(${LOW_LEVEL.join("|")})\\s*\\(`, "g");
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      if (ENGINE.some((e) => rel.startsWith(e))) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(calls)) {
        const line = text.slice(0, m.index).split("\n").length;
        const before = text.slice(Math.max(0, (m.index ?? 0) - 9), m.index);
        if (/function\s*$/.test(before)) continue;
        offenders.push(`${rel}:${line} ${m[1]}(…)`);
      }
    }
    assert.deepEqual(offenders, [], `Estas pantallas interpretan etiquetas por su cuenta; usá resolveScaleLabel o readScaleCode:\n${offenders.join("\n")}`);
  });
});
