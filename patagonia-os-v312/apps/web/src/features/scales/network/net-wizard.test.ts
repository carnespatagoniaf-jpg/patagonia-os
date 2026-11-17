import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addressAdvice,
  agentStatus,
  brandForPort,
  choiceForPort,
  inSameNetwork,
  normalizeIp,
  parseFindResponse,
  quickResult,
  stepText,
  suggestScaleIp,
  NO_SCALE_STEPS,
  type SearchResult,
  type WiredNic
} from "./net-wizard";

/** Respuesta REAL del programa versión 6 en una PC con WiFi y la placa de cable desenchufada (17/11/2026). */
const REAL_V6_BODY = {
  port: 1001,
  found: ["192.168.0.153"],
  wired: [{ ips: [{ mask: "255.255.0.0", ip: "169.254.192.244" }], description: "Realtek PCIe GbE Family Controller", name: "Ethernet", up: false }],
  ok: true,
  local: [{ ip: "192.168.0.153", name: "Wi-Fi", mask: "255.255.255.0", kind: "Wireless80211" }],
  ports: [1001, 10001],
  scales: [
    { ip: "192.168.0.153", port: 1001 },
    { ip: "192.168.0.153", port: 10001 }
  ]
};

const wifi = { name: "Wi-Fi", kind: "Wireless80211", ip: "192.168.0.153", mask: "255.255.255.0" };
const wiredUp = (ip: string): WiredNic => ({ name: "Ethernet", up: true, ips: [{ ip, mask: "255.255.0.0" }] });
const wiredDown: WiredNic = { name: "Ethernet", up: false, ips: [] };
const r = (over: Partial<SearchResult> = {}): SearchResult => ({ scales: [], local: [], wired: [], ...over });

describe("búsqueda: lo que contesta el programa de la PC", () => {
  it("versión 6: balanzas con su puerto y estado del cable", () => {
    const x = parseFindResponse(REAL_V6_BODY, [1001, 10001]);
    assert.deepEqual(x.scales, [
      { ip: "192.168.0.153", port: 1001 },
      { ip: "192.168.0.153", port: 10001 }
    ]);
    assert.equal(x.wired[0].up, false);
  });

  it("versión 4/5: solo IP del puerto pedido", () => {
    assert.deepEqual(parseFindResponse({ port: 1001, found: ["192.168.1.50"], local: [wifi] }, [1001]).scales, [{ ip: "192.168.1.50", port: 1001 }]);
  });

  it("lista de uno como objeto suelto (PowerShell), repetidas y basura", () => {
    assert.deepEqual(parseFindResponse({ scales: { ip: "10.0.0.9", port: 10001 } }, [10001]).scales, [{ ip: "10.0.0.9", port: 10001 }]);
    assert.equal(parseFindResponse({ scales: [{ ip: "1.1.1.1", port: 1001 }, { ip: "1.1.1.1", port: 1001 }] }, [1001]).scales.length, 1);
    assert.deepEqual(parseFindResponse(null, [1001]), { scales: [], local: [], wired: [] });
  });
});

describe("conexión sola: qué hacer con lo encontrado", () => {
  it("UNA balanza: se conecta sola, con la marca por el puerto", () => {
    const q = quickResult(r({ scales: [{ ip: "192.168.19.170", port: 1001 }] }));
    assert.deepEqual(q, { kind: "una", scale: { ip: "192.168.19.170", port: 1001 } });
    assert.equal(choiceForPort(1001), "kretz-report");
    assert.equal(choiceForPort(10001), "systel");
  });

  it("VARIAS: se elige, ordenadas por dirección", () => {
    const q = quickResult(parseFindResponse({ scales: [{ ip: "192.168.0.20", port: 10001 }, { ip: "192.168.0.3", port: 1001 }] }, [1001, 10001]));
    assert.equal(q.kind, "varias");
    if (q.kind === "varias") assert.deepEqual(q.scales.map((s) => s.ip), ["192.168.0.3", "192.168.0.20"]);
  });

  it("NINGUNA: pasos en el orden pedido (luz, prendida, dirección)", () => {
    assert.deepEqual(quickResult(r()), { kind: "ninguna" });
    assert.deepEqual([...NO_SCALE_STEPS], ["luz", "prendida", "red"]);
  });

  it("un puerto que no es de balanza no cuenta", () => {
    assert.equal(brandForPort(80), null);
    assert.deepEqual(quickResult(r({ scales: [{ ip: "1.1.1.1", port: 80 }] })), { kind: "ninguna" });
  });
});

describe("programa de la PC, antes de buscar", () => {
  it("falta, Chrome lo bloquea, viejo, listo", () => {
    assert.equal(agentStatus(null, null), "sin_programa");
    assert.equal(agentStatus(null, "denied"), "bloqueado");
    assert.equal(agentStatus(5, "granted"), "viejo");
    assert.equal(agentStatus(6, "prompt"), "listo");
  });
});

describe("redes distintas: la IP exacta para la balanza", () => {
  it("con router: misma red que la PC, terminada en 200", () => {
    assert.deepEqual(addressAdvice(r({ local: [wifi], wired: [wiredDown] })), { ip: "192.168.0.200", mask: "255.255.255.0", direct: false });
  });

  it("cable directo a la PC (El Shopping de la Carne): la red de emergencia de la PC", () => {
    assert.deepEqual(addressAdvice(r({ local: [wifi], wired: [wiredUp("169.254.192.244")] })), { ip: "169.254.192.200", mask: "255.255.0.0", direct: true });
  });

  it("PC sin red: no inventa una dirección", () => {
    assert.equal(addressAdvice(r()), null);
    assert.match(stepText("red", null, null).lines[0], /no está conectada a ninguna red/);
  });

  it("el paso muestra IP, máscara y dónde ponerla", () => {
    const t = stepText("red", { ip: "192.168.0.200", mask: "255.255.255.0", direct: false }, null);
    assert.ok(t.lines.includes("IP: 192.168.0.200"));
    assert.ok(t.lines.includes("Máscara: 255.255.255.0"));
    assert.match(t.lines.join(" "), /Configuración de Red → IP/);
  });

  it("IP libre y misma red", () => {
    assert.equal(suggestScaleIp("192.168.0.200"), "192.168.0.201");
    assert.equal(inSameNetwork("192.168.19.170", "192.168.0.153", "255.255.255.0"), false);
    assert.equal(normalizeIp(" 192,168,19,170 "), "192.168.19.170");
  });
});

describe("textos", () => {
  it("sin palabras técnicas", () => {
    const advice = { ip: "192.168.0.200", mask: "255.255.255.0", direct: true };
    for (const step of NO_SCALE_STEPS) {
      const t = stepText(step, advice, r({ wired: [wiredDown] }));
      const text = [t.title, ...t.lines].join(" ");
      assert.doesNotMatch(text, /TCP|socket|subred|APIPA|ethernet|puerto|timeout|error|DHCP/i, text);
    }
  });
});
