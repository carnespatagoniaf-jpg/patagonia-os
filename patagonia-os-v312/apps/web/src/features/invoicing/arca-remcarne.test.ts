import assert from "node:assert/strict";
import { describe, it } from "node:test";
// La lógica pura de la Edge Function arca-remito se prueba desde acá (el repo no corre tests de Deno).
import {
  cantidad,
  consultarRemitoPorIdReqInner,
  cuitValido,
  generarRemitoInner,
  parseConsultaRemito,
  parseDummy,
  parseLista,
  parseRemitoReturn,
  problemasDelRemito,
  remcarneEnvelope,
  tablaDe,
  tropaObligatoria,
  type RecRemitoInput
} from "../../../../../supabase/functions/arca-remito/remcarne.ts";

// Ejemplo "a" del manual (2.5.2.3): envío común, emisor titular, desde el domicilio del punto de emisión.
const ejemploA: RecRemitoInput = {
  tipoMovimiento: "ENV",
  categoriaEmisor: 1,
  puntoEmision: 9000,
  cuitTitularMercaderia: "11111111111",
  cuitDepositario: null,
  tipoReceptor: "MI",
  categoriaReceptor: 3,
  cuitReceptor: "22222222222",
  codDomOrigen: null,
  codDomDestino: 3,
  viaje: {
    cuitTransportista: "33333333333",
    cuitConductor: "44444444444",
    fechaInicioViaje: "2019-02-14",
    distanciaKm: 670,
    dominioVehiculo: "ARF458",
    dominioAcoplado: null
  },
  items: [
    { orden: 1, codTipoProd: "6.24", tropa: 121, kilos: 50, unidades: 4 },
    { orden: 2, codTipoProd: "6.9", tropa: 121, kilos: 50, unidades: 0 }
  ],
  codRemRedestinado: null
};

describe("generarRemito", () => {
  it("arma el pedido del ejemplo a del manual, en el orden del WSDL", () => {
    const xml = generarRemitoInner(410, ejemploA);
    assert.equal(
      xml,
      "<idReq>410</idReq><remito><tipoComprobante>995</tipoComprobante><tipoMovimiento>ENV</tipoMovimiento>" +
        "<categoriaEmisor>1</categoriaEmisor><puntoEmision>9000</puntoEmision><cuitTitularMercaderia>11111111111</cuitTitularMercaderia>" +
        "<tipoReceptor>MI</tipoReceptor><categoriaReceptor>3</categoriaReceptor><cuitReceptor>22222222222</cuitReceptor>" +
        "<codDomDestino>3</codDomDestino><viaje><cuitTransportista>33333333333</cuitTransportista><cuitConductor>44444444444</cuitConductor>" +
        "<fechaInicioViaje>2019-02-14</fechaInicioViaje><distanciaKm>670.00</distanciaKm><vehiculo><dominioVehiculo>ARF458</dominioVehiculo></vehiculo></viaje>" +
        "<arrayMercaderias><mercaderia><orden>1</orden><codTipoProd>6.24</codTipoProd><tropa>121</tropa><kilos>50.00</kilos><unidades>4.00</unidades></mercaderia>" +
        "<mercaderia><orden>2</orden><codTipoProd>6.9</codTipoProd><tropa>121</tropa><kilos>50.00</kilos><unidades>0.00</unidades></mercaderia></arrayMercaderias></remito>"
    );
  });

  it("envuelve con authRequest y el namespace del servicio", () => {
    const env = remcarneEnvelope("generarRemito", { token: "T", sign: "S", cuit: "30719560381" }, "<idReq>1</idReq>");
    assert.match(env, /xmlns:rem="http:\/\/ar\.gob\.afip\.wsremcarne\/RemCarneService\/"/);
    assert.match(env, /<rem:generarRemitoRequest><authRequest><token>T<\/token><sign>S<\/sign><cuitRepresentada>30719560381<\/cuitRepresentada><\/authRequest><idReq>1<\/idReq><\/rem:generarRemitoRequest>/);
  });

  it("el dummy va sin cuerpo", () => {
    assert.match(remcarneEnvelope("dummy", null), /<soapenv:Body><\/soapenv:Body>/);
  });

  it("consulta por idReq + punto de emisión", () => {
    assert.equal(consultarRemitoPorIdReqInner(7, 20), "<idReq>7</idReq><puntoEmision>20</puntoEmision>");
  });

  it("escapa texto y pasa la patente a mayúsculas", () => {
    const xml = generarRemitoInner(1, { ...ejemploA, viaje: { ...ejemploA.viaje!, dominioVehiculo: "ab123cd", dominioAcoplado: "x<1" } });
    assert.match(xml, /<dominioVehiculo>AB123CD<\/dominioVehiculo><dominioAcoplado>X&lt;1<\/dominioAcoplado>/);
  });
});

describe("cantidades", () => {
  it("2 decimales con punto y redondeo half even (manual 3.3)", () => {
    assert.equal(cantidad(50), "50.00");
    assert.equal(cantidad(0.125), "0.12");
    assert.equal(cantidad(0.135), "0.14");
    assert.equal(cantidad(1.005), "1.00");
  });
});

describe("respuestas", () => {
  it("lee un remito emitido con su código de autorización y QR", () => {
    const xml =
      `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:generarRemitoResponse xmlns:ns2="http://ar.gob.afip.wsremcarne/RemCarneService/">` +
      `<generarRemitoReturn><codRemito>8500</codRemito><tipoComprobante>995</tipoComprobante><puntoEmision>20</puntoEmision>` +
      `<datosEmision><nroRemito>15</nroRemito><codAutorizacion>12345678901234567890</codAutorizacion><fechaEmision>2026-11-18</fechaEmision><fechaVencimiento>2026-11-20</fechaVencimiento></datosEmision>` +
      `<estado>EMI</estado><qr>iVBORw0KGgo=</qr><resultado>A</resultado></generarRemitoReturn></ns2:generarRemitoResponse></S:Body></S:Envelope>`;
    const r = parseRemitoReturn(xml);
    assert.equal(r.resultado, "A");
    assert.equal(r.codRemito, "8500");
    assert.equal(r.estado, "EMI");
    assert.deepEqual(r.datosEmision, { nroRemito: 15, codAutorizacion: "12345678901234567890", fechaEmision: "2026-11-18", fechaVencimiento: "2026-11-20" });
    assert.equal(r.qr, "iVBORw0KGgo=");
  });

  it("lee un rechazo con errores de negocio", () => {
    const xml =
      `<S:Envelope><S:Body><ns2:generarRemitoResponse><generarRemitoReturn><resultado>R</resultado>` +
      `<arrayErrores><codigoDescripcion><codigo>1313</codigo><descripcion>Debe informar el nro. de tropa</descripcion></codigoDescripcion></arrayErrores>` +
      `</generarRemitoReturn></ns2:generarRemitoResponse></S:Body></S:Envelope>`;
    const r = parseRemitoReturn(xml);
    assert.equal(r.resultado, "R");
    assert.deepEqual(r.errores, [{ codigo: "1313", descripcion: "Debe informar el nro. de tropa" }]);
    assert.equal(r.datosEmision, null);
  });

  it("lee el error excepcional (fault)", () => {
    const xml = `<S:Envelope><S:Body><ns2:Fault><faultcode>ns3:Receiver</faultcode><faultstring>[wscommon_007] La firma no corresponde al token enviado.</faultstring></ns2:Fault></S:Body></S:Envelope>`;
    const r = parseRemitoReturn(xml);
    assert.equal(r.resultado, null);
    assert.match(r.fault ?? "", /wscommon_007/);
  });

  it("consulta: encontrado, no encontrado y sin respuesta clara", () => {
    const found = parseConsultaRemito(
      `<S:Body><consultarRemitoResponse><consultarRemitoReturn><idReq>7</idReq><remito><codRemito>99</codRemito><tipoComprobante>995</tipoComprobante><tipoMovimiento>ENV</tipoMovimiento>` +
        `<arrayMercaderias/><estado>EMI</estado><datosEmision><nroRemito>3</nroRemito><codAutorizacion>555</codAutorizacion><fechaEmision>2026-11-18</fechaEmision><fechaVencimiento>2026-11-21</fechaVencimiento></datosEmision></remito>` +
        `<qr>QQ==</qr></consultarRemitoReturn></consultarRemitoResponse></S:Body>`
    );
    assert.equal(found.found, true);
    assert.equal(found.codRemito, "99");
    assert.equal(found.datosEmision?.nroRemito, 3);
    const missing = parseConsultaRemito(
      `<S:Body><consultarRemitoResponse><consultarRemitoReturn><arrayErrores><codigoDescripcion><codigo>500</codigo><descripcion>No existe el remito</descripcion></codigoDescripcion></arrayErrores></consultarRemitoReturn></consultarRemitoResponse></S:Body>`
    );
    assert.equal(missing.found, false);
    const fault = parseConsultaRemito(`<S:Body><S:Fault><faultstring>Timeout</faultstring></S:Fault></S:Body>`);
    assert.equal(fault.found, null);
  });

  it("listas de parámetros y dummy (respuesta real de ARCA del 2026-11-17)", () => {
    const lista = parseLista(
      `<consultarCategoriasEmisorReturn><arrayCategoriasEmisor><codigoDescripcionString><codigo>1</codigo><descripcion>Uno</descripcion></codigoDescripcionString>` +
        `<codigoDescripcionString><codigo>2</codigo><descripcion>Dos &amp; tres</descripcion></codigoDescripcionString></arrayCategoriasEmisor></consultarCategoriasEmisorReturn>`,
      "arrayCategoriasEmisor"
    );
    assert.deepEqual(lista.items, [
      { codigo: "1", descripcion: "Uno" },
      { codigo: "2", descripcion: "Dos & tres" }
    ]);
    const d = parseDummy(
      `<S:Body><ns2:dummyResponse xmlns:ns2="http://ar.gob.afip.wsremcarne/RemCarneService/"><dummyReturn><appserver>OK</appserver><authserver>OK</authserver><dbserver>OK</dbserver></dummyReturn></ns2:dummyResponse></S:Body>`
    );
    assert.equal(d.ok, true);
  });
});

describe("validaciones del manual (2.5.2.4)", () => {
  const hoy = "2026-11-18";
  const base: RecRemitoInput = { ...ejemploA, viaje: { ...ejemploA.viaje!, fechaInicioViaje: hoy, cuitTransportista: "30719560381", cuitConductor: null }, cuitReceptor: "30719560381" };

  it("tabla y tropa", () => {
    assert.equal(tablaDe("6.24"), 6);
    assert.equal(tablaDe("13.30"), 13);
    assert.equal(tablaDe("624"), null);
    assert.equal(tropaObligatoria("1.1"), true);
    assert.equal(tropaObligatoria("2.15"), true);
    assert.equal(tropaObligatoria("2.24"), false);
    assert.equal(tropaObligatoria("6.24"), false);
    assert.equal(tropaObligatoria("13.18"), true);
  });

  it("CUIT con dígito verificador", () => {
    assert.equal(cuitValido("30719560381"), true);
    assert.equal(cuitValido("30-71956038-1"), true);
    assert.equal(cuitValido("30719560382"), false);
  });

  it("un envío completo no tiene problemas", () => {
    assert.deepEqual(problemasDelRemito(base, hoy), []);
  });

  it("pide tropa, kilos, viaje y destinatario", () => {
    const p = problemasDelRemito(
      {
        ...base,
        cuitReceptor: null,
        codDomDestino: null,
        viaje: { ...base.viaje!, fechaInicioViaje: "2026-11-17", dominioVehiculo: null },
        items: [
          { orden: 1, codTipoProd: "1.1", tropa: null, kilos: 100, unidades: 1 },
          { orden: 2, codTipoProd: "6.24", tropa: null, kilos: null, unidades: 3 },
          { orden: 3, codTipoProd: "7.7", tropa: null, kilos: null, unidades: null }
        ]
      },
      hoy
    );
    assert.ok(p.some((x) => /anterior a hoy/.test(x)));
    assert.ok(p.some((x) => /patente/.test(x)));
    assert.ok(p.some((x) => /domicilio de destino/.test(x)));
    assert.ok(p.some((x) => /CUIT del destinatario/.test(x)));
    assert.ok(p.some((x) => /Renglón 1: .*tropa/.test(x)));
    assert.ok(p.some((x) => /Renglón 2: .*kilos/.test(x)));
    assert.ok(p.some((x) => /Renglón 3: indicá kilos o unidades/.test(x)));
  });

  it("depósito propio (EM): sin CUIT del receptor (ARCA 1312, producción 2026-11-18)", () => {
    const em = { ...base, tipoReceptor: "EM" as const, categoriaReceptor: null, cuitReceptor: null };
    assert.deepEqual(problemasDelRemito(em, hoy), []);
    assert.ok(problemasDelRemito({ ...em, cuitReceptor: "30719560381" }, hoy).some((x) => /depósito propio/.test(x)));
    assert.ok(problemasDelRemito({ ...base, cuitReceptor: null }, hoy).some((x) => /CUIT del destinatario/.test(x)));
    assert.doesNotMatch(generarRemitoInner(1, em), /cuitReceptor/);
  });

  it("reparto sin destinatario; depositario con origen", () => {
    assert.ok(problemasDelRemito({ ...base, tipoMovimiento: "REP" }, hoy).some((x) => /reparto/.test(x)));
    assert.deepEqual(problemasDelRemito({ ...base, tipoMovimiento: "REP", tipoReceptor: null, categoriaReceptor: null, cuitReceptor: null, codDomDestino: null }, hoy), []);
    assert.ok(problemasDelRemito({ ...base, cuitDepositario: "20111111112" }, hoy).some((x) => /domicilio de origen/.test(x)));
  });
});
