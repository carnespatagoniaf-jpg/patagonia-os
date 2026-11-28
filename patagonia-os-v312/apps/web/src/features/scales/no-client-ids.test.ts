import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * PRUEBA ANTI-PARCHES (plan balanzas v2 §3.3 paso 5): el código de balanzas no pregunta QUIÉN es el cliente, pregunta
 * qué perfil tiene la balanza (scale_profiles.label_spec). Falla si aparece un UUID (empresa, sucursal o lo que sea)
 * en el código de features/scales/**, sale/scan-resolve.ts, sale/scale-label-resolver.ts o sale/scale-profile-scan.ts.
 *
 * Las pruebas (*.test.ts) quedan afuera: usan UUID como datos de prueba (productos reales de un banco), no deciden nada.
 * Un dato por cliente va en una migración (como la 223), nunca en el código.
 */
const EXCEPCIONES_TEMPORALES: Record<string, string> = {
  // Las 4 listas por cliente de hoy. Se BORRA (archivo y excepción) cuando 'balanzas_v2' esté encendido para todos y
  // la equivalencia de dos semanas con los pilotos dé igual (plan §3.3). La migración 223 ya las tiene como dato.
  "scales/engine/weight-barcode.ts": "listas por cliente previas a balanzas_v2"
};

const features = fileURLToPath(new URL("..", import.meta.url));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const rel = (f: string) => relative(features, f).replaceAll("\\", "/");
const code = (f: string) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f);

describe("Sin identificadores de clientes en el código de balanzas", () => {
  it("ningún UUID en scales/** ni en los lectores de etiquetas de Mostrador", () => {
    const files = [
      ...walk(join(features, "scales")).filter(code),
      ...["sale/scan-resolve.ts", "sale/scale-label-resolver.ts", "sale/scale-profile-scan.ts"].map((f) => join(features, f))
    ];
    assert.ok(files.length > 50, "no encontró los archivos de balanzas");
    const hits = files.filter((f) => !EXCEPCIONES_TEMPORALES[rel(f)]).flatMap((f) =>
      readFileSync(f, "utf8").split(/\r?\n/).flatMap((line, i) => (UUID.test(line) ? [`${rel(f)}:${i + 1}: ${line.trim().slice(0, 120)}`] : []))
    );
    assert.deepEqual(hits, [], `Identificadores en el código de balanzas (van como dato en una migración, no en el código):\n${hits.join("\n")}`);
  });

  it("la excepción temporal sigue existiendo (si se borró el archivo, sacala de la lista)", () => {
    for (const f of Object.keys(EXCEPCIONES_TEMPORALES)) assert.ok(statSync(join(features, f)).isFile(), f);
  });
});
