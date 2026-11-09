import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInvoice, draftLinesFromInvoice, matchProduct, matchSupplier, parseReadInvoice, priceText, quantityText } from "./invoice-draft";

const products = [
  { id: "bife", name: "BIFE ANCHO" },
  { id: "angosto", name: "BIFE ANGOSTO" },
  { id: "nalga", name: "NALGA" },
  { id: "tapanalga", name: "TAPA DE NALGA" },
  { id: "lomo", name: "LOMO" },
  { id: "asado", name: "ASADO" },
  { id: "asadomedio", name: "ASADO DEL MEDIO" },
  { id: "roast", name: "ROAST BEEF" },
  { id: "palomita", name: "PALOMITA" },
  { id: "oferta", name: "OFERTA NALGA 2KG" },
  { id: "pollo", name: "POLLO ENTERO" },
  { id: "patamuslo", name: "PATA MUSLO" }
];

test("elige el producto con todas sus palabras en orden y el más largo", () => {
  assert.equal(matchProduct("BIFE ANCHO CON TAPA", products), "bife");
  assert.equal(matchProduct("NALGA SIN TAPA", products), "nalga");
  assert.equal(matchProduct("TAPA DE NALGA", products), "tapanalga");
  assert.equal(matchProduct("LOMOS CON CORDON", products), "lomo");
  assert.equal(matchProduct("ASADO TABLITA CON HUESO CONGELADO", products), "asado");
  assert.equal(matchProduct("Asado del medio x kg", products), "asadomedio");
  assert.equal(matchProduct("ROAST BEEF (AGUJA)", products), "roast");
  assert.equal(matchProduct("PALOMITA (CHINGOLO)", products), "palomita");
  assert.equal(matchProduct("Pata y muslo", products), "patamuslo");
});

test("no propone ofertas, ni nada cuando no está seguro", () => {
  assert.equal(matchProduct("RECORTES DESPOSTADA", products), null);
  assert.equal(matchProduct("", products), null);
  const twins = [{ id: "a", name: "Vacío" }, { id: "b", name: "VACIO" }];
  assert.equal(matchProduct("VACIO", twins), null);
  assert.equal(matchProduct("OFERTA NALGA 2KG", [{ id: "oferta", name: "OFERTA NALGA 2KG" }]), null);
});

test("el proveedor sale por CUIT y si no por nombre", () => {
  const suppliers = [
    { id: "oink", name: "Cerdo Oink", taxId: "30-71234567-8" },
    { id: "merlo", name: "Carnes Merlo" },
    { id: "frigo", name: "Frigorífico Merlo" },
    { id: "pollo", name: "Pollo Don miguelo" }
  ];
  assert.equal(matchSupplier({ supplierName: "OINK CORTADA SRL", supplierTaxId: "30712345678" }, suppliers), "oink");
  assert.equal(matchSupplier({ supplierName: "MATADERO Y FRIGORIFICO MERLO S.A.", supplierTaxId: "" }, suppliers), "frigo");
  assert.equal(matchSupplier({ supplierName: "Don Miguelo pollos", supplierTaxId: "" }, suppliers), "pollo");
  assert.equal(matchSupplier({ supplierName: "Merlo", supplierTaxId: "" }, suppliers), null, "dos proveedores Merlo: no elige");
  assert.equal(matchSupplier({ supplierName: "POLLO DON MIGUELO", supplierTaxId: "" }, suppliers), "pollo");
  assert.equal(matchSupplier({ supplierName: "", supplierTaxId: "" }, suppliers), null);
});

test("lee la respuesta aunque venga incompleta y calcula el precio que falta", () => {
  const inv = parseReadInvoice({
    supplier_name: " Oink ",
    supplier_tax_id: "30-71234567-8",
    date: "02/11/2026",
    items: [{ description: "Bondiola", quantity: 4.5, unit: "kg", unit_price: 0, line_total: 45000 }, { description: "", quantity: 0 }, "basura"],
    total: "45000"
  });
  assert.equal(inv.supplierName, "Oink");
  assert.equal(inv.supplierTaxId, "30712345678");
  assert.equal(inv.date, "", "una fecha que no es AAAA-MM-DD se descarta");
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].unitPrice, 10000);
  assert.equal(inv.total, 45000);
  assert.deepEqual(inv.warnings, []);
  assert.deepEqual(parseReadInvoice(null).items, []);
});

test("arma los renglones del formulario con coma decimal", () => {
  const inv = parseReadInvoice({
    items: [
      { description: "NALGA SIN TAPA", quantity: 20.35, unit: "kg", unit_price: 14200, line_total: 288970 },
      { description: "RECORTES DESPOSTADA", quantity: 2, unit: "unit", unit_price: 7400.5, line_total: 14801 }
    ]
  });
  assert.deepEqual(draftLinesFromInvoice(inv, products), [
    { productId: "nalga", description: "", quantity: "20,35", unit: "kg", unitPrice: "14200" },
    { productId: "", description: "RECORTES DESPOSTADA", quantity: "2", unit: "unit", unitPrice: "7400,5" }
  ]);
  assert.equal(quantityText(0), "");
  assert.equal(priceText(14315.25), "14315,25");
});

test("avisa cuando las cuentas no cierran", () => {
  const good = parseReadInvoice({
    items: [{ description: "A", quantity: 2, unit: "kg", unit_price: 1000, line_total: 2000 }, { description: "B", quantity: 1, unit: "kg", unit_price: 500, line_total: 500 }],
    subtotal: 2500,
    tax_total: 262.5,
    total: 2762.5
  });
  assert.equal(checkInvoice(good).ok, true);
  assert.deepEqual(checkInvoice(good).notes, []);

  const missing = parseReadInvoice({ items: [{ description: "A", quantity: 2, unit: "kg", unit_price: 1000, line_total: 2000 }], total: 50000 });
  const check = checkInvoice(missing);
  assert.equal(check.ok, false);
  assert.match(check.notes[0], /suman 2000 y el papel dice 50000/);

  const badLine = parseReadInvoice({ items: [{ description: "Vacío", quantity: 3, unit: "kg", unit_price: 1000, line_total: 9000 }], total: 9000 });
  assert.match(checkInvoice(badLine).notes[0], /Renglón 1 \(Vacío\)/);
});
