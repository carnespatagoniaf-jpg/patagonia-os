import test from "node:test";
import assert from "node:assert/strict";
import { classifyPort, classifyPorts, isRealSerialNumber } from "./port-classify";
import { StaticPortLister, discoverPorts } from "./port-lister";

// Formas reales en que Windows (SetupAPI, vía serialport) informa cada adaptador.

test("FTDI FT232R con número de serie: huella por serie", () => {
  const p = classifyPort({
    path: "COM5",
    manufacturer: "FTDI",
    serialNumber: "A50285BI",
    pnpId: "FTDIBUS\\VID_0403+PID_6001+A50285BIA\\0000",
    locationId: undefined,
    vendorId: "0403",
    productId: "6001",
  });
  assert.equal(p.kind, "usb");
  assert.equal(p.chip, "ftdi");
  assert.equal(p.chipLabel, "FT232R");
  assert.equal(p.serialNumber, "A50285BI");
  assert.equal(p.fingerprintSource, "serial");
  assert.equal(p.fingerprint, "usb:0403:6001:sn:A50285BI");
});

test("CH340 sin serie: Windows inventa un id con '&', se usa la ubicación", () => {
  const p = classifyPort({
    path: "COM3",
    manufacturer: "wch.cn",
    serialNumber: "5&2a6e7e8c&0&3",
    pnpId: "USB\\VID_1A86&PID_7523\\5&2A6E7E8C&0&3",
    locationId: "Port_#0003.Hub_#0001",
    vendorId: "1A86",
    productId: "7523",
  });
  assert.equal(p.chip, "ch34x");
  assert.equal(p.chipLabel, "CH340");
  assert.equal(p.serialNumber, undefined);
  assert.equal(p.fingerprintSource, "location");
  assert.equal(p.fingerprint, "usb:1a86:7523:loc:Port_#0003.Hub_#0001");
  assert.ok(p.notes.some((n) => /número de serie/.test(n)));
});

test("CH340 sin serie ni ubicación: cae al id de instancia de Windows", () => {
  const p = classifyPort({ path: "COM3", serialNumber: "5&2a6e7e8c&0&3", pnpId: "USB\\VID_1A86&PID_7523\\5&2A6E7E8C&0&3" });
  assert.equal(p.vendorId, "1a86");
  assert.equal(p.productId, "7523");
  assert.equal(p.fingerprintSource, "instance");
  assert.equal(p.fingerprint, "usb:1a86:7523:inst:5&2A6E7E8C&0&3");
});

test("PL2303 y CP210x se reconocen por VID/PID (también solo desde el pnpId)", () => {
  const pl = classifyPort({ path: "COM4", pnpId: "USB\\VID_067B&PID_2303\\6&1D2C3B4A&0&2", locationId: "Port_#0002.Hub_#0003" });
  assert.equal(pl.chip, "pl2303");
  assert.equal(pl.chipLabel, "PL2303");
  assert.ok(pl.notes.some((n) => /ya no se admite/.test(n)));
  const cp = classifyPort({ path: "COM6", vendorId: "10c4", productId: "ea60", serialNumber: "0001", pnpId: "USB\\VID_10C4&PID_EA60\\0001" });
  assert.equal(cp.chip, "cp210x");
  assert.equal(cp.fingerprintSource, "serial");
  assert.equal(cp.fingerprint, "usb:10c4:ea60:sn:0001");
});

test("serie sacada del pnpId cuando serialport no la informa", () => {
  const p = classifyPort({ path: "COM8", pnpId: "USB\\VID_10C4&PID_EA60\\XYZ123" });
  assert.equal(p.serialNumber, "XYZ123");
  assert.equal(p.fingerprintSource, "serial");
});

test("Bluetooth saliente: huella por dirección del equipo emparejado", () => {
  const p = classifyPort({
    path: "COM11",
    pnpId: "BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0002\\7&1A2B3C4D&0&001122AABBCC_C00000000",
  });
  assert.equal(p.kind, "bluetooth");
  assert.equal(p.chip, "bluetooth");
  assert.equal(p.bluetoothDirection, "outgoing");
  assert.equal(p.bluetoothAddress, "001122AABBCC");
  assert.equal(p.fingerprint, "bt:001122AABBCC");
});

test("Bluetooth entrante (dirección en cero): se avisa que no sirve", () => {
  const p = classifyPort({
    path: "COM12",
    pnpId: "BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\7&1A2B3C4D&0&000000000000_00000000",
  });
  assert.equal(p.bluetoothDirection, "incoming");
  assert.equal(p.fingerprint, "path:COM12");
  assert.ok(p.notes.some((n) => /ENTRANTE/.test(n)));
});

test("COM de la placa madre y puertos virtuales", () => {
  const builtin = classifyPort({ path: "COM1", pnpId: "ACPI\\PNP0501\\0", manufacturer: "(Standard port types)" });
  assert.equal(builtin.kind, "builtin");
  assert.equal(builtin.fingerprint, "path:COM1");
  const virt = classifyPort({ path: "COM20", pnpId: "ROOT\\PORTS\\0000", friendlyName: "com0com - serial port emulator" });
  assert.equal(virt.kind, "virtual");
});

test("adaptador USB de otra marca", () => {
  const p = classifyPort({ path: "COM9", vendorId: "2341", productId: "0043", serialNumber: "85735313932351F0E1A1" });
  assert.equal(p.chip, "other");
  assert.equal(p.chipLabel, "USB 2341:0043");
  assert.equal(p.fingerprintSource, "serial");
});

test("isRealSerialNumber descarta ids inventados y ceros", () => {
  assert.equal(isRealSerialNumber("A50285BI"), true);
  assert.equal(isRealSerialNumber("5&2a6e7e8c&0&3"), false);
  assert.equal(isRealSerialNumber("0000"), false);
  assert.equal(isRealSerialNumber(""), false);
  assert.equal(isRealSerialNumber(undefined), false);
});

test("classifyPorts ordena por número de COM y normaliza \\\\.\\COM10", () => {
  const list = classifyPorts([{ path: "\\\\.\\COM10" }, { path: "COM2" }, { path: "com1" }, { path: "" }]);
  assert.deepEqual(list.map((p) => p.path), ["COM1", "COM2", "COM10"]);
});

test("discoverPorts no tira excepción si el listador falla", async () => {
  const broken = { list: async () => Promise.reject(new Error("módulo nativo ausente")) };
  const r = await discoverPorts(broken);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ports, []);
  assert.match(r.error ?? "", /módulo nativo ausente/);
  const ok = await discoverPorts(new StaticPortLister([{ path: "COM3", vendorId: "1a86", productId: "7523" }]));
  assert.equal(ok.ok, true);
  assert.equal(ok.ports[0].chipLabel, "CH340");
});
