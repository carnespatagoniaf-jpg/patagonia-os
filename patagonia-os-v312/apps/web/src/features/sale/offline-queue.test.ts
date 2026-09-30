import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthError, isNetworkError, isRetryableError } from "./offline-queue";

test("falla de red (sin code) se reintenta", () => {
  const err = { message: "TypeError: Failed to fetch", code: "" };
  assert.equal(isNetworkError(err), true);
  assert.equal(isRetryableError(err), true);
});

test("sesión vencida (401 anon, caso real 2026-09-30) se reintenta, no queda como error", () => {
  const err = { code: "42501", message: "permission denied for function create_pos_sale" };
  assert.equal(isNetworkError(err), false);
  assert.equal(isAuthError(err), true);
  assert.equal(isRetryableError(err), true);
  assert.equal(isRetryableError({ code: "PGRST301", message: "JWT expired" }), true);
  assert.equal(isRetryableError({ code: "P0001", message: "Usuario no autenticado" }), true);
});

test("rechazo real del servidor no se reintenta solo", () => {
  assert.equal(isRetryableError({ code: "P0001", message: "No hay un turno de mostrador abierto" }), false);
  assert.equal(isRetryableError({ code: "P0001", message: "Los medios de pago no suman el total de la venta" }), false);
});
