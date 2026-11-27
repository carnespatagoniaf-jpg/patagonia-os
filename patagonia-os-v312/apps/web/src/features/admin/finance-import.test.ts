import { test } from "node:test";
import assert from "node:assert/strict";
import { markDuplicates, monthsOf, parseDate, parseExpenseFile, parseMoney } from "./finance-import";

test("montos y fechas como vienen de Argentina", () => {
  assert.equal(parseMoney("2136.22"), 2136.22);
  assert.equal(parseMoney("$ 2.136,22"), 2136.22);
  assert.equal(parseMoney("-19.500,00"), 19500);
  assert.equal(parseMoney("39.000"), 39000);
  assert.equal(parseDate("2026-11-06"), "2026-11-06");
  assert.equal(parseDate("6/11/2026"), "2026-11-06");
  assert.equal(parseDate("31/02/2026"), null);
  assert.equal(parseDate("ayer"), null);
});

test("lee el archivo con encabezado en cualquier orden y avisa lo que no entiende", () => {
  const csv = "﻿fecha;categoría;detalle;monto\n2026-11-06;Publicidad;Facebk *59d2rc2ww4;5071.30\n06/11/2026;Impuestos publicidad;Facebk · IVA;$ 3.778,24\nmañana;Varios;x;10\n2026-11-07;;Librería;-10.800,00\n";
  const r = parseExpenseFile(csv);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[1], { line: 2, date: "2026-11-06", category: "Impuestos publicidad", description: "Facebk · IVA", amount: 3778.24 });
  assert.equal(r.rows[2].category, "Varios");
  assert.equal(r.rows[2].amount, 10800);
  assert.match(r.errors[0], /Renglón 3: la fecha "mañana"/);
  assert.deepEqual(parseExpenseFile("detalle,monto\nx,10").errors, ["El encabezado tiene que tener al menos las columnas fecha y monto."]);
});

test("no repite lo ya cargado, pero sí cargos iguales que faltan", () => {
  const rows = [
    { line: 1, date: "2026-11-06", category: "Impuestos", description: "IIBB", amount: 482.98 },
    { line: 2, date: "2026-11-06", category: "Impuestos", description: "IIBB", amount: 482.98 },
    { line: 3, date: "2026-11-07", category: "Varios", description: "Librería", amount: 10800 }
  ];
  const existing = [
    { date: "2026-11-06", amount: 482.98, kind: "gasto", description: "IIBB" },
    { date: "2026-11-07", amount: 10800, kind: "ingreso", description: "no es gasto" }
  ];
  assert.deepEqual([...markDuplicates(rows, existing)], [1]);
  assert.deepEqual(monthsOf([...rows, { ...rows[0], line: 4, date: "2026-10-30" }]), ["2026-10", "2026-11"]);
});
