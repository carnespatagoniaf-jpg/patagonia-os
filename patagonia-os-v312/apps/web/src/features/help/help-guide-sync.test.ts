import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * El chat de ayuda (supabase/functions/help-chat) contesta SOLO con su guía
 * escrita a mano. Si se agrega una pantalla al menú y nadie la agrega a la
 * guía, el chat dice que no existe o manda a la pantalla vieja (pasó con
 * Balanzas e Importar). Este test lo corta en `npm run test`.
 * Al arreglarlo: agregar la pantalla a la guía Y volver a publicar la
 * función (ver CLAUDE.md, "AI help chat").
 */

const here = dirname(fileURLToPath(import.meta.url));
const layout = readFileSync(resolve(here, "../../components/Layout.tsx"), "utf8");
const helpChat = readFileSync(resolve(here, "../../../../../supabase/functions/help-chat/index.ts"), "utf8");
const guide = helpChat.slice(helpChat.indexOf("const GUIDE = `"), helpChat.indexOf("`;", helpChat.indexOf("const GUIDE = `")));

/** Pantallas internas del equipo de Patagonia OS, que los clientes no ven. */
const INTERNAL_ONLY = new Set(["Auditoría"]);

const navLabels = Array.from(layout.slice(layout.indexOf("const navGroups"), layout.indexOf("];", layout.indexOf("const navGroups"))).matchAll(/label: "([^"]+)"/g))
  .map((m) => m[1])
  .filter((label) => !INTERNAL_ONLY.has(label));

describe("guía del chat de ayuda", () => {
  it("encuentra el menú y la guía", () => {
    assert.ok(navLabels.length >= 10, "no se pudo leer el menú de Layout.tsx");
    assert.ok(guide.length > 1000, "no se pudo leer la guía de help-chat");
  });

  const menuLine = guide.split("\n").find((line) => line.startsWith("Las secciones del menú")) ?? "";
  for (const label of navLabels) {
    it(`nombra "${label}" en la lista del menú`, () => {
      assert.ok(menuLine.includes(label), `"${label}" está en el menú pero no en la línea "Las secciones del menú..." de la guía`);
    });
  }
});
