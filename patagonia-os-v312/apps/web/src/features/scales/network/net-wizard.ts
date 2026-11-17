import type { ScaleChoice } from "../engine/choice";

/**
 * "Conectar balanza por cable de red": la lógica del asistente, sin pantallas (se prueba sola, net-wizard.test.ts).
 *
 * Cómo llega Patagonia a una balanza por red: Chrome no puede abrir una conexión de red con un aparato, así que lo hace
 * el programa de Patagonia en la PC (public/patagonia-print-agent.ps1, versión 6 o más). El programa busca en la red
 * de cada placa de la PC las direcciones que atienden en los puertos de balanza, y dice qué placas con cable tiene y si
 * están prendidas (luz del cable). Con eso este archivo decide qué le pasa al local y qué le dice, sin palabras técnicas.
 *
 * Lo que dice "FALTA PROBAR CON LA BALANZA" no se comprobó con una balanza real por red (ver docs/BALANZAS_POR_RED.md).
 */

/** Versión del programa de la PC que trae la búsqueda de varias marcas y el estado del cable. */
export const WIZARD_AGENT_VERSION = 6;

/** Puerto de fábrica de cada marca por red. */
export const KRETZ_PORT = 1001;
export const SYSTEL_PORT = 10001;

export type NetBrandId = "kretz-report" | "systel-cuora-max" | "kretz-aura" | "systel-cuora-neo" | "otra" | "auto";

/** Qué hace el asistente con cada marca: por red, por USB (no tiene red), con un archivo, o pide una foto. */
export type NetBrandPath = "red" | "usb" | "archivo" | "foto";

export interface NetBrand {
  id: NetBrandId;
  label: string;
  /** Cómo reconocerla, en una línea. */
  hint: string;
  path: NetBrandPath;
  /** Puertos donde se busca (vacío si no va por red). */
  ports: number[];
  /** Con qué marca la conecta "Mis balanzas" una vez encontrada. */
  choice: ScaleChoice | null;
  /** Dónde está la dirección (IP) en el menú de ESA balanza. */
  menu: { path: string; fixed: string; checked: boolean } | null;
}

export const NET_BRANDS: NetBrand[] = [
  {
    id: "kretz-report",
    label: "Kretz Report (NX / NX2)",
    hint: "Dice REPORT arriba de la pantalla. Tiene un conector de red atrás, abajo, con una luz amarilla.",
    path: "red",
    ports: [KRETZ_PORT],
    choice: "kretz-report",
    // Manual oficial "MANUAL DE USO REPORT NX / LT" (Help Desk Kretz): menú Configuración de Red = NRO BALANZA, IP, PUERTO.
    menu: {
      path: "Menú de la balanza → Configuración de Red → IP",
      fixed: "En Configuración de Red, dejá escrita la IP (que no diga automática ni DHCP).",
      checked: false
    }
  },
  {
    id: "systel-cuora-max",
    label: "Systel Cuora Max",
    hint: "Dice CUORA MAX. La versión con red tiene un conector de red atrás.",
    path: "red",
    ports: [SYSTEL_PORT],
    choice: "systel",
    // docs/SYSTEL_INFORME.md: módulo de red Lantronix, puerto 10001. El menú de la IP no está en los documentos que tenemos.
    menu: {
      path: "Menú 11 (Comunicaciones) de la balanza → Red → IP",
      fixed: "En el menú de red, dejá escrita la IP (que no diga automática ni DHCP).",
      checked: false
    }
  },
  {
    id: "kretz-aura",
    label: "Kretz Aura",
    hint: "Kretz chica, la Aura o Aura Eco.",
    path: "usb",
    ports: [],
    choice: "kretz-aura",
    menu: null
  },
  {
    id: "systel-cuora-neo",
    label: "Systel Cuora Neo",
    hint: "Systel con pantalla táctil grande.",
    path: "archivo",
    ports: [],
    choice: null,
    menu: null
  },
  {
    id: "otra",
    label: "Otra marca",
    hint: "Una balanza que no está en esta lista.",
    path: "foto",
    ports: [],
    choice: null,
    menu: null
  },
  {
    id: "auto",
    label: "No sé cuál es",
    hint: "Patagonia la busca sola en la red y la reconoce.",
    path: "red",
    ports: [KRETZ_PORT, SYSTEL_PORT],
    choice: null,
    menu: null
  }
];

export function netBrand(id: NetBrandId): NetBrand {
  return NET_BRANDS.find((b) => b.id === id) ?? NET_BRANDS[NET_BRANDS.length - 1];
}

/** La marca según el puerto en el que atendió (así se reconoce sola con "No sé cuál es"). */
export function brandForPort(port: number): "kretz-report" | "systel-cuora-max" | null {
  if (port === SYSTEL_PORT) return "systel-cuora-max";
  if (port >= 1000 && port <= 1099) return "kretz-report";
  return null;
}

// ── Lo que contesta el programa de la PC ────────────────────────────────────────────────────────────────────

export interface PcAddress {
  name: string;
  kind: string;
  ip: string;
  mask: string;
}

export interface WiredNic {
  name: string;
  description: string;
  /** Placa prendida = el cable está enchufado en los dos lados y lo de la otra punta está prendido. */
  up: boolean;
  ips: { ip: string; mask: string }[];
}

export interface FoundScale {
  ip: string;
  port: number;
}

export interface SearchResult {
  scales: FoundScale[];
  local: PcAddress[];
  wired: WiredNic[];
}

/** La respuesta de /scale/find de cualquier versión del programa (la 4 y 5 traen solo IP del puerto pedido). */
export function parseFindResponse(body: unknown, askedPorts: number[]): SearchResult {
  const b = (body ?? {}) as { scales?: unknown; found?: unknown; local?: unknown; wired?: unknown; port?: unknown };
  const asList = (x: unknown): unknown[] => (Array.isArray(x) ? x : x && typeof x === "object" ? [x] : []);
  let scales: FoundScale[] = asList(b.scales)
    .map((s) => s as { ip?: unknown; port?: unknown })
    .filter((s) => typeof s.ip === "string" && Number.isInteger(Number(s.port)))
    .map((s) => ({ ip: String(s.ip), port: Number(s.port) }));
  if (!scales.length) {
    const port = Number.isInteger(Number(b.port)) ? Number(b.port) : askedPorts[0] ?? KRETZ_PORT;
    scales = asList(b.found).filter((ip): ip is string => typeof ip === "string").map((ip) => ({ ip, port }));
  }
  const local = asList(b.local).map((l) => l as PcAddress).filter((l) => typeof l?.ip === "string");
  const wired = asList(b.wired)
    .map((w) => w as WiredNic)
    .filter((w) => typeof w?.name === "string")
    .map((w) => ({ name: w.name, description: w.description ?? "", up: !!w.up, ips: asList(w.ips).map((i) => i as { ip: string; mask: string }).filter((i) => typeof i?.ip === "string") }));
  return { scales: dedupe(scales), local, wired };
}

function dedupe(list: FoundScale[]): FoundScale[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.ip}:${s.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Direcciones ─────────────────────────────────────────────────────────────────────────────────────────────

function ipBytes(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x >= 0 && x <= 255) ? b : null;
}

/** Dirección "de emergencia" que se pone Windows cuando nadie le da una (cable directo a la balanza, sin router). */
export function isSelfAssigned(ip: string): boolean {
  return ip.startsWith("169.254.");
}

export function inSameNetwork(a: string, b: string, mask: string): boolean {
  const x = ipBytes(a);
  const y = ipBytes(b);
  const m = ipBytes(mask);
  return !!x && !!y && !!m && x.every((v, i) => (v & m[i]) === (y[i] & m[i]));
}

/**
 * Una IP libre para la balanza en la red de la PC: misma red, terminada en 200 (o la siguiente libre), nunca la de la
 * PC, ni la .1 (suele ser el router), ni la de otra balanza encontrada.
 */
export function suggestScaleIp(pcIp: string, avoid: string[] = []): string | null {
  const b = ipBytes(pcIp);
  if (!b) return null;
  const taken = new Set([pcIp, ...avoid]);
  for (const last of [200, 201, 202, 203, 204, 205, 210, 220, 230, 240, 150, 100]) {
    const ip = `${b[0]}.${b[1]}.${b[2]}.${last}`;
    if (!taken.has(ip)) return ip;
  }
  return null;
}

/** La IP como la escribe la gente (coma del teclado numérico, espacios): "192,168,1,50" → "192.168.1.50". */
export function normalizeIp(text: string): string {
  return text.trim().replace(/\s*[,;]\s*|\s*\.\s*|\s+/g, ".");
}

export function isValidIp(text: string): boolean {
  return ipBytes(text) !== null;
}

// ── El programa de la PC ────────────────────────────────────────────────────────────────────────────────────

export type AgentStatus = "sin_programa" | "bloqueado" | "viejo" | "listo";

/**
 * version null = la página no pudo hablar con el programa. Puede ser que no esté corriendo o que Chrome no deje
 * (permiso "red local" bloqueado): se distingue con el permiso de Chrome cuando lo informa, y si no, con la prueba de
 * abrir http://127.0.0.1:9101/ping en una pestaña (eso Chrome no lo bloquea).
 */
export function agentStatus(version: number | null, chromePermission: PermissionState | null): AgentStatus {
  if (version === null) return chromePermission === "denied" ? "bloqueado" : "sin_programa";
  if (version < WIZARD_AGENT_VERSION) return "viejo";
  return "listo";
}

// ── Qué le pasa al local ────────────────────────────────────────────────────────────────────────────────────

/** Dónde dijo la persona que enchufó la otra punta del cable. */
export type CableTo = "pc" | "router" | "no_se";

export type Situation =
  /** Encontró balanzas: cada una con su marca reconocida por el puerto. */
  | { kind: "encontradas"; scales: (FoundScale & { brand: "kretz-report" | "systel-cuora-max" | null })[]; otherBrand: boolean }
  /** El cable va a la PC y la placa está apagada: la luz al lado del cable está apagada. */
  | { kind: "sin_luz" }
  /** La PC no tiene entrada de cable de red (o Windows no la ve). */
  | { kind: "sin_placa" }
  /** Cable directo a la PC, sin router: la PC se puso una dirección de emergencia; la balanza tiene que ir a esa red. */
  | { kind: "cable_directo"; pcIp: string; suggestIp: string; mask: string }
  /** La PC no está en ninguna red (ni cable ni WiFi). */
  | { kind: "pc_sin_red" }
  /** No apareció: puede estar apagada o en otra red. Se pide la IP del menú (último recurso). */
  | { kind: "nada"; pcNetworks: string[] };

export function analyzeSearch(input: { brand: NetBrandId; cableTo: CableTo; result: SearchResult }): Situation {
  const { brand, cableTo, result } = input;
  const wanted = netBrand(brand).ports;
  if (result.scales.length) {
    const scales = [...result.scales]
      .map((s) => ({ ...s, brand: brandForPort(s.port) }))
      // Primero las de la marca elegida.
      .sort((a, b) => Number(!wanted.includes(a.port)) - Number(!wanted.includes(b.port)) || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
    return { kind: "encontradas", scales, otherBrand: brand !== "auto" && !scales.some((s) => wanted.includes(s.port)) };
  }
  const wiredUp = result.wired.filter((w) => w.up);
  const lan = result.local.filter((l) => !isSelfAssigned(l.ip));
  // Cable directo a la PC: la placa con cable prendida pero sin dirección de verdad (nadie se la dio: no hay router).
  const direct = wiredUp.find((w) => w.ips.length > 0 && w.ips.every((i) => isSelfAssigned(i.ip)));
  if (cableTo !== "router" && direct) {
    const pcIp = direct.ips[0].ip;
    return { kind: "cable_directo", pcIp, suggestIp: suggestScaleIp(pcIp) ?? "169.254.1.200", mask: "255.255.0.0" };
  }
  if (cableTo === "pc") {
    if (result.wired.length === 0) return { kind: "sin_placa" };
    if (wiredUp.length === 0) return { kind: "sin_luz" };
  }
  if (result.local.length === 0 && wiredUp.length === 0) return { kind: "pc_sin_red" };
  return { kind: "nada", pcNetworks: lan.map((l) => l.ip) };
}

/**
 * La IP que escribió la persona no contesta: si está en otra red que la PC, qué IP y máscara ponerle a la balanza
 * (con la ruta del menú de ESA marca); si está en la misma red, qué revisar.
 */
export function unreachableAdvice(host: string, brand: NetBrandId, result: Pick<SearchResult, "local">): { otherNetwork: boolean; text: string; suggestIp: string | null; mask: string | null } {
  const lan = result.local.filter((l) => isValidIp(l.ip));
  const same = lan.find((l) => inSameNetwork(host, l.ip, l.mask));
  const menu = netBrand(brand).menu;
  if (lan.length && !same) {
    const pc = lan.find((l) => !isSelfAssigned(l.ip) && /ethernet/i.test(l.kind)) ?? lan.find((l) => !isSelfAssigned(l.ip)) ?? lan[0];
    const suggestIp = isSelfAssigned(pc.ip) ? suggestScaleIp(pc.ip) : suggestScaleIp(pc.ip, [host]);
    const mask = isSelfAssigned(pc.ip) ? "255.255.0.0" : pc.mask;
    return {
      otherNetwork: true,
      suggestIp,
      mask,
      text: `La balanza tiene la dirección ${host}, que es de otra red: esta computadora está en ${pc.ip}. Cambiale la dirección a la balanza: ${menu ? `${menu.path}, ` : "en su menú de red, "}poné ${suggestIp} y en máscara ${mask}. Después tocá BUSCAR DE NUEVO.`
    };
  }
  return {
    otherNetwork: false,
    suggestIp: null,
    mask: null,
    text: `La balanza no contesta en ${host}. Revisá que esté prendida, que la luz al lado del cable esté prendida y que la dirección sea la misma que dice ${menu ? menu.path : "el menú de red de la balanza"}.`
  };
}

/** Los textos de cada situación, en palabras del local. */
export function situationText(s: Situation, brand: NetBrandId): { title: string; steps: string[] } {
  const menu = netBrand(brand).menu;
  switch (s.kind) {
    case "encontradas":
      return {
        title: s.scales.length === 1 ? "Encontramos tu balanza" : `Encontramos ${s.scales.length} balanzas`,
        steps: s.otherBrand ? ["No es la marca que elegiste: Patagonia la reconoció por cómo contesta. Si es tu balanza, conectala igual."] : []
      };
    case "sin_luz":
      return {
        title: "La luz al lado del cable está apagada",
        steps: [
          "Fijate que la balanza esté prendida.",
          "Sacá el cable de la balanza y volvé a ponerlo hasta que haga clic. Lo mismo del lado de la computadora.",
          "La luz al lado del cable tiene que prenderse (en la balanza y en la computadora). Si no se prende con otro cable, el cable está roto.",
          "Cuando la luz esté prendida, tocá BUSCAR DE NUEVO."
        ]
      };
    case "sin_placa":
      return {
        title: "Esta computadora no tiene entrada para el cable de red",
        steps: ["Enchufá el cable de la balanza en el router o módem del local (la cajita de internet), no en la computadora.", "Después tocá BUSCAR DE NUEVO."]
      };
    case "cable_directo":
      return {
        title: "El cable va directo de la balanza a la computadora",
        steps: [
          "Así anda, pero la balanza tiene que tener una dirección de la misma red que la computadora.",
          `En la balanza: ${menu ? menu.path : "menú de red → IP"}. Poné la IP ${s.suggestIp} y en máscara ${s.mask}.`,
          "Guardá, apagá la balanza y volvé a prenderla.",
          "Tocá BUSCAR DE NUEVO.",
          "Otra opción más simple: enchufar la balanza en el router o módem del local en vez de la computadora."
        ]
      };
    case "pc_sin_red":
      return {
        title: "Esta computadora no está conectada a ninguna red",
        steps: ["Fijate que la computadora tenga internet (cable o WiFi).", "Enchufá la balanza en el mismo router o módem.", "Tocá BUSCAR DE NUEVO."]
      };
    case "nada":
      return {
        title: "No encontramos la balanza",
        steps: [
          "Fijate que la balanza esté prendida y que la luz al lado del cable esté prendida.",
          "Si la luz está apagada: sacá el cable y volvé a ponerlo hasta que haga clic.",
          "Esperá un minuto después de prender la balanza y tocá BUSCAR DE NUEVO.",
          `Si sigue sin aparecer, buscá la dirección en ${menu ? menu.path : "el menú de red de la balanza"} y escribila abajo.`
        ]
      };
  }
}

/** Para que mañana la encuentre igual: dejar la IP fija en la balanza. */
export function fixedIpTip(brand: NetBrandId, ip: string): string {
  const menu = netBrand(brand).menu;
  return `Para que mañana la encuentre igual: ${menu ? menu.fixed : "en el menú de red de la balanza, dejá escrita la IP (que no diga automática ni DHCP)."} Tiene que quedar ${ip}. Si dos balanzas tienen la misma dirección, ninguna anda bien: cada una la suya.`;
}

/** Nombre para una balanza nueva que no repite los que ya hay ("Mostrador 1", "Mostrador 2"…). */
export function nextScaleName(existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  for (let i = 1; i < 100; i++) {
    const name = `Mostrador ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return "Balanza";
}

/** Todo lo que necesita soporte para entender un intento, sin pedirle nada al cliente. */
export function netDiagnostic(input: {
  brand: NetBrandId;
  cableTo: CableTo | null;
  agentVersion: number | null;
  chromePermission: PermissionState | null;
  askedPorts: number[];
  result: SearchResult | null;
  situation: Situation | null;
  typedIp: string | null;
  lastError: string | null;
}): Record<string, unknown> {
  return {
    asistente: "balanza por cable de red",
    marca_elegida: input.brand,
    cable_va_a: input.cableTo,
    programa_pc_version: input.agentVersion,
    permiso_red_local_chrome: input.chromePermission,
    puertos_probados: input.askedPorts,
    balanzas_encontradas: input.result?.scales ?? null,
    direcciones_pc: input.result?.local ?? null,
    placas_con_cable: input.result?.wired ?? null,
    situacion: input.situation?.kind ?? null,
    ip_escrita: input.typedIp,
    error: input.lastError
  };
}
