import assert from "node:assert/strict";
import { test } from "node:test";
import { pickLikelyThermal, type AgentPrinter } from "./printer-agent";

function printer(name: string, extra: Partial<AgentPrinter> = {}): AgentPrinter {
  return { name, isDefault: false, port: "USB001", driver: name, driverMajor: 3, isPhysical: true, ...extra };
}

test("elige sola la térmica cuando hay una láser de oficina al lado", () => {
  const list = [printer("Xerox Phaser 3020", { isDefault: true, port: "USB002" }), printer("POS Printer 203DPI  Series")];
  assert.equal(pickLikelyThermal(list)?.name, "POS Printer 203DPI  Series");
});

test("con una sola impresora física elige esa aunque el nombre no diga térmica, y reconoce Unnion", () => {
  const list = [printer("Brother Color Leg Type1 Class Driver", { driverMajor: 4 }), printer("Microsoft Print to PDF", { isPhysical: false })];
  // una sola impresora física y ningún nombre de térmica: es esa
  assert.equal(pickLikelyThermal(list)?.name, "Brother Color Leg Type1 Class Driver");
  assert.equal(pickLikelyThermal([printer("Unnion TP95W")])?.name, "Unnion TP95W");
});

test("ignora PDF, fax y demás impresoras virtuales", () => {
  const list = [
    printer("Microsoft Print to PDF", { isPhysical: false }),
    printer("Fax", { isPhysical: false }),
    printer("Enviar a OneNote 16", { isPhysical: false })
  ];
  assert.equal(pickLikelyThermal(list), null);
});

test("si no se puede saber cuál es, devuelve null para preguntarle al usuario", () => {
  const two = [printer("Xerox Phaser 3020", { port: "USB002" }), printer("HP Deskjet 3050", { port: "USB003" })];
  assert.equal(pickLikelyThermal(two), null);
  const twoThermal = [printer("POS-80 caja 1"), printer("POS-80 caja 2", { port: "USB002" })];
  assert.equal(pickLikelyThermal(twoThermal), null);
});
