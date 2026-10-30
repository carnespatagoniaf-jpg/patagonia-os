import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findByCode,
  labelCode,
  nextGarron,
  parseTrazaQuery,
  pickByGarron,
  searchMedias,
  slaughterRows,
  stockByCamara,
  sumKg,
  type FrigoDt,
  type FrigoMedia
} from "./frigo-logic";

function media(p: Partial<FrigoMedia> & Pick<FrigoMedia, "id" | "garron">): FrigoMedia {
  return { dtId: "d1", tropa: 101, slaughterDate: "2026-10-26", animal: 1, side: 1, kg: 100, camaraId: "c1", salidaId: null, ...p };
}

const dt: FrigoDt = {
  id: "d1", branchId: "b1", dtNumber: "DT-e 4471203", dtDate: "2026-10-25", producer: "Estancia La Demo", renspa: null,
  origin: null, category: "Novillo", heads: 10, tropa: 101, slaughterDate: "2026-10-26", status: "faenado", notes: null
};

test("10 animales son 20 medias, 2 por animal", () => {
  const rows = slaughterRows(10);
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.slice(0, 3), [{ animal: 1, side: 1 }, { animal: 1, side: 2 }, { animal: 2, side: 1 }]);
  assert.deepEqual(rows[19], { animal: 10, side: 2 });
});

test("el garrón arranca en 1 cada día de faena", () => {
  const medias = [media({ id: "a", garron: 1 }), media({ id: "b", garron: 36 }), media({ id: "c", garron: 4, slaughterDate: "2026-10-27" })];
  assert.equal(nextGarron(medias, "2026-10-26"), 37);
  assert.equal(nextGarron(medias, "2026-10-27"), 5);
  assert.equal(nextGarron(medias, "2026-10-28"), 1);
});

test("stock por cámara cuenta solo lo que no salió", () => {
  const medias = [media({ id: "a", garron: 1, kg: 90.5 }), media({ id: "b", garron: 2, kg: 91 }), media({ id: "c", garron: 3, salidaId: "s1" })];
  const [c1] = stockByCamara([{ id: "c1", number: 1, name: "Cámara 1", capacity: 80, active: true }], medias);
  assert.equal(c1.count, 2);
  assert.equal(c1.kg, 181.5);
  assert.equal(sumKg([{ kg: 0.1 }, { kg: 0.2 }]), 0.3);
});

test("escanear un garrón toma la media más vieja que sigue en cámara", () => {
  const medias = [
    media({ id: "nueva", garron: 14, slaughterDate: "2026-10-27" }),
    media({ id: "vieja", garron: 14, slaughterDate: "2026-10-26" }),
    media({ id: "vendida", garron: 14, slaughterDate: "2026-10-20", salidaId: "s1" })
  ];
  assert.equal(pickByGarron(medias, 14, [])?.id, "vieja");
  assert.equal(pickByGarron(medias, 14, ["vieja"])?.id, "nueva");
  assert.equal(pickByGarron(medias, 14, ["vieja", "nueva"]), null);
});

test("el código de la etiqueta identifica una sola media", () => {
  const m = media({ id: "x", garron: 14, tropa: 101 });
  assert.equal(labelCode(m), "2026102601010014");
  const other = media({ id: "y", garron: 14, tropa: 101, slaughterDate: "2026-10-27" });
  assert.equal(findByCode([other, m], "2026102601010014", [])?.id, "x");
  assert.equal(findByCode([other, m], "14", [])?.id, "x");
  assert.equal(findByCode([m], "abc", []), null);
});

test("búsqueda de trazabilidad por tropa, garrón y productor", () => {
  assert.deepEqual(parseTrazaQuery("T101"), { kind: "tropa", n: 101 });
  assert.deepEqual(parseTrazaQuery("garrón 14"), { kind: "garron", n: 14 });
  assert.deepEqual(parseTrazaQuery(" 7 "), { kind: "number", n: 7 });
  assert.deepEqual(parseTrazaQuery(""), { kind: "empty" });
  const medias = [media({ id: "a", garron: 2 }), media({ id: "b", garron: 1, tropa: 102 })];
  assert.deepEqual(searchMedias(medias, [dt], "t101").map((m) => m.id), ["a"]);
  assert.deepEqual(searchMedias(medias, [dt], "estancia").map((m) => m.id), ["b", "a"]);
});
