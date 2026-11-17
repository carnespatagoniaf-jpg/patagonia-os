import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentStatus,
  analyzeSearch,
  brandForPort,
  fixedIpTip,
  inSameNetwork,
  netBrand,
  netDiagnostic,
  nextScaleName,
  normalizeIp,
  parseFindResponse,
  situationText,
  suggestScaleIp,
  unreachableAdvice,
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

const wiredUp = (ip: string, mask = "255.255.0.0"): WiredNic => ({ name: "Ethernet", description: "Realtek", up: true, ips: [{ ip, mask }] });
const wiredDown: WiredNic = { name: "Ethernet", description: "Realtek", up: false, ips: [{ ip: "169.254.192.244", mask: "255.255.0.0" }] };
const wifi = { name: "Wi-Fi", kind: "Wireless80211", ip: "192.168.0.153", mask: "255.255.255.0" };
const empty = (over: Partial<SearchResult> = {}): SearchResult => ({ scales: [], local: [], wired: [], ...over });

describe("respuesta del programa de la PC", () => {
  it("lee la versión 6: balanzas con su puerto, placas y estado del cable", () => {
    const r = parseFindResponse(REAL_V6_BODY, [1001, 10001]);
    assert.deepEqual(r.scales, [
      { ip: "192.168.0.153", port: 1001 },
      { ip: "192.168.0.153", port: 10001 }
    ]);
    assert.equal(r.wired.length, 1);
    assert.equal(r.wired[0].up, false);
    assert.equal(r.wired[0].ips[0].ip, "169.254.192.244");
    assert.equal(r.local[0].ip, "192.168.0.153");
  });

  it("lee la versión 4/5 (solo IP del puerto pedido)", () => {
    const r = parseFindResponse({ ok: true, port: 1001, found: ["192.168.1.50"], local: [wifi] }, [1001]);
    assert.deepEqual(r.scales, [{ ip: "192.168.1.50", port: 1001 }]);
    assert.deepEqual(r.wired, []);
  });

  it("aguanta una lista de un solo elemento serializada como objeto (PowerShell lo hace)", () => {
    const r = parseFindResponse({ scales: { ip: "10.0.0.9", port: 10001 }, local: wifi, wired: { name: "Ethernet", up: true, ips: { ip: "10.0.0.2", mask: "255.255.255.0" } } }, [10001]);
    assert.deepEqual(r.scales, [{ ip: "10.0.0.9", port: 10001 }]);
    assert.equal(r.local.length, 1);
    assert.equal(r.wired[0].ips[0].ip, "10.0.0.2");
  });

  it("no repite la misma balanza", () => {
    const r = parseFindResponse({ scales: [{ ip: "1.1.1.1", port: 1001 }, { ip: "1.1.1.1", port: 1001 }] }, [1001]);
    assert.equal(r.scales.length, 1);
  });

  it("respuesta vacía o rara: nada encontrado, sin romperse", () => {
    assert.deepEqual(parseFindResponse(null, [1001]), { scales: [], local: [], wired: [] });
    assert.deepEqual(parseFindResponse({ scales: [{ ip: 5 }] }, [1001]).scales, []);
  });
});

describe("reconocer la marca", () => {
  it("por el puerto en el que atiende", () => {
    assert.equal(brandForPort(1001), "kretz-report");
    assert.equal(brandForPort(1050), "kretz-report");
    assert.equal(brandForPort(10001), "systel-cuora-max");
    assert.equal(brandForPort(80), null);
  });

  it("'No sé cuál es' busca en los puertos de todas las marcas por red", () => {
    assert.deepEqual(netBrand("auto").ports, [1001, 10001]);
    assert.equal(netBrand("kretz-aura").path, "usb");
    assert.equal(netBrand("systel-cuora-neo").path, "archivo");
    assert.equal(netBrand("otra").path, "foto");
  });
});

describe("qué le pasa al local", () => {
  it("encontró: cada balanza con su marca, primero la elegida", () => {
    const s = analyzeSearch({ brand: "systel-cuora-max", cableTo: "router", result: parseFindResponse(REAL_V6_BODY, [10001]) });
    assert.equal(s.kind, "encontradas");
    if (s.kind !== "encontradas") return;
    assert.equal(s.scales[0].brand, "systel-cuora-max");
    assert.equal(s.scales[1].brand, "kretz-report");
    assert.equal(s.otherBrand, false);
  });

  it("encontró otra marca que la elegida: lo avisa pero la muestra", () => {
    const s = analyzeSearch({ brand: "kretz-report", cableTo: "router", result: empty({ scales: [{ ip: "192.168.0.20", port: 10001 }], local: [wifi] }) });
    assert.equal(s.kind, "encontradas");
    if (s.kind === "encontradas") assert.equal(s.otherBrand, true);
    assert.match(situationText(s, "kretz-report").steps[0], /No es la marca que elegiste/);
  });

  it("cable a la PC y la placa apagada: la luz del cable está apagada", () => {
    const s = analyzeSearch({ brand: "kretz-report", cableTo: "pc", result: empty({ local: [wifi], wired: [wiredDown] }) });
    assert.equal(s.kind, "sin_luz");
    assert.match(situationText(s, "kretz-report").steps.join(" "), /hasta que haga clic/);
  });

  it("cable directo sin router (El Shopping de la Carne): sugiere IP y máscara de la red de la PC", () => {
    const s = analyzeSearch({ brand: "kretz-report", cableTo: "pc", result: empty({ local: [wifi, { name: "Ethernet", kind: "Ethernet", ip: "169.254.192.244", mask: "255.255.0.0" }], wired: [wiredUp("169.254.192.244")] }) });
    assert.deepEqual(s, { kind: "cable_directo", pcIp: "169.254.192.244", suggestIp: "169.254.192.200", mask: "255.255.0.0" });
    const text = situationText(s, "kretz-report").steps.join(" ");
    assert.match(text, /Configuración de Red → IP/);
    assert.match(text, /169\.254\.192\.200/);
  });

  it("'No sé' dónde va el cable: igual detecta el cable directo", () => {
    const s = analyzeSearch({ brand: "auto", cableTo: "no_se", result: empty({ wired: [wiredUp("169.254.7.9")] }) });
    assert.equal(s.kind, "cable_directo");
  });

  it("cable al router: la placa de la PC apagada no importa (la PC puede ir por WiFi)", () => {
    const s = analyzeSearch({ brand: "kretz-report", cableTo: "router", result: empty({ local: [wifi], wired: [wiredDown] }) });
    assert.equal(s.kind, "nada");
    if (s.kind === "nada") assert.deepEqual(s.pcNetworks, ["192.168.0.153"]);
  });

  it("cable a la PC pero la PC no tiene entrada de red", () => {
    assert.equal(analyzeSearch({ brand: "kretz-report", cableTo: "pc", result: empty({ local: [wifi] }) }).kind, "sin_placa");
  });

  it("PC sin ninguna red", () => {
    assert.equal(analyzeSearch({ brand: "kretz-report", cableTo: "router", result: empty() }).kind, "pc_sin_red");
  });

  it("no apareció: pide la IP del menú de ESA marca como último recurso", () => {
    const s = analyzeSearch({ brand: "systel-cuora-max", cableTo: "router", result: empty({ local: [wifi] }) });
    assert.equal(s.kind, "nada");
    assert.match(situationText(s, "systel-cuora-max").steps.join(" "), /Menú 11/);
  });
});

describe("sugerir la IP correcta", () => {
  it("misma red que la PC, terminada en 200, sin chocar con la PC ni con otra balanza", () => {
    assert.equal(suggestScaleIp("192.168.0.153"), "192.168.0.200");
    assert.equal(suggestScaleIp("192.168.0.200"), "192.168.0.201");
    assert.equal(suggestScaleIp("192.168.0.153", ["192.168.0.200", "192.168.0.201"]), "192.168.0.202");
    assert.equal(suggestScaleIp("no es ip"), null);
  });

  it("IP escrita en otra red (la de El Shopping, 192.168.19.170 con la PC en 192.168.0.x)", () => {
    const a = unreachableAdvice("192.168.19.170", "kretz-report", { local: [wifi] });
    assert.equal(a.otherNetwork, true);
    assert.equal(a.suggestIp, "192.168.0.200");
    assert.equal(a.mask, "255.255.255.0");
    assert.match(a.text, /Configuración de Red → IP/);
  });

  it("IP escrita con la PC en cable directo: máscara grande de la red de emergencia", () => {
    const a = unreachableAdvice("192.168.19.170", "kretz-report", { local: [{ name: "Ethernet", kind: "Ethernet", ip: "169.254.192.244", mask: "255.255.0.0" }] });
    assert.equal(a.suggestIp, "169.254.192.200");
    assert.equal(a.mask, "255.255.0.0");
  });

  it("IP en la misma red que no contesta: qué revisar, sin cambiar nada", () => {
    const a = unreachableAdvice("192.168.0.50", "kretz-report", { local: [wifi] });
    assert.equal(a.otherNetwork, false);
    assert.match(a.text, /luz al lado del cable/);
  });

  it("misma red según la máscara", () => {
    assert.equal(inSameNetwork("192.168.0.50", "192.168.0.153", "255.255.255.0"), true);
    assert.equal(inSameNetwork("192.168.19.170", "192.168.0.153", "255.255.255.0"), false);
    assert.equal(inSameNetwork("169.254.1.1", "169.254.200.9", "255.255.0.0"), true);
  });

  it("IP escrita como la escribe la gente", () => {
    assert.equal(normalizeIp(" 192,168,19,170 "), "192.168.19.170");
    assert.equal(normalizeIp("192 . 168 . 1 . 5"), "192.168.1.5");
  });
});

describe("programa de la PC", () => {
  it("no contesta: no instalado, salvo que Chrome diga que lo bloqueó", () => {
    assert.equal(agentStatus(null, null), "sin_programa");
    assert.equal(agentStatus(null, "prompt"), "sin_programa");
    assert.equal(agentStatus(null, "denied"), "bloqueado");
  });

  it("versión vieja (4 y 5 no buscan Systel ni ven el cable) y versión buena", () => {
    assert.equal(agentStatus(5, "granted"), "viejo");
    assert.equal(agentStatus(6, "granted"), "listo");
    assert.equal(agentStatus(7, null), "listo");
  });
});

describe("textos y soporte", () => {
  it("recomienda dejar la IP fija y avisa de dos balanzas con la misma", () => {
    const t = fixedIpTip("kretz-report", "192.168.0.200");
    assert.match(t, /192\.168\.0\.200/);
    assert.match(t, /DHCP/);
    assert.match(t, /misma dirección/);
  });

  it("nombres para varias balanzas: Mostrador 1, Mostrador 2…", () => {
    assert.equal(nextScaleName([]), "Mostrador 1");
    assert.equal(nextScaleName(["Mostrador 1", "mostrador 2"]), "Mostrador 3");
  });

  it("ningún texto para el local usa palabras técnicas", () => {
    const situations = [
      analyzeSearch({ brand: "kretz-report", cableTo: "pc", result: empty({ wired: [wiredDown], local: [wifi] }) }),
      analyzeSearch({ brand: "kretz-report", cableTo: "pc", result: empty({ wired: [wiredUp("169.254.1.2")] }) }),
      analyzeSearch({ brand: "kretz-report", cableTo: "pc", result: empty({ local: [wifi] }) }),
      analyzeSearch({ brand: "kretz-report", cableTo: "router", result: empty() }),
      analyzeSearch({ brand: "kretz-report", cableTo: "router", result: empty({ local: [wifi] }) })
    ];
    for (const s of situations) {
      const text = [situationText(s, "kretz-report").title, ...situationText(s, "kretz-report").steps].join(" ");
      assert.doesNotMatch(text, /TCP|socket|subred|subnet|APIPA|ethernet|puerto|timeout|error/i, text);
    }
  });

  it("el diagnóstico junta todo lo que pide soporte", () => {
    const result = parseFindResponse(REAL_V6_BODY, [1001, 10001]);
    const d = netDiagnostic({ brand: "auto", cableTo: "pc", agentVersion: 6, chromePermission: "granted", askedPorts: [1001, 10001], result, situation: analyzeSearch({ brand: "auto", cableTo: "pc", result }), typedIp: null, lastError: null });
    assert.equal(d.programa_pc_version, 6);
    assert.deepEqual(d.puertos_probados, [1001, 10001]);
    assert.equal(d.situacion, "encontradas");
    assert.ok(Array.isArray(d.placas_con_cable));
  });
});
