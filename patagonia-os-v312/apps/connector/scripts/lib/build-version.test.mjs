import test from "node:test";
import assert from "node:assert/strict";
import { buildVersion } from "./build-version.mjs";

test("buildVersion: sin variable, la de package.json", () => {
  assert.equal(buildVersion("0.2.1", {}), "0.2.1");
  assert.equal(buildVersion("0.2.1", { SCALE_CONNECT_VERSION: "  " }), "0.2.1");
});

test("buildVersion: SCALE_CONNECT_VERSION manda (pruebas de actualización)", () => {
  assert.equal(buildVersion("0.2.1", { SCALE_CONNECT_VERSION: "9.0.2" }), "9.0.2");
});

test("buildVersion: una versión que no es X.Y.Z frena el build", () => {
  for (const bad of ["9.0", "9.0.1-beta", "v9.0.1", "9.0.1; rm"]) {
    assert.throws(() => buildVersion("0.2.1", { SCALE_CONNECT_VERSION: bad }), /no es una versión/);
  }
});
