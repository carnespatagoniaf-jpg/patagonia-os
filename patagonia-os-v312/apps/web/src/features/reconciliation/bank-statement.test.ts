import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDelimited } from "../import/import-parse";
import { guessBankMapping, parseBankAmount, parseBankDate, parseBankStatement } from "./bank-statement";

// Formatos a imagen de los típicos. El primero reproduce la FORMA exacta del
// resumen real del Banco Provincia (.xls binario de JasperReports, sept 2026)
// con nombres y montos inventados; ese archivo real se leyó completo (1.227
// líneas) sin cambios en el lector.

describe("forma real del Banco Provincia (.xls leído como tabla)", () => {
  const table = [
    [],
    [],
    [null, "Fecha: 30/09/2026   Hora: 11:01"],
    [null, "Detalle de Movimientos"],
    [null, "Cuenta: 0000-000000/0"],
    [null, "Fecha", "Descripción", "Importe", "Saldo"],
    [],
    [null, "30-sept-2026", "TRANSF DE JUAN PEREZ (20111111112) VAR", 82860, 497411.07],
    [null, "30-sept-2026", "IMPUESTO CREDITO -LEY 25413", -963.39, 409171.07],
    [null, "30-sept-2026", "PAGOS A COMERCIOS VISA - L. 0000300258 - C. 00005683628", 89420.91, 330925.35],
    [null, "29-sept-2026", "DB.DEBIN 30/09-S.237200 C:20384013156", -400000, 9980.47],
    [null, "01-sept-2026", "TRANSF DE ANA GOMEZ (27222222223) VAR", 5938, 407915.47],
    [null, "Esta información es la que consta en los sistemas del Banco en el día y hora indicados,"],
    [null, "y está supeditada a los ajustes que pudieran realizarse en los mismos."],
    []
  ];

  it("encuentra los títulos debajo del encabezado del banco y lee todo", () => {
    const mapping = guessBankMapping(table);
    assert.ok(mapping);
    assert.equal(mapping.headerRow, 5);
    assert.deepEqual(mapping.columns, { date: 1, description: 2, amount: 3, balance: 4 });
    const { lines, skipped } = parseBankStatement(table, mapping);
    assert.deepEqual(
      lines.map((l) => [l.date, l.amount]),
      [
        ["2026-09-30", 82860],
        ["2026-09-30", -963.39],
        ["2026-09-30", 89420.91],
        ["2026-09-29", -400000],
        ["2026-09-01", 5938]
      ]
    );
    assert.equal(skipped.length, 2);
  });
});

describe("resumen con débito y crédito en columnas separadas, encabezado con datos del titular", () => {
  const csv = [
    "Banco Ejemplo S.A.;;;;;",
    "Titular: CARNICERIA DE PRUEBA;;;;;",
    "CBU: 0000000000000000000000;;;;;",
    ";;;;;",
    "Fecha;Descripción;Nro. Comprobante;Débito;Crédito;Saldo",
    "01/09/2026;Saldo anterior;;;;150.000,00",
    "02/09/2026;TRANSFERENCIA RECIBIDA - PEREZ JUAN;12345678;;25.000,00;175.000,00",
    "03/09/2026;COMISION MANTENIMIENTO CUENTA;;3.500,00;;171.500,00",
    "03/09/2026;IMP. LEY 25413 DEB;;21,00;;171.479,00",
    "05/09/2026;ACRED. LIQUIDACION VISA;998877;;96.450,30;267.929,30",
    "15/09/2026;PAGO PROVEEDOR FRIGORIFICO;555;80.000,00;;187.929,30",
    ";Total del período;;83.521,00;121.450,30;"
  ].join("\n");
  const table = parseDelimited(csv);

  it("encuentra la fila de encabezados aunque arriba haya datos del titular", () => {
    const mapping = guessBankMapping(table);
    assert.ok(mapping);
    assert.equal(mapping.headerRow, 4);
    assert.equal(mapping.columns.debit, 3);
    assert.equal(mapping.columns.credit, 4);
    assert.equal(mapping.columns.reference, 2);
    assert.equal(mapping.columns.amount, undefined);
  });

  it("lee los movimientos con signo y saltea saldo anterior y totales", () => {
    const { lines, skipped } = parseBankStatement(table, guessBankMapping(table)!);
    assert.deepEqual(
      lines.map((l) => [l.date, l.amount, l.reference]),
      [
        ["2026-09-02", 25000, "12345678"],
        ["2026-09-03", -3500, null],
        ["2026-09-03", -21, null],
        ["2026-09-05", 96450.3, "998877"],
        ["2026-09-15", -80000, "555"]
      ]
    );
    assert.equal(skipped.length, 2);
  });
});

describe("resumen con un solo importe con signo (tipo billetera)", () => {
  const csv = [
    "Fecha de liberación,Descripción,Id de operación en Mercado Pago,Valor,Saldo",
    "2026-09-02T10:15:00.000-03:00,Transferencia recibida,74839201,\"12,500.00\",12500.00",
    "2026-09-02T18:40:00.000-03:00,Cobro con QR,74839555,3400.50,15900.50",
    "2026-09-04T09:00:00.000-03:00,Pago de servicio,74839999,-8200.00,7700.50"
  ].join("\n");
  const table = parseDelimited(csv);

  it("reconoce columnas y fechas ISO con hora", () => {
    const mapping = guessBankMapping(table);
    assert.ok(mapping);
    assert.equal(mapping.dateOrder, "ymd");
    const { lines } = parseBankStatement(table, mapping);
    assert.deepEqual(
      lines.map((l) => [l.date, l.amount, l.reference]),
      [
        ["2026-09-02", 12500, "74839201"],
        ["2026-09-02", 3400.5, "74839555"],
        ["2026-09-04", -8200, "74839999"]
      ]
    );
  });
});

describe("reporte de liberaciones de Mercado Pago (columnas en inglés, crédito y débito netos)", () => {
  const csv = [
    "DATE,SOURCE_ID,EXTERNAL_REFERENCE,RECORD_TYPE,DESCRIPTION,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT,GROSS_AMOUNT,MP_FEE_AMOUNT,BALANCE_AMOUNT",
    "2026-09-02T10:15:00.000-03:00,74839201,,release,payment,9650.00,0.00,10000.00,-350.00,9650.00",
    "2026-09-03T09:00:00.000-03:00,74839999,,release,withdrawal,0.00,9000.00,-9000.00,0.00,650.00"
  ].join("\n");

  it("usa el neto acreditado y debitado", () => {
    const table = parseDelimited(csv);
    const mapping = guessBankMapping(table);
    assert.ok(mapping);
    const { lines } = parseBankStatement(table, mapping);
    assert.deepEqual(lines.map((l) => [l.date, l.amount, l.reference, l.balance]), [
      ["2026-09-02", 9650, "74839201", 9650],
      ["2026-09-03", -9000, "74839999", 650]
    ]);
  });
});

describe("importes y fechas en los formatos que usan los bancos", () => {
  it("importes", () => {
    assert.equal(parseBankAmount("1.234,56"), 1234.56);
    assert.equal(parseBankAmount("1,234.56"), 1234.56);
    assert.equal(parseBankAmount("-1.234,56"), -1234.56);
    assert.equal(parseBankAmount("(1.234,56)"), -1234.56);
    assert.equal(parseBankAmount("1.234,56-"), -1234.56);
    assert.equal(parseBankAmount("$ 1.234,56"), 1234.56);
    assert.equal(parseBankAmount("1.234,56 D"), -1234.56);
    assert.equal(parseBankAmount("1.234,56 C"), 1234.56);
    assert.equal(parseBankAmount("15.000"), 15000);
    assert.equal(parseBankAmount(-500), -500);
    assert.equal(parseBankAmount(""), null);
    assert.equal(parseBankAmount("abc"), null);
  });

  it("fechas", () => {
    assert.equal(parseBankDate("30/09/2026", "dmy"), "2026-09-30");
    assert.equal(parseBankDate("30-09-26", "dmy"), "2026-09-30");
    assert.equal(parseBankDate("2026-09-30", "ymd"), "2026-09-30");
    assert.equal(parseBankDate("30-sep-26", "dmy"), "2026-09-30");
    assert.equal(parseBankDate("05/Ene/2026", "dmy"), "2026-01-05");
    assert.equal(parseBankDate("09/30/2026", "mdy"), "2026-09-30");
    assert.equal(parseBankDate("30/09/2026 14:22", "dmy"), "2026-09-30");
    assert.equal(parseBankDate(46295, "dmy"), "2026-09-30"); // número de serie de Excel
    assert.equal(parseBankDate(new Date(2026, 8, 30), "dmy"), "2026-09-30");
    assert.equal(parseBankDate("31/02/2026", "dmy"), null);
    assert.equal(parseBankDate("Total", "dmy"), null);
  });
});

describe("no importar dos veces", () => {
  it("dos comisiones iguales el mismo día son dos líneas distintas, y el mismo archivo da las mismas claves", () => {
    const csv = ["Fecha;Concepto;Importe", "03/09/2026;COMISION;-100,00", "03/09/2026;COMISION;-100,00"].join("\n");
    const table = parseDelimited(csv);
    const first = parseBankStatement(table, guessBankMapping(table)!).lines;
    const second = parseBankStatement(table, guessBankMapping(table)!).lines;
    assert.equal(first.length, 2);
    assert.notEqual(first[0].key, first[1].key);
    assert.deepEqual(first.map((l) => l.key), second.map((l) => l.key));
  });
});

describe("archivo que no es un resumen", () => {
  it("devuelve null si no hay fecha e importe", () => {
    assert.equal(guessBankMapping(parseDelimited("Nombre;Telefono\nJuan;123")), null);
  });
});
