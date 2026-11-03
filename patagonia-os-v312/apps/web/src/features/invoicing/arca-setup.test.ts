import { test } from "node:test";
import assert from "node:assert/strict";
import { arcaStepDone, currentArcaStep, type ArcaSetupState } from "./arca-setup";

const base: ArcaSetupState = { hasSettings: false, enabled: false, usesShared: false, hasRequest: false, hasCertificate: false, ackArcaCert: false, ackPermission: false };

test("arranca por los datos", () => {
  assert.equal(currentArcaStep(base), "datos");
});

test("con datos y pedido bajado sigue en ARCA", () => {
  assert.equal(currentArcaStep({ ...base, hasSettings: true, hasRequest: true }), "arca_cert");
});

test("'ya tengo el .crt' pasa a subirlo; subido salta al permiso", () => {
  const s = { ...base, hasSettings: true, hasRequest: true, ackArcaCert: true };
  assert.equal(currentArcaStep(s), "subir");
  assert.equal(currentArcaStep({ ...s, hasCertificate: true }), "permiso");
  // Si ya subió el certificado, el paso de ARCA cuenta como hecho aunque no lo haya marcado.
  assert.equal(arcaStepDone("arca_cert", { ...base, hasCertificate: true }), true);
});

test("con el permiso marcado falta probar; conectado está todo hecho", () => {
  assert.equal(currentArcaStep({ ...base, hasSettings: true, hasCertificate: true, ackPermission: true }), "probar");
  assert.equal(arcaStepDone("probar", { ...base, enabled: true }), true);
});

test("certificado compartido de Patagonia OS: no pide pedido ni certificado", () => {
  assert.equal(currentArcaStep({ ...base, hasSettings: true, usesShared: true }), "permiso");
});
