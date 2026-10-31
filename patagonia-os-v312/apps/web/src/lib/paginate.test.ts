import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchAllPages } from "./paginate";

describe("fetchAllPages (Supabase corta en 1000 filas)", () => {
  it("junta todas las páginas: 2.345 filas en 3 pedidos", async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => i);
    const asked: Array<[number, number]> = [];
    const r = await fetchAllPages<number>(async (from, to) => {
      asked.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    });
    assert.equal(r.data.length, 2345);
    assert.deepEqual(asked, [[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it("si una página falla devuelve el error", async () => {
    const r = await fetchAllPages<number>(async () => ({ data: null, error: { message: "boom" } }));
    assert.equal(r.error?.message, "boom");
  });
});
