import test from "node:test";
import assert from "node:assert/strict";
import { failureText, identifyItem, payloadProducts, sendItems, sendStatus } from "./scale-executor";
import { parseBranchConfig, parseScaleSetup, supportPayload } from "./cloud-engine-backend";
import { probeablePort, serialDeviceId, tcpDeviceId } from "./scale-fleet";
import { classifyPort } from "../discovery/port-classify";
import type { SendResult } from "../protocols/scale-jobs";

const PID = "3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b";

test("productos del trabajo → los del motor (lo raro se descarta)", () => {
  const list = payloadProducts({
    products: [
      { product_id: PID, plu: "1", name: "Nalga", unit: "kg", price: 18000 },
      { plu: 2, name: "Vacío", price: "15000", active: false },
      { plu: "3", price: 10 },
      "texto",
    ],
  });
  assert.deepEqual(list, [
    { id: PID, code: "1", name: "Nalga", unit: "kg", priceRetail: 18000, active: true },
    { id: "plu-2", code: "2", name: "Vacío", unit: "kg", priceRetail: 15000, active: false },
  ]);
});

test("resultado del motor → productos de scale_job_items y estado del trabajo", () => {
  const products = payloadProducts({ products: [{ product_id: PID, plu: "1", name: "Nalga", price: 1 }, { plu: "2", name: "Vacío", price: 1 }, { plu: "3", name: "Chorizo", price: 1 }] });
  const result = {
    ok: false,
    confirmed: 1,
    failed: 1,
    skipped: 1,
    blocker: undefined,
    products: [
      { code: "1", name: "Nalga", status: "confirmado" },
      { code: "2", name: "Vacío", status: "fallado", reason: "al releerlo no quedó igual" },
      { code: "3", name: "Chorizo", status: "salteado", reason: "sin precio" },
    ],
  } as unknown as SendResult;
  assert.deepEqual(sendItems(result, products), [
    { product_id: PID, plu: "1", action: "write", status: "confirmed", reason: null },
    { product_id: null, plu: "2", action: "write", status: "failed", reason: "al releerlo no quedó igual" },
    { product_id: null, plu: "3", action: "write", status: "skipped", reason: "sin precio" },
  ]);
  assert.equal(sendStatus(result), "partial");
  assert.equal(sendStatus({ ...result, confirmed: 0 }), "failed");
  assert.equal(sendStatus({ ...result, ok: true, failed: 0 }), "done");
  assert.match(failureText("balanza_no_esta", "", "Cuora caja"), /"Cuora caja" no está conectada a esta computadora/);
});

test("balanza encontrada → producto del trabajo con su huella física", () => {
  const item = identifyItem({
    deviceId: "usb-1",
    name: "Systel Cuora Max (COM7)",
    physical: { id: "usb-1", kind: "serial", path: "COM7", fingerprint: "usb:0403:6001:sn:A1" },
    found: true,
    known: false,
    result: { found: true, family: "systel", model: "systel-cuora-max", label: "Systel Cuora Max", identity: { address: 1 }, attempts: [], support: {} },
    error: null,
  });
  assert.equal(item.status, "confirmed");
  assert.equal(item.sent?.fingerprint, "usb:0403:6001:sn:A1");
  assert.deepEqual(item.read_back, { device_id: "usb-1", name: "Systel Cuora Max (COM7)", family: "systel", model: "systel-cuora-max", label: "Systel Cuora Max", identity: { address: 1 } });
});

test("huella: el id del puerto no depende del número de COM; qué puertos se prueban", () => {
  const a = classifyPort({ path: "COM3", vendorId: "0403", productId: "6001", serialNumber: "FT7QX2AB" });
  const b = classifyPort({ path: "COM9", vendorId: "0403", productId: "6001", serialNumber: "FT7QX2AB" });
  assert.equal(serialDeviceId(a), serialDeviceId(b));
  assert.equal(tcpDeviceId("192.168.0.50", 1001), "net-192-168-0-50-1001");
  assert.equal(probeablePort(a), true);
  assert.equal(probeablePort({ ...a, kind: "virtual" }), false);
  assert.equal(probeablePort({ ...a, kind: "bluetooth", bluetoothDirection: "incoming" }), false);
});

test("lo que devuelve la nube al motor, con las formas de la web", () => {
  assert.deepEqual(parseBranchConfig({ prefix_length: 2, plu_length: 5, weight_length: 5, weight_divisor: "1000", total_length: 13, payload_type: "amount" }), {
    prefixLength: 2,
    pluLength: 5,
    weightLength: 5,
    weightDivisor: 1000,
    totalLength: 13,
    payloadType: "amount",
  });
  assert.equal(parseBranchConfig(null), null);
  const setup = parseScaleSetup({
    profile: { scale_key: "systel-1", brand: "systel", weighed_format: "20PPPPPIIIIIC", amount_decimals: 0, generic_codes: [99], read_at: null, repeat_window_minutes: 5, active: true },
    items: [{ code: 1, name: "NALGA", sale_type: "P", prices: ["18000"], ean_type: null, ean_config: null, link_kind: "product", product_id: PID }],
  });
  assert.equal(setup?.profile.catalog[0].prices[0], 18000);
  assert.deepEqual(setup?.links, [{ code: 1, kind: "product", productId: PID }]);
  assert.equal(parseScaleSetup({ profile: null }), null);
  const payload = supportPayload({ deviceId: "usb-1", jobId: "j", kind: "send", ok: false, message: "no contesta", detail: { pasos: ["a"] } });
  assert.match(payload.note, /^Scale Connect \(usb-1\) · send: no contesta$/);
  assert.equal(JSON.parse(payload.log_text).detalle.pasos[0], "a");
});
