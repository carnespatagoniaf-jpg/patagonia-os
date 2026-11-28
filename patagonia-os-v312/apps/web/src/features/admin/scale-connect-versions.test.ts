import { test } from "node:test";
import assert from "node:assert/strict";
import {
  channelMessage,
  mapInstalled,
  mapRelease,
  compareVersions,
  mergeVersionStats,
  nextRolloutSteps,
  parseRolloutPercent,
  promoteBlocker,
  promoteReleaseMessage,
  releaseStateText,
  rolloutMessage,
  stopReleaseMessage,
  type ScaleConnectRelease
} from "./scale-connect-versions";


const rel = (over: Partial<ScaleConnectRelease>): ScaleConnectRelease => ({
  id: "r", version: "0.3.0", channel: "pilot", rolloutPercent: 10, active: true, publishedAt: "2026-11-27T12:00:00Z",
  updatedAt: null, minVersion: "0.1.0", installed: 0, rolledBack: 0, ...over
});

test("compareVersions ordena por número, no por texto", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("1.2.3-beta", "1.2.3"), 0);
  assert.ok(compareVersions("0.2.1", "0.3.0") < 0);
});

test("mergeVersionStats: conteos por versión de la 231, más nueva primero, estable antes que piloto", () => {
  const releases = [
    rel({ id: "a", version: "0.2.1", channel: "stable", rolloutPercent: 100, installed: 9, rolledBack: 0 }),
    rel({ id: "b", version: "0.3.0", channel: "pilot", installed: 1, rolledBack: 0 }),
    rel({ id: "c", version: "0.3.0", channel: "stable", rolloutPercent: 0, installed: 1 })
  ];
  const installed = [
    { version: "0.3.0", installed: 2, online: 1, failed: 1, rolledBack: 1 },
    { version: "0.2.1", installed: 7, online: 5, failed: 0, rolledBack: 0 },
    { version: "0.1.4", installed: 3, online: 0, failed: 0, rolledBack: 0 },
    { version: "0.4.0", installed: 0, online: 0, failed: 2, rolledBack: 0 }
  ];
  const s = mergeVersionStats(releases, installed);
  assert.deepEqual(s.releases.map((r) => r.id), ["c", "b", "a"]);
  const pilot = s.releases.find((r) => r.id === "b")!;
  assert.equal(pilot.installed, 2);
  assert.equal(pilot.online, 1);
  assert.equal(pilot.failed, 1);
  assert.equal(pilot.rolledBack, 1);
  assert.equal(pilot.hasStable, true);
  assert.equal(s.releases.find((r) => r.id === "a")!.installed, 7);
  // La 0.1.4 está instalada y no publicada; la 0.4.0 solo tiene fallas (0 PC), no aparece como instalada.
  assert.deepEqual(s.unpublished.map((u) => u.version), ["0.1.4"]);
  assert.equal(s.totalPcs, 12);
  assert.equal(s.detailed, true);
});

test("mergeVersionStats sin la 231: usa los conteos de la 229 y no cuenta dos veces la misma versión", () => {
  const s = mergeVersionStats([
    rel({ id: "b", version: "0.3.0", channel: "pilot", installed: 4, rolledBack: 1 }),
    rel({ id: "c", version: "0.3.0", channel: "stable", installed: 4 }),
    rel({ id: "a", version: "0.2.1", channel: "stable", installed: 6 })
  ], null);
  assert.equal(s.detailed, false);
  assert.equal(s.totalPcs, 10);
  assert.equal(s.releases.find((r) => r.id === "b")!.rolledBack, 1);
  assert.equal(s.releases.find((r) => r.id === "b")!.failed, 0);
  assert.deepEqual(s.unpublished, []);
});

test("Subir porcentaje: escalones 10 → 50 → 100 y número escrito", () => {
  assert.deepEqual(nextRolloutSteps(0), [10, 50, 100]);
  assert.deepEqual(nextRolloutSteps(10), [50, 100]);
  assert.deepEqual(nextRolloutSteps(60), [100]);
  assert.deepEqual(nextRolloutSteps(100), []);
  assert.equal(parseRolloutPercent("25"), 25);
  assert.equal(parseRolloutPercent(" 50 %"), 50);
  assert.equal(parseRolloutPercent("0"), 0);
  assert.equal(parseRolloutPercent("101"), null);
  assert.equal(parseRolloutPercent("12,5"), null);
  assert.equal(parseRolloutPercent(""), null);
  assert.equal(parseRolloutPercent("-5"), null);
});

test("textos de las confirmaciones", () => {
  const r = { ...rel({ version: "0.3.0", channel: "pilot", installed: 3 }), online: 0, failed: 0, hasStable: false };
  const stop = stopReleaseMessage(r);
  assert.match(stop, /v0\.3\.0 \(piloto\) deja de ofrecerse al instante/);
  assert.match(stop, /Las PC que ya la tienen \(3 PC\) se quedan con esa versión/);
  assert.match(stop, /Las demás dejan de recibirla/);
  assert.match(stopReleaseMessage({ ...r, installed: 1 }), /\(1 PC\)/);
  assert.match(rolloutMessage(r, 50), /pasa de 10 % a 50 % de los clientes en piloto/);
  assert.match(rolloutMessage({ ...r, channel: "stable" }, 100), /al 100 % de todas las PC/);
  assert.match(rolloutMessage(r, 5), /baja de 10 % a 5 %/);
  assert.match(promoteReleaseMessage(r), /canal estable .* al 0 %/);
  assert.match(channelMessage("La Vaquita", "pilot"), /^La Vaquita pasa a piloto/);
  assert.match(channelMessage("La Vaquita", "stable"), /dejan de recibir versiones piloto/);
  assert.equal(releaseStateText({ active: false, rolloutPercent: 50 }), "Frenada");
  assert.equal(releaseStateText({ active: true, rolloutPercent: 0 }), "Activa, a nadie todavía");
  assert.equal(releaseStateText({ active: true, rolloutPercent: 50 }), "Activa al 50 %");
});

test("promoteBlocker: solo una piloto activa, sin estable y firmada para general", () => {
  const ok = { channel: "pilot" as const, hasStable: false, active: true };
  assert.equal(promoteBlocker(ok), null);
  assert.equal(promoteBlocker(ok, "general"), null);
  assert.match(promoteBlocker(ok, "piloto")!, /firmado solo para piloto/);
  assert.match(promoteBlocker({ ...ok, hasStable: true })!, /ya está publicada en estable/);
  assert.match(promoteBlocker({ ...ok, active: false })!, /frenada/);
  assert.match(promoteBlocker({ ...ok, channel: "stable" })!, /Ya es estable/);
});

test("mapeo de lo que devuelve la base", () => {
  const r = mapRelease({ id: "x", version: "0.3.0", channel: "stable", rollout_percent: 50, active: true, published_at: "2026-11-27", installed: "3", rolled_back: 1, min_version: "0.1.0" });
  assert.equal(r.channel, "stable");
  assert.equal(r.rolloutPercent, 50);
  assert.equal(r.installed, 3);
  assert.equal(r.rolledBack, 1);
  assert.equal(mapRelease({ channel: "otro" }).channel, "pilot");
  assert.deepEqual(mapInstalled({ version: "0.3.0", installed: 2, online: 1, failed: 0, rolled_back: 1 }), { version: "0.3.0", installed: 2, online: 1, failed: 0, rolledBack: 1 });
});
