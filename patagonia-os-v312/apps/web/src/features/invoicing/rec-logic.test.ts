import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formToPayload, parseRecRemito, parseRecSettings, recActions, recFormProblems, recNumberLabel, searchTiposCarne, type RecForm } from "./rec-logic";

const base: RecForm = {
  pointOfEmission: "20",
  tipoMovimiento: "ENV",
  destino: "cliente",
  destinationBranchId: "",
  customerId: "",
  cuitReceptor: "20-11111111-2",
  receptorName: "Carnicería X",
  categoriaReceptor: "3",
  codDomDestino: "0",
  destinoDesc: "Domicilio fiscal del destinatario",
  motivo: "Venta",
  cuitTransportista: "30-71956038-1",
  transportistaName: "Propio",
  cuitConductor: "",
  dominioVehiculo: "ab 123 cd",
  dominioAcoplado: "",
  fechaInicioViaje: "2026-11-18",
  distanciaKm: "12,5",
  notes: "",
  items: [{ key: "a", productId: "p1", productName: "Cuadril", codTipoProd: "6.21", tropa: "", kilos: "50,5", unidades: "" }]
};

describe("formulario del remito cárnico", () => {
  it("un envío a cliente completo no tiene problemas y arma el pedido", () => {
    assert.deepEqual(recFormProblems(base, "30719560381", 1, "2026-11-18"), []);
    const p = formToPayload(base, "30719560381");
    assert.equal(p.tipo_receptor, "MI");
    assert.equal(p.cuit_receptor, "20111111112");
    assert.equal(p.cod_dom_destino, 0);
    assert.equal(p.distancia_km, 12.5);
    assert.equal(p.dominio_vehiculo, "ab123cd"); // la base la pasa a mayúsculas
    assert.deepEqual(p.items, [{ product_id: "p1", product_name: "Cuadril", cod_tipo_prod: "6.21", tropa: null, kilos: 50.5, unidades: null }]);
  });

  it("a un depósito propio (EM) no se manda el CUIT del receptor: ARCA responde 1312", () => {
    const f: RecForm = { ...base, destino: "propio", destinationBranchId: "b2", categoriaReceptor: "", codDomDestino: "4" };
    assert.deepEqual(recFormProblems(f, "30719560381", 1, "2026-11-18"), []);
    const p = formToPayload(f, "30719560381");
    assert.equal(p.tipo_receptor, "EM");
    assert.equal(p.cuit_receptor, null);
    assert.equal(p.categoria_receptor, null);
    assert.equal(p.destination_branch_id, "b2");
    assert.equal(p.customer_id, null);
  });

  it("reparto: sin destinatario ni domicilio", () => {
    const p = formToPayload({ ...base, tipoMovimiento: "REP" }, "30719560381");
    assert.equal(p.tipo_receptor, null);
    assert.equal(p.cuit_receptor, null);
    assert.equal(p.cod_dom_destino, null);
  });

  it("retiro en planta: con cliente, sin domicilio de destino", () => {
    const f: RecForm = { ...base, tipoMovimiento: "PLA", codDomDestino: "" };
    assert.deepEqual(recFormProblems(f, "30719560381", 1, "2026-11-18"), []);
    assert.equal(formToPayload(f, "30719560381").cod_dom_destino, null);
  });

  it("avisa lo que falta", () => {
    const p = recFormProblems(
      { ...base, categoriaReceptor: "", distanciaKm: "abc", items: [{ ...base.items[0], codTipoProd: "1.1", kilos: "x" }] },
      "30719560381",
      null,
      "2026-11-18"
    );
    assert.ok(p.some((x) => /kilos y unidades/.test(x)));
    assert.ok(p.some((x) => /distancia tiene que ser/.test(x)));
    assert.ok(p.some((x) => /categoría del emisor/.test(x)));
    assert.ok(p.some((x) => /categoría del destinatario/.test(x)));
    assert.ok(p.some((x) => /tropa/.test(x)));
  });
});

describe("lista y estados", () => {
  it("botones por estado", () => {
    assert.deepEqual(recActions("pendiente"), ["send", "discard"]);
    assert.deepEqual(recActions("incierto"), ["retry"]);
    assert.deepEqual(recActions("emitido"), ["print", "refresh"]);
    assert.deepEqual(recActions("anulado"), []);
  });

  it("número con punto de emisión", () => {
    assert.equal(recNumberLabel(20, 15), "00020-00000015");
    assert.equal(recNumberLabel(20, null), "00020-…");
  });

  it("lee fila con renglones ordenados y el código de autorización como texto", () => {
    const r = parseRecRemito({
      id: "x",
      point_of_emission: 20,
      id_req: "2026111800001",
      tipo_movimiento: "ENV",
      cuit_emisor: "30719560381",
      status: "emitido",
      cod_autorizacion: "12345678901234567890",
      nro_remito: 3,
      issuer: { business_name: "CARNES BOTS S.A." },
      created_at: "2026-11-18T10:00:00Z",
      rec_remito_items: [
        { orden: 2, cod_tipo_prod: "6.9", kilos: "10.00" },
        { orden: 1, cod_tipo_prod: "6.24", kilos: "5.5", tropa: 12 }
      ]
    });
    assert.equal(r.codAutorizacion, "12345678901234567890");
    assert.equal(r.issuer.businessName, "CARNES BOTS S.A.");
    assert.deepEqual(r.items.map((i) => i.orden), [1, 2]);
    assert.equal(r.items[0].tropa, 12);
  });

  it("buscar tipos de carne por código o palabras", () => {
    const s = parseRecSettings({
      catalog: {
        tiposCarne: [
          { grupo: "6", codigo: "6.24", descripcion: "Cuadril sin tapa" },
          { grupo: "6", codigo: "6.21", descripcion: "Cuadril" },
          { grupo: "6", codigo: "6.30", descripcion: "Lomo" }
        ]
      }
    });
    assert.deepEqual(searchTiposCarne(s.catalog, "6.21").map((t) => t.codigo), ["6.21"]);
    assert.deepEqual(searchTiposCarne(s.catalog, "cuadril sin").map((t) => t.codigo), ["6.24"]);
    assert.equal(s.catalog.categoriasEmisor.length, 0);
  });
});
