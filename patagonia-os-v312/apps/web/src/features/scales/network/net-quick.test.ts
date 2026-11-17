import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quickSearch, type QuickDeps } from "./net-quick";

/** El programa de la PC simulado: versión, permiso de Chrome y lo que encuentra en la red. */
function deps(over: { version?: number | null; permission?: PermissionState | null; found?: unknown; findFails?: boolean } = {}) {
  const calls: number[][] = [];
  const d: QuickDeps = {
    agentVersion: async () => (over.version === undefined ? 6 : over.version),
    permission: async () => over.permission ?? "granted",
    find: async (ports) => {
      calls.push(ports);
      if (over.findFails) throw new Error("se cerró el programa");
      return over.found ?? { ok: true, scales: [], local: [], wired: [] };
    }
  };
  return { d, calls };
}

describe("búsqueda del camino corto", () => {
  it("sin programa: no busca, pide instalar", async () => {
    const { d, calls } = deps({ version: null });
    const s = await quickSearch(d);
    assert.equal(s.kind, "programa");
    if (s.kind === "programa") assert.equal(s.status, "sin_programa");
    assert.equal(calls.length, 0);
  });

  it("programa viejo (versión 5): pide actualizar antes de buscar", async () => {
    const { d, calls } = deps({ version: 5 });
    const s = await quickSearch(d);
    assert.equal(s.kind === "programa" && s.status, "viejo");
    assert.equal(calls.length, 0);
  });

  it("Chrome bloqueó la red local: lo dice", async () => {
    const s = await quickSearch(deps({ version: null, permission: "denied" }).d);
    assert.equal(s.kind === "programa" && s.status, "bloqueado");
  });

  it("busca Kretz (1001) y Systel (10001) a la vez", async () => {
    const { d, calls } = deps();
    await quickSearch(d);
    assert.deepEqual(calls, [[1001, 10001]]);
  });

  it("UNA balanza: queda lista para conectarse sola", async () => {
    const s = await quickSearch(deps({ found: { scales: [{ ip: "192.168.19.170", port: 1001 }] } }).d);
    assert.equal(s.kind, "buscado");
    if (s.kind === "buscado") assert.deepEqual(s.quick, { kind: "una", scale: { ip: "192.168.19.170", port: 1001 } });
  });

  it("varias: para elegir", async () => {
    const s = await quickSearch(deps({ found: { scales: [{ ip: "10.0.0.5", port: 1001 }, { ip: "10.0.0.6", port: 10001 }] } }).d);
    assert.equal(s.kind === "buscado" && s.quick.kind, "varias");
  });

  it("ninguna: pasos", async () => {
    const s = await quickSearch(deps().d);
    assert.equal(s.kind === "buscado" && s.quick.kind, "ninguna");
  });

  it("el programa se cierra en medio de la búsqueda: no se rompe", async () => {
    const s = await quickSearch(deps({ findFails: true }).d);
    assert.equal(s.kind, "error");
  });
});
