import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonFileJournalStorage, MemoryJournalStorage, StoredJobJournal } from "./job-journal";
import { writeFileAtomic } from "../storage/atomic-file";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "scale-connect-journal-"));
}

test("cada paso confirmado queda en disco al instante", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "journal", "jobs.json");
  const j = new StoredJobJournal(new JsonFileJournalStorage(file));
  await j.open();
  await j.begin({ id: "t1", deviceId: "b1", kind: "envío", meta: { productos: 3 } });
  await j.confirmStep("t1", "plu-1", { verificado: true });
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.format, "patagonia-scale-connect/jobs");
  assert.equal(onDisk.records[0].status, "running");
  assert.deepEqual(onDisk.records[0].steps.map((s: { key: string }) => s.key), ["plu-1"]);
  await j.close();
});

test("al reiniciar, lo que estaba en curso queda interrumpido para reanudar (nunca se reenvía)", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "jobs.json");
  const first = new StoredJobJournal(new JsonFileJournalStorage(file));
  await first.open();
  await first.begin({ id: "a", deviceId: "b1", kind: "envío" });
  await first.confirmStep("a", "plu-1");
  await first.confirmStep("a", "plu-2");
  await first.begin({ id: "b", deviceId: "b2", kind: "prueba" });
  await first.finish("b", "done");
  // Se corta la luz: no hay close().

  const second = new StoredJobJournal(new JsonFileJournalStorage(file));
  const report = await second.open();
  assert.deepEqual(report.interrupted.map((r) => r.id), ["a"]);
  const a = second.get("a")!;
  assert.equal(a.status, "interrupted");
  assert.equal(a.resumable, true);
  assert.equal(a.error?.code, "restart");
  assert.deepEqual(a.steps.map((s) => s.key), ["plu-1", "plu-2"], "se conserva lo confirmado para saber qué falta");
  assert.equal(second.get("b")!.status, "done");
  // Y el cambio de estado quedó escrito.
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.records.find((r: { id: string }) => r.id === "a").status, "interrupted");
  // Un segundo reinicio no lo vuelve a informar como nuevo.
  const third = new StoredJobJournal(new JsonFileJournalStorage(file));
  assert.equal((await third.open()).interrupted.length, 0);
});

test("diario dañado: se aparta para soporte y se arranca vacío", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "jobs.json");
  await writeFile(file, '{"records": [ {"id": "a", ', "utf8");
  const j = new StoredJobJournal(new JsonFileJournalStorage(file));
  const report = await j.open();
  assert.ok(report.corruptMovedTo?.includes("jobs.json.corrupt-"));
  assert.equal(j.list().length, 0);
  const names = await readdir(dir);
  assert.ok(names.some((n) => n.startsWith("jobs.json.corrupt-")));
  assert.ok(names.includes("jobs.json"));
});

test("escritura atómica: no deja temporales y un temporal viejo se limpia al abrir", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "jobs.json");
  await writeFile(`${file}.999.1.tmp`, "a medio escribir", "utf8");
  const j = new StoredJobJournal(new JsonFileJournalStorage(file));
  const report = await j.open();
  assert.equal(report.tempFilesRemoved, 1);
  await j.begin({ id: "x", deviceId: "b", kind: "k" });
  for (let i = 0; i < 20; i += 1) await j.confirmStep("x", `p${i}`);
  const names = await readdir(dir);
  assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), []);
});

test("writeFileAtomic reemplaza el contenido completo", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "a.json");
  await writeFileAtomic(file, "uno");
  await writeFileAtomic(file, "dos");
  assert.equal(await readFile(file, "utf8"), "dos");
});

test("escrituras simultáneas quedan en orden (la última gana)", async () => {
  const storage = new MemoryJournalStorage();
  const j = new StoredJobJournal(storage);
  await j.open();
  await j.begin({ id: "x", deviceId: "b", kind: "k" });
  await Promise.all([j.confirmStep("x", "1"), j.confirmStep("x", "2"), j.confirmStep("x", "3")]);
  assert.deepEqual(storage.records[0].steps.map((s) => s.key), ["1", "2", "3"]);
});

test("un paso que no se pudo guardar no cuenta como confirmado", async () => {
  const storage = new MemoryJournalStorage();
  const j = new StoredJobJournal(storage);
  await j.open();
  await j.begin({ id: "x", deviceId: "b", kind: "k" });
  storage.failNextSave = new Error("disco lleno");
  await assert.rejects(j.confirmStep("x", "1"), /disco lleno/);
  assert.deepEqual(j.get("x")?.steps, []);
});

test("se conservan los últimos N terminados, nunca los interrumpidos", async () => {
  const storage = new MemoryJournalStorage();
  const j = new StoredJobJournal(storage, { keepFinished: 2 });
  await j.open();
  await j.begin({ id: "int", deviceId: "b", kind: "k" });
  await j.finish("int", "interrupted", { code: "disconnected", message: "x" });
  for (const id of ["a", "b", "c"]) {
    await j.begin({ id, deviceId: "b", kind: "k" });
    await j.finish(id, "done");
  }
  assert.deepEqual(j.list().map((r) => r.id).sort(), ["b", "c", "int"]);
  assert.equal(j.get("int")?.resumable, true);
});

test("errores de uso: duplicado, inexistente, ya terminado", async () => {
  const j = new StoredJobJournal(new MemoryJournalStorage());
  await assert.rejects(j.begin({ id: "x", deviceId: "b", kind: "k" }), /no está abierto/);
  await j.open();
  await j.begin({ id: "x", deviceId: "b", kind: "k" });
  await assert.rejects(j.begin({ id: "x", deviceId: "b", kind: "k" }), /Ya existe/);
  await assert.rejects(j.confirmStep("nada", "p"), /No existe/);
  await j.finish("x", "failed", { code: "timeout", message: "t" });
  await assert.rejects(j.confirmStep("x", "p"), /ya no está en curso/);
});
