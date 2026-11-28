import test from "node:test";
import assert from "node:assert/strict";
import { shutdownExitCode } from "./exit-code";

test("apagado pedido por Windows (Ctrl+C de WinSW): 0 si se apagó bien", () => {
  assert.equal(shutdownExitCode("SIGINT", true), 0);
  assert.equal(shutdownExitCode("SIGINT", false), 1);
});

test("una falla inesperada sale con error aunque el apagado haya andado (así Windows lo reinicia)", () => {
  assert.equal(shutdownExitCode("uncaughtException", true), 1);
  assert.equal(shutdownExitCode("uncaughtException", false), 1);
});
