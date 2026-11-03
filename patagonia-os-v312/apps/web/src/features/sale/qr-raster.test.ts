import { test } from "node:test";
import assert from "node:assert/strict";
import qrcode from "qrcode-generator";
import { qrRaster, qrRasterCommand } from "./qr-raster";

// Una URL de ARCA de verdad (RG 4892): base64 de un JSON de ~250 caracteres.
const URL =
  "https://www.afip.gob.ar/fe/qr/?p=eyJ2ZXIiOjEsImZlY2hhIjoiMjAyNi0xMS0wMyIsImN1aXQiOjI3Mjk1Nzk1NDU1LCJwdG9WdGEiOjEsInRpcG9DbXAiOjYsIm5yb0NtcCI6Mzg3NjUsImltcG9ydGUiOjY1ODU0LCJtb25lZGEiOiJQRVMiLCJjdHoiOjEsInRpcG9Eb2NSZWMiOjk2LCJucm9Eb2NSZWMiOjQ4Mzc3MDc1LCJ0aXBvQ29kQXV0IjoiRSIsImNvZEF1dCI6ODY0NDA3NzEwMDU4MjJ9";

test("el QR de ARCA entra en papel de 58 mm y cada cuadradito se lee", () => {
  const img = qrRaster(URL);
  assert.ok(img.bytesPerRow * 8 <= 384, `ancho ${img.bytesPerRow * 8} puntos`);
  assert.ok(img.scale >= 3 && img.scale <= 5);
  assert.equal(img.height, (img.modules + 4) * img.scale);
});

test("la imagen es el mismo QR (cada cuadradito, en su lugar)", () => {
  const img = qrRaster(URL);
  const ref = qrcode(0, "M");
  ref.addData(URL);
  ref.make();
  const dot = (x: number, y: number) => (img.bits[y * img.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  for (let r = 0; r < img.modules; r++) {
    for (let c = 0; c < img.modules; c++) {
      const x = (c + 2) * img.scale + 1;
      const y = (r + 2) * img.scale + 1;
      assert.equal(dot(x, y), ref.isDark(r, c), `cuadradito ${r},${c}`);
    }
  }
  assert.equal(dot(0, 0), false, "el margen es blanco");
});

test("el comando es GS v 0 con el tamaño de la imagen, y la URL NO va como texto", () => {
  const cmd = qrRasterCommand(URL);
  const img = qrRaster(URL);
  assert.deepEqual(cmd.slice(0, 4), [0x1d, 0x76, 0x30, 0]);
  assert.equal(cmd[4] + cmd[5] * 256, img.bytesPerRow);
  assert.equal(cmd[6] + cmd[7] * 256, img.height);
  assert.equal(cmd.length, 8 + img.bytesPerRow * img.height);
  const text = String.fromCharCode(...cmd.filter((b) => b >= 32 && b < 127));
  assert.ok(!text.includes("afip.gob.ar"));
});
