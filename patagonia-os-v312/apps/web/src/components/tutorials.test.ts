import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tutorialsFor, youtubeUrl } from "./tutorials";
import { navGroups } from "./nav";

describe("Videos tutoriales por pantalla", () => {
  it("Mostrador abre primero el video de cobrar", () => {
    assert.equal(tutorialsFor("sale")[0].title, "Cómo cobrar una venta");
  });

  it("un video todavía sin subir no aparece", () => {
    assert.deepEqual(tutorialsFor("creditors"), []);
    assert.ok(tutorialsFor("sale").every((t) => t.youtubeId !== ""));
  });

  it("una pantalla sin video no muestra nada", () => {
    assert.deepEqual(tutorialsFor("audit"), []);
  });

  it("el link abre el video dentro de la lista", () => {
    assert.equal(youtubeUrl(tutorialsFor("carcass")[0]), "https://www.youtube.com/watch?v=6_bGdMsVaVU&list=PLVvQnvV-cGWE");
  });

  it("las pantallas principales del menú tienen su video", () => {
    const conVideo = ["dashboard", "sale", "customers", "inventory", "purchases", "carcass", "treasury", "accounting", "employees", "branches", "reports"] as const;
    for (const page of conVideo) assert.ok(tutorialsFor(page).length > 0, page);
    const enMenu = new Set(navGroups.flatMap((g) => g.items.flatMap((i) => [i.page, ...(i.tabs ?? []).map((t) => t.page)])));
    for (const page of conVideo) assert.ok(enMenu.has(page), page);
  });
});
