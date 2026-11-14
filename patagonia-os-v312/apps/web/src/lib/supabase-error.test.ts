import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNetworkError } from "../features/sale/offline-queue";
import { toError } from "./supabase-error";

describe("toError", () => {
  it("convierte el error plano de un RPC en Error con el mensaje del servidor", () => {
    const err = toError({ message: "PIN incorrecto", code: "P0001", details: null, hint: null });
    assert.ok(err instanceof Error);
    assert.equal(err.message, "PIN incorrecto");
    assert.equal((err as Error & { code?: string }).code, "P0001");
    assert.equal(isNetworkError(err), false);
  });

  it("una falla de red sigue siendo falla de red", () => {
    const err = toError({ message: "TypeError: Failed to fetch", code: "", details: "", hint: "" });
    assert.equal(isNetworkError(err), true);
  });

  it("deja pasar un Error tal cual y no inventa mensajes vacíos", () => {
    const original = new Error("x");
    assert.equal(toError(original), original);
    assert.equal(toError({ message: "" }).message, "Error del servidor");
    assert.equal(toError(null).message, "Error del servidor");
  });
});
