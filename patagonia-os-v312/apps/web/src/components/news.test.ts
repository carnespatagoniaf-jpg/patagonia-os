import { test } from "node:test";
import assert from "node:assert/strict";
import { NEWS, visibleNews, type NewsItem } from "./news";

const item: NewsItem = { id: "a", title: "t", body: "b", requires: ["purchases.manage", "carcass.manage"], until: "2026-11-15" };
const all = () => true;

test("se ve con los permisos, antes de la fecha y sin descartar", () => {
  assert.deepEqual(visibleNews([item], all, [], "2026-10-15").map((n) => n.id), ["a"]);
  assert.equal(visibleNews([item], all, [], "2026-11-15").length, 1);
});

test("no se ve vencida, descartada o sin algún permiso", () => {
  assert.equal(visibleNews([item], all, [], "2026-11-16").length, 0);
  assert.equal(visibleNews([item], all, ["a"], "2026-10-15").length, 0);
  assert.equal(visibleNews([item], (p) => p !== "carcass.manage", [], "2026-10-15").length, 0);
});

test("los ids de NEWS no se repiten", () => {
  assert.equal(new Set(NEWS.map((n) => n.id)).size, NEWS.length);
});
