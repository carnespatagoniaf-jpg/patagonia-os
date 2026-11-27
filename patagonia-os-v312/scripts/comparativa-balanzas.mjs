#!/usr/bin/env node
/**
 * Prueba comparativa de balanzas: corre los escenarios de
 * apps/web/src/features/scales/comparativa/escenarios.ts contra DOS carpetas del repo (el sistema viejo y el nuevo)
 * y arma la tabla del informe (docs/COMPARATIVA_BALANZAS.md).
 *
 * Uso (desde patagonia-os-v312, con las dependencias instaladas en las DOS carpetas):
 *   node --import tsx scripts/comparativa-balanzas.mjs --viejo <carpeta patagonia-os-v312 de main> [--nuevo <carpeta>] [--json salida.json]
 *   node --import tsx scripts/comparativa-balanzas.mjs --raiz <carpeta>      (una sola versión, imprime JSON)
 *
 * Los escenarios y los simuladores salen SIEMPRE de esta carpeta (la rama nueva); el código de producción, de la
 * carpeta bajo prueba. Cada versión corre en su propio proceso (estado de módulos y globales separados).
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const aqui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function correrUna(raiz, version) {
  const base = join(resolve(raiz), "apps/web/src/features");
  const archivo = (ruta) => join(base, `${ruta}.ts`);
  const cargador = {
    version,
    tiene: (ruta) => existsSync(archivo(ruta)),
    importar: (ruta) => {
      if (!existsSync(archivo(ruta))) throw new Error(`no existe ${ruta}.ts en ${version}`);
      return import(pathToFileURL(archivo(ruta)).href);
    }
  };
  const { ESCENARIOS, correrEscenario } = await import(pathToFileURL(join(aqui, "apps/web/src/features/scales/comparativa/escenarios.ts")).href);
  const out = [];
  for (const e of ESCENARIOS) out.push({ id: e.id, ...(await correrEscenario(e, cargador)) });
  return out;
}

if (arg("--raiz")) {
  const r = await correrUna(arg("--raiz"), arg("--version") ?? "nuevo");
  process.stdout.write(`@@JSON@@${JSON.stringify(r)}\n`);
  process.exit(0);
}

const viejo = arg("--viejo");
if (!viejo) {
  console.error("Falta --viejo <carpeta patagonia-os-v312 de main>");
  process.exit(2);
}
const nuevo = arg("--nuevo") ?? aqui;

function enProceso(raiz, version) {
  const p = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--raiz", raiz, "--version", version], { cwd: aqui, encoding: "utf8", maxBuffer: 1 << 24 });
  const linea = (p.stdout ?? "").split("\n").find((l) => l.startsWith("@@JSON@@"));
  if (!linea) {
    console.error(p.stdout, p.stderr);
    throw new Error(`falló la corrida ${version}`);
  }
  return JSON.parse(linea.slice(8));
}

const { ESCENARIOS } = await import(pathToFileURL(join(aqui, "apps/web/src/features/scales/comparativa/escenarios.ts")).href);
const antes = enProceso(viejo, "viejo");
const ahora = enProceso(nuevo, "nuevo");
const celda = (s) => String(s).replace(/\|/g, "/").replace(/\n/g, " ");
const filas = ESCENARIOS.map((e) => {
  const a = antes.find((x) => x.id === e.id);
  const n = ahora.find((x) => x.id === e.id);
  const estado = a.correcto && n.correcto ? "Ya andaba" : !a.correcto && n.correcto ? "Resuelto" : n.correcto ? "Resuelto" : a.correcto ? "EMPEORÓ" : "SIGUE MAL";
  return { e, a, n, estado };
});
const lineas = [
  "| # | Escenario (cliente, fecha) | Antes (main, observado) | Ahora (rama nueva, observado) | ¿Resuelto? |",
  "|---|---|---|---|---|",
  ...filas.map(({ e, a, n, estado }) => `| ${e.id} | **${celda(e.titulo)}** — ${celda(e.cliente)}, ${celda(e.fecha)} | ${a.correcto ? "✅" : "❌"} ${celda(a.resultado)}${a.ejecucion === "parcial" ? " ⁽ᵖ⁾" : ""} | ${n.correcto ? "✅" : "❌"} ${celda(n.resultado)}${n.ejecucion === "parcial" ? " ⁽ᵖ⁾" : ""} | ${estado} |`)
];
const malAntes = filas.filter((f) => !f.a.correcto).length;
const malAhora = filas.filter((f) => !f.n.correcto).length;
lineas.push("", `Total: ${filas.length} escenarios. Mal antes: ${malAntes}. Mal ahora: ${malAhora}.`);
console.log(lineas.join("\n"));
if (arg("--json")) writeFileSync(arg("--json"), JSON.stringify({ antes, ahora }, null, 2));
