import assert from "node:assert/strict";
import { test } from "node:test";
import { animalTypeLabel, buildTypeChips, carcassTypeKey, findSameType, initialType } from "./carcass-types";

test("los nombres de la media res, el cerdo y el pollo dan la misma clave", () => {
  for (const name of ["Vaca / media res", "MEDIA RES", "media res", "Media Res Vaca"]) assert.equal(carcassTypeKey(name), "mediares");
  assert.equal(carcassTypeKey("Cajón de pollo"), "pollo");
  assert.equal(carcassTypeKey("POLLOS"), "pollo");
  assert.equal(carcassTypeKey("Medio cerdo"), "cerdo");
  assert.equal(carcassTypeKey("Capón"), "capon");
  assert.equal(carcassTypeKey("  "), "");
});

test("la media res se muestra como Media res; el resto como lo escribió el negocio", () => {
  assert.equal(animalTypeLabel("Vaca / media res"), "Media res");
  assert.equal(animalTypeLabel("ALPINA"), "ALPINA");
});

test("avisa si ya existe uno igual", () => {
  const types = ["Vaca / media res", "Cerdo", "Pollo", "Capón"];
  assert.equal(findSameType("MEDIA RES", types), "Vaca / media res");
  assert.equal(findSameType("capon", types), "Capón");
  assert.equal(findSameType("Cordero", types), undefined);
});

test("botones: los de siempre, sin repetidos, el más usado primero", () => {
  const chips = buildTypeChips(["Pollo", "Pollo", "Pollo", "Vaca / media res", "MEDIA RES"], ["ALPINA"]);
  assert.deepEqual(chips.all, ["Pollo", "Vaca / media res", "Cerdo", "ALPINA"]);
  assert.deepEqual(chips.more, []);
});

test("si el negocio usa otro nombre para uno de los de siempre, se ve el suyo", () => {
  const chips = buildTypeChips(["MEDIA RES"], []);
  assert.equal(chips.all[0], "MEDIA RES");
  assert.equal(chips.all.length, 3);
});

test("más de 5 van a Más", () => {
  const chips = buildTypeChips(["Capón", "Cordero", "Chivito", "Lechón"], []);
  assert.equal(chips.visible.length, 5);
  assert.deepEqual(chips.visible, ["Capón", "Cordero", "Chivito", "Lechón", "Vaca / media res"]);
  assert.deepEqual(chips.more, ["Cerdo", "Pollo"]);
});

test("abre en el de la última res", () => {
  const chips = buildTypeChips(["Pollo"], []);
  assert.equal(initialType(chips, "pollos"), "Pollo");
  assert.equal(initialType(buildTypeChips([], []), undefined), "Vaca / media res");
});
