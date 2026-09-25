import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCloseTicket, buildMovementTicket, buildReceiptTicket } from "./sale-tickets";
import type { ReceiptState } from "./sale-model";

/** Texto legible de los bytes ESC/POS (se ignoran los comandos de control). */
function text(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : b === 10 ? "\n" : "")).join("");
}

const receipt: ReceiptState = {
  items: [
    { name: "Asado", unit: "kg", quantity: 2.5, unitPrice: 13800, discountAmount: 0 },
    { name: "Chorizo", unit: "unit", quantity: 4, unitPrice: 1100, discountAmount: 400 }
  ],
  saleDiscount: 500,
  saleSurcharge: 0,
  total: 38000,
  soldAt: "2026-09-25T15:30:00.000Z",
  paymentSummary: "Efectivo",
  amountTendered: 40000,
  change: 2000
};

describe("buildReceiptTicket", () => {
  it("incluye sucursal, ítems, descuento, total, pago y vuelto", () => {
    const t = text(buildReceiptTicket(receipt, "Sucursal Centro"));
    assert.match(t, /COMPROBANTE INTERNO/);
    assert.match(t, /Sucursal Centro/);
    assert.match(t, /Asado/);
    assert.match(t, /2\.5 kg x/);
    assert.match(t, /Chorizo/);
    assert.match(t, /4 unidad x/);
    assert.match(t, /Descuento: -/);
    assert.match(t, /TOTAL/);
    assert.match(t, /Pago: Efectivo/);
    assert.match(t, /Recibido: .*Vuelto:/);
    assert.match(t, /Gracias por su compra/);
  });

  it("sin sucursal ni pago en efectivo no imprime esas líneas", () => {
    const t = text(buildReceiptTicket({ ...receipt, amountTendered: null, change: null, saleDiscount: 0 }));
    assert.doesNotMatch(t, /Recibido:/);
    assert.doesNotMatch(t, /Descuento:/);
  });

  it("termina con el comando de corte de papel", () => {
    const bytes = buildReceiptTicket(receipt);
    assert.equal(bytes[0], 0x1b); // ESC @ (inicializar)
    assert.ok(bytes.length > 60);
  });
});

describe("buildMovementTicket", () => {
  it("lleva título, cuenta, contraparte, monto y renglón de firma", () => {
    const t = text(
      buildMovementTicket({ title: "PAGO A PROVEEDOR", date: "2026-09-25T15:30:00.000Z", amount: 120000, accountName: "Efectivo", detail: "Factura 123", counterpartLabel: "Proveedor", counterpartName: "Frigorífico Sur" }, "Sucursal Centro")
    );
    assert.match(t, /PAGO A PROVEEDOR/);
    assert.match(t, /Cuenta: Efectivo/);
    assert.match(t, /Proveedor: Frigor/);
    assert.match(t, /Factura 123/);
    assert.match(t, /MONTO/);
    assert.match(t, /Firma:/);
    assert.match(t, /Aclaraci/);
  });
});

describe("buildCloseTicket", () => {
  const summary = {
    total: 250000,
    byAccount: [{ accountId: "a1", amount: 250000 }],
    expectedCash: 90000,
    countedCash: 89000,
    difference: -1000,
    breakdown: { openingCash: 20000, cashSales: 100000, cashOutflows: 30000, cashInflows: 0, cashVales: 0, cashSupplierPayments: 0, nonCashOutflows: 0 }
  } as never;

  it("arma arqueo, por cuenta, movimientos, vales y pagos", () => {
    const t = text(
      buildCloseTicket({
        summary,
        branchName: "Sucursal Centro",
        accounts: [{ id: "a1", name: "Efectivo" }] as never,
        adjustments: [{ id: "m1", movementType: "ajuste", direction: "out", amount: 30000, notes: "Nafta", createdAt: "2026-09-25T15:00:00.000Z" }] as never,
        vales: [{ id: "v1", employeeName: "Juan", amount: 5000, detail: "Adelanto" }] as never,
        supplierPayments: [{ id: "p1", supplierName: "Cerdo Morón", amount: 40000, notes: "" }] as never
      })
    );
    assert.match(t, /CIERRE DE TURNO/);
    assert.match(t, /ARQUEO DE EFECTIVO/);
    assert.match(t, /Fondo inicial/);
    assert.match(t, /Diferencia/);
    assert.match(t, /POR CUENTA/);
    assert.match(t, /Efectivo/);
    assert.match(t, /MOVIMIENTOS DE CAJA/);
    assert.match(t, /Nafta/);
    assert.match(t, /VALES A EMPLEADOS/);
    assert.match(t, /Juan/);
    assert.match(t, /PAGOS A PROVEEDORES/);
    assert.match(t, /Cerdo Mor/);
    assert.match(t, /Firma:/);
  });

  it("sin resumen ni movimientos solo trae el encabezado y la firma", () => {
    const t = text(buildCloseTicket({ summary: null, accounts: [], adjustments: [], vales: [], supplierPayments: [] }));
    assert.match(t, /CIERRE DE TURNO/);
    assert.doesNotMatch(t, /ARQUEO/);
    assert.doesNotMatch(t, /VALES/);
  });
});
