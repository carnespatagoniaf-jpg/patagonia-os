import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readSignatureInfo, removeSignature } from "./pe-unsign.mjs";

// PE32+ mínimo: DOS (0x40) + "PE\0\0" en 0x80 + COFF (20) + opcional (112 + 16 directorios × 8)
// + cuerpo, y al final una "tabla de certificados" de 24 bytes.
function fakePe({ signed = true, padding = 0 } = {}) {
  const pe = 0x80;
  const optional = pe + 24;
  const dirs = optional + 112;
  const headerEnd = dirs + 16 * 8;
  const body = 64;
  const certOffset = headerEnd + body;
  const certSize = 24;
  const buffer = Buffer.alloc(certOffset + (signed ? certSize + padding : 0), 0xaa);
  buffer.fill(0, 0, headerEnd);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(pe, 0x3c);
  buffer.writeUInt32LE(0x00004550, pe);
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(0x1234, optional + 64); // CheckSum
  buffer.writeUInt32LE(16, dirs - 4); // NumberOfRvaAndSizes
  if (signed) {
    buffer.writeUInt32LE(certOffset, dirs + 4 * 8);
    buffer.writeUInt32LE(certSize, dirs + 4 * 8 + 4);
  }
  return { buffer, certOffset, dirs, optional };
}

test("quita la tabla de certificados y la entrada del directorio", () => {
  const { buffer, certOffset, dirs, optional } = fakePe();
  assert.deepEqual(readSignatureInfo(buffer), { signed: true, offset: certOffset, size: 24 });
  const { buffer: out, removed } = removeSignature(buffer);
  assert.equal(removed, true);
  assert.equal(out.length, certOffset);
  assert.equal(out.readUInt32LE(dirs + 32), 0);
  assert.equal(out.readUInt32LE(dirs + 36), 0);
  assert.equal(out.readUInt32LE(optional + 64), 0);
  assert.equal(readSignatureInfo(out).signed, false);
  // El original no se modifica.
  assert.equal(readSignatureInfo(buffer).signed, true);
});

test("acepta el relleno de alineación al final", () => {
  const { buffer, certOffset } = fakePe({ padding: 4 });
  assert.equal(removeSignature(buffer).buffer.length, certOffset);
});

test("un ejecutable sin firma queda igual", () => {
  const { buffer } = fakePe({ signed: false });
  const result = removeSignature(buffer);
  assert.equal(result.removed, false);
  assert.equal(result.buffer, buffer);
});

test("se niega si la firma no está al final", () => {
  const { buffer } = fakePe({ padding: 64 });
  assert.throws(() => removeSignature(buffer), /no está al final/);
});

test("rechaza lo que no es un ejecutable", () => {
  assert.throws(() => removeSignature(Buffer.from("hola mundo, esto no es un exe, son bytes cualquiera de relleno para el test 0123456789")), /MZ/);
});

test("node.exe real: lee su firma (solo en Windows)", { skip: process.platform !== "win32" }, () => {
  const exe = readFileSync(process.execPath);
  const info = readSignatureInfo(exe);
  if (!info.signed) return; // un Node compilado a mano no trae firma
  const { buffer, removed } = removeSignature(exe);
  assert.equal(removed, true);
  assert.equal(buffer.length, info.offset);
  assert.equal(readSignatureInfo(buffer).signed, false);
});
