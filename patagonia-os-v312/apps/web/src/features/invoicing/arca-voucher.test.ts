import assert from "node:assert/strict";
import { describe, it } from "node:test";
// La lógica pura de la Edge Function arca-invoice se prueba desde acá (el repo no corre tests de Deno).
import {
  arDate,
  caeRequestInner,
  certificateProblem,
  creditNoteTypeFor,
  friendlyArcaMessage,
  isNumberRaceError,
  loginTicketRequestXml,
  parseCaeResponse,
  parseConsultResponse,
  parseLastAuthorized,
  parseLoginResponse,
  parsePointsOfSale,
  vatRateId
} from "../../../../../supabase/functions/arca-invoice/voucher";
import { arcaQrUrl, voucherNumberLabel } from "./invoicing-view";
import { buildReceiptTicket } from "../sale/sale-tickets";
import type { ReceiptState } from "../sale/sale-model";

/** Posición de cada campo: ARCA exige el orden del WSDL. */
function order(xml: string, fields: string[]): number[] {
  return fields.map((f) => xml.indexOf(`<ar:${f}>`));
}

describe("pedido de CAE (FECAESolicitar)", () => {
  const base = {
    pointOfSale: 5,
    number: 124,
    date: "20261020",
    docType: 99,
    docNumber: "0",
    receiverCondition: "consumidor_final",
    total: 24656,
    net: 22312.22,
    vat: 2343.78,
    vatRate: 10.5
  };

  it("Factura C: sin IVA discriminado, neto = total, consumidor final = 5", () => {
    const xml = caeRequestInner({ ...base, voucherType: 11 });
    assert.match(xml, /<ar:CbteTipo>11<\/ar:CbteTipo>/);
    assert.match(xml, /<ar:ImpTotal>24656.00<\/ar:ImpTotal>/);
    assert.match(xml, /<ar:ImpNeto>24656.00<\/ar:ImpNeto>/);
    assert.match(xml, /<ar:ImpIVA>0.00<\/ar:ImpIVA>/);
    assert.doesNotMatch(xml, /<ar:Iva>/);
    assert.match(xml, /<ar:CondicionIVAReceptorId>5<\/ar:CondicionIVAReceptorId>/);
    assert.match(xml, /<ar:CbteDesde>124<\/ar:CbteDesde><ar:CbteHasta>124<\/ar:CbteHasta>/);
  });

  it("Factura B al 10,5%: bloque Iva con alícuota 4 y los campos en el orden del WSDL", () => {
    const xml = caeRequestInner({ ...base, voucherType: 6 });
    assert.match(xml, /<ar:AlicIva><ar:Id>4<\/ar:Id><ar:BaseImp>22312.22<\/ar:BaseImp><ar:Importe>2343.78<\/ar:Importe><\/ar:AlicIva>/);
    assert.match(xml, /<ar:ImpNeto>22312.22<\/ar:ImpNeto>/);
    const pos = order(xml, ["Concepto", "DocTipo", "DocNro", "CbteDesde", "CbteHasta", "CbteFch", "ImpTotal", "ImpTotConc", "ImpNeto", "ImpOpEx", "ImpTrib", "ImpIVA", "MonId", "MonCotiz", "CondicionIVAReceptorId", "Iva"]);
    assert.ok(pos.every((p) => p >= 0), "están todos");
    assert.deepEqual([...pos].sort((a, b) => a - b), pos);
  });

  it("Factura A a un responsable inscripto (condición 1, CUIT)", () => {
    const xml = caeRequestInner({ ...base, voucherType: 1, docType: 80, docNumber: "20123456786", receiverCondition: "responsable_inscripto", vatRate: 21 });
    assert.match(xml, /<ar:DocTipo>80<\/ar:DocTipo><ar:DocNro>20123456786<\/ar:DocNro>/);
    assert.match(xml, /<ar:CondicionIVAReceptorId>1<\/ar:CondicionIVAReceptorId>/);
    assert.match(xml, /<ar:Id>5<\/ar:Id>/);
  });

  it("nota de crédito: lleva la factura que anula, antes del bloque Iva", () => {
    const xml = caeRequestInner({
      ...base,
      voucherType: creditNoteTypeFor(6),
      related: { voucherType: 6, pointOfSale: 5, number: 123, cuit: "27182448902", date: "20261019" }
    });
    assert.match(xml, /<ar:CbteTipo>8<\/ar:CbteTipo>/);
    assert.match(xml, /<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>6<\/ar:Tipo><ar:PtoVta>5<\/ar:PtoVta><ar:Nro>123<\/ar:Nro><ar:Cuit>27182448902<\/ar:Cuit><ar:CbteFch>20261019<\/ar:CbteFch>/);
    assert.ok(xml.indexOf("<ar:CbtesAsoc>") < xml.indexOf("<ar:Iva>"));
    assert.equal(creditNoteTypeFor(1), 3);
    assert.equal(creditNoteTypeFor(11), 13);
  });

  it("alícuotas", () => {
    assert.equal(vatRateId(10.5), 4);
    assert.equal(vatRateId(21), 5);
    assert.equal(vatRateId(27), 6);
    assert.equal(vatRateId(0), 3);
  });
});

describe("fechas y ticket de acceso", () => {
  it("la fecha del comprobante es la de Argentina (UTC−3)", () => {
    assert.equal(arDate(new Date("2026-10-20T02:30:00Z")), "20261019");
    assert.equal(arDate(new Date("2026-10-20T03:30:00Z")), "20261020");
  });

  it("TRA del WSAA para wsfe, válido ±10 minutos", () => {
    const xml = loginTicketRequestXml(new Date("2026-10-20T12:00:00Z"));
    assert.match(xml, /<service>wsfe<\/service>/);
    assert.match(xml, /<generationTime>2026-10-20T11:50:00\+00:00<\/generationTime>/);
    assert.match(xml, /<expirationTime>2026-10-20T12:10:00\+00:00<\/expirationTime>/);
  });

  it("lee el ticket que devuelve el WSAA (viene escapado)", () => {
    const xml =
      "<soapenv:Envelope><soapenv:Body><loginCmsResponse><loginCmsReturn>&lt;?xml version=\"1.0\"?&gt;&lt;loginTicketResponse&gt;&lt;header&gt;" +
      "&lt;expirationTime&gt;2026-10-20T09:03:18.577-03:00&lt;/expirationTime&gt;&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;TOK+/=&lt;/token&gt;" +
      "&lt;sign&gt;SIG==&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>";
    assert.deepEqual(parseLoginResponse(xml), { token: "TOK+/=", sign: "SIG==", expiresAt: "2026-10-20T09:03:18.577-03:00" });
    const fault = parseLoginResponse("<soapenv:Fault><faultstring>El CEE ya posee un TA valido para el acceso al WSN solicitado</faultstring></soapenv:Fault>");
    assert.ok("fault" in fault && /TA valido/.test(fault.fault));
  });
});

describe("respuestas de ARCA", () => {
  it("CAE aprobado", () => {
    const xml =
      "<FECAESolicitarResult><FeCabResp><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro>" +
      "<CbteDesde>124</CbteDesde><CbteHasta>124</CbteHasta><CbteFch>20261020</CbteFch><Resultado>A</Resultado><CAE>76423000000012</CAE><CAEFchVto>20261030</CAEFchVto>" +
      "</FECAEDetResponse></FeDetResp></FECAESolicitarResult>";
    const r = parseCaeResponse(xml);
    assert.equal(r.result, "A");
    assert.equal(r.cae, "76423000000012");
    assert.equal(r.caeDue, "2026-10-30");
    assert.equal(r.number, 124);
    assert.equal(r.date, "20261020");
  });

  it("rechazo con observación y error", () => {
    const xml =
      "<FECAESolicitarResult><FeDetResp><FECAEDetResponse><Resultado>R</Resultado><Observaciones><Obs><Code>10015</Code><Msg>DocNro invalido</Msg></Obs></Observaciones><CAE></CAE><CAEFchVto></CAEFchVto></FECAEDetResponse></FeDetResp>" +
      "<Errors><Err><Code>10016</Code><Msg>El numero no es el proximo</Msg></Err></Errors></FECAESolicitarResult>";
    const r = parseCaeResponse(xml);
    assert.equal(r.result, "R");
    assert.equal(r.cae, null);
    assert.equal(r.caeDue, null);
    assert.equal(isNumberRaceError(r.errors), true);
    assert.match(friendlyArcaMessage(r.errors, r.observations), /documento del cliente no es válido/);
  });

  it("CUIT que no delegó la facturación", () => {
    const r = parseLastAuthorized("<Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No aparecio CUIT en lista de relaciones: 20123456786</Msg></Err></Errors>");
    assert.equal(r.number, null);
    assert.match(friendlyArcaMessage(r.errors), /falta la relación "Facturación Electrónica"/);
    assert.equal(parseLastAuthorized("<PtoVta>5</PtoVta><CbteTipo>11</CbteTipo><CbteNro>123</CbteNro>").number, 123);
  });

  it("consulta de un número ya autorizado (para no duplicar tras un corte)", () => {
    const c = parseConsultResponse("<ResultGet><DocNro>0</DocNro><CbteFch>20261020</CbteFch><ImpTotal>24656</ImpTotal><CodAutorizacion>76423000000012</CodAutorizacion><FchVto>20261030</FchVto></ResultGet>");
    assert.deepEqual(c, { found: true, cae: "76423000000012", caeDue: "2026-10-30", total: 24656, docNumber: "0", date: "20261020", errors: [] });
    assert.equal(parseConsultResponse("<Errors><Err><Code>602</Code><Msg>Sin Resultados</Msg></Err></Errors>").found, false);
  });

  it("puntos de venta", () => {
    const xml =
      "<ResultGet><PtoVenta><Nro>5</Nro><EmisionTipo>CAE - RECE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta>" +
      "<PtoVenta><Nro>2</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>20240101</FchBaja></PtoVenta></ResultGet>";
    assert.deepEqual(parsePointsOfSale(xml).points, [
      { number: 5, kind: "CAE - RECE", blocked: false, closed: false },
      { number: 2, kind: "CAE", blocked: false, closed: true }
    ]);
  });
});

describe("QR y ticket fiscal", () => {
  it("el QR lleva el JSON de la RG 4892 en base64", () => {
    const url = arcaQrUrl({ issuedOn: "2026-10-20", cuit: "20-12345678-6", pointOfSale: 5, voucherType: 11, number: 124, total: 24656, docType: 99, docNumber: "0", cae: "76423000000012" });
    assert.match(url, /^https:\/\/www\.afip\.gob\.ar\/fe\/qr\/\?p=/);
    const json = JSON.parse(Buffer.from(url.split("?p=")[1], "base64").toString("utf8"));
    assert.deepEqual(json, {
      ver: 1, fecha: "2026-10-20", cuit: 20123456786, ptoVta: 5, tipoCmp: 11, nroCmp: 124, importe: 24656,
      moneda: "PES", ctz: 1, tipoDocRec: 99, nroDocRec: 0, tipoCodAut: "E", codAut: 76423000000012
    });
    assert.equal(voucherNumberLabel(5, 124), "00005-00000124");
  });

  it("con factura, el ticket térmico sale como factura con CAE y QR (y sin 'no válido')", () => {
    const receipt: ReceiptState = {
      items: [{ name: "Asado", unit: "kg", quantity: 2, unitPrice: 12328, discountAmount: 0 }],
      saleDiscount: 0,
      saleSurcharge: 0,
      total: 24656,
      soldAt: "2026-10-20T15:00:00.000Z",
      paymentSummary: "Efectivo",
      amountTendered: null,
      change: null,
      invoice: {
        voucherType: 6,
        letter: "B",
        pointOfSale: 5,
        number: 124,
        cae: "76423000000012",
        caeDue: "2026-10-30",
        issuedOn: "2026-10-20",
        issuer: { businessName: "Carniceria Don Julio", cuit: "20123456786", taxCondition: "responsable_inscripto", address: "Calle 1 123", grossIncomeNumber: "901-123", activityStart: "2020-01-02" },
        customer: { name: null, docType: 99, docNumber: "0", taxCondition: "consumidor_final" },
        total: 24656,
        net: 22312.22,
        vat: 2343.78,
        vatRate: 10.5,
        qrUrl: "https://www.afip.gob.ar/fe/qr/?p=abc"
      }
    };
    const bytes = buildReceiptTicket(receipt);
    const text = Array.from(bytes, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : b === 10 ? "\n" : "")).join("");
    assert.match(text, /FACTURA B/);
    assert.match(text, /COD\. 006/);
    assert.match(text, /CUIT 20-12345678-6/);
    assert.match(text, /Nro 00005-00000124/);
    assert.match(text, /IVA contenido \(10,5%\)/);
    assert.match(text, /CAE 76423000000012/);
    assert.match(text, /Vto\. CAE 30\/10\/2026/);
    assert.doesNotMatch(text, /NO VALIDO COMO FACTURA/);
    // Comando de QR (GS ( k ... 49 80 48) seguido de la URL.
    assert.ok(text.includes("1P0https://www.afip.gob.ar/fe/qr/?p=abc"));
  });
});

describe("certificado propio del negocio (migración 137)", () => {
  const ok = {
    env: "prod" as const,
    issuerCommonName: "Computadores",
    subjectCuit: "20123456786",
    expectedCuit: "20123456786",
    notAfter: new Date("2028-10-18T00:00:00Z"),
    now: new Date("2026-10-20T00:00:00Z"),
    keyMatches: true
  };
  it("un certificado de producción del mismo CUIT y del último pedido sirve", () => {
    assert.equal(certificateProblem(ok), null);
    assert.equal(certificateProblem({ ...ok, env: "homo", issuerCommonName: "Computadores Test" }), null);
  });
  it("rechaza con el motivo en palabras", () => {
    assert.match(certificateProblem({ ...ok, keyMatches: false }) ?? "", /no corresponde al último pedido/);
    assert.match(certificateProblem({ ...ok, subjectCuit: "27182448902" }) ?? "", /es del CUIT 27182448902/);
    assert.match(certificateProblem({ ...ok, issuerCommonName: "Computadores Test" }) ?? "", /PRUEBA/);
    assert.match(certificateProblem({ ...ok, env: "homo" }) ?? "", /de producción/);
    assert.match(certificateProblem({ ...ok, notAfter: new Date("2026-01-01T00:00:00Z") }) ?? "", /vencido/);
  });
});
