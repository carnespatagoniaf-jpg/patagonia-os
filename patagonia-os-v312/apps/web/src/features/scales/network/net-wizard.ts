import type { ScaleChoice } from "../engine/choice";

/**
 * "Conectar balanza por cable de red", camino corto: busca sola apenas se toca la tarjeta y, si hay UNA balanza, se
 * conecta sola. Solo si no encuentra ninguna muestra pasos, de a uno, y vuelve a buscar sola después de cada uno.
 * Sin pantallas: esto es solo la lógica (net-wizard.test.ts).
 *
 * Chrome no puede abrir una conexión de red con un aparato: lo hace el programa de Patagonia en la PC
 * (public/patagonia-print-agent.ps1, versión 6), que busca en la red de cada placa de la PC las direcciones que
 * atienden en los puertos de balanza. La marca se reconoce por el puerto.
 */

/** Versión del programa de la PC que busca varias marcas a la vez y ve el estado del cable. */
export const WIZARD_AGENT_VERSION = 6;

export const KRETZ_PORT = 1001;
export const SYSTEL_PORT = 10001;
/** Puertos donde se busca: Kretz Report (1001 de fábrica) y Systel Cuora Max (módulo Lantronix, 10001). */
export const SEARCH_PORTS = [KRETZ_PORT, SYSTEL_PORT];

export type NetBrand = "kretz-report" | "systel-cuora-max";

export function brandForPort(port: number): NetBrand | null {
  if (port === SYSTEL_PORT) return "systel-cuora-max";
  if (port >= 1000 && port <= 1099) return "kretz-report";
  return null;
}

export const BRAND_LABEL: Record<NetBrand, string> = { "kretz-report": "Kretz Report", "systel-cuora-max": "Systel Cuora Max" };

/** Con qué marca la conecta "Mis balanzas". */
export function choiceForPort(port: number): ScaleChoice {
  return brandForPort(port) === "systel-cuora-max" ? "systel" : "kretz-report";
}

/**
 * Dónde está la dirección (IP) en el menú de cada balanza. Kretz: manual "Report NX / LT" (menú Configuración de
 * Red: NRO BALANZA, IP, PUERTO). Systel: no está en los documentos que tenemos (FALTA PROBAR CON LA BALANZA).
 */
export const MENU_IP: Record<NetBrand, string> = {
  "kretz-report": "Kretz Report: menú → Configuración de Red → IP",
  "systel-cuora-max": "Systel Cuora Max: menú de Comunicaciones → Red → IP"
};

// ── Lo que contesta el programa de la PC ────────────────────────────────────────────────────────────────────

export interface PcAddress {
  name: string;
  kind: string;
  ip: string;
  mask: string;
}

export interface WiredNic {
  name: string;
  /** Prendida = el cable está enchufado en los dos lados y lo de la otra punta está prendido. */
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

/** La respuesta de /scale/find de cualquier versión del programa (la 4 y la 5 traen solo IP del puerto pedido). */
export function parseFindResponse(body: unknown, askedPorts: number[]): SearchResult {
  const b = (body ?? {}) as { scales?: unknown; found?: unknown; local?: unknown; wired?: unknown; port?: unknown };
  // PowerShell manda una lista de un solo elemento como objeto suelto.
  const asList = (x: unknown): unknown[] => (Array.isArray(x) ? x : x && typeof x === "object" ? [x] : []);
  let scales: FoundScale[] = asList(b.scales)
    .map((s) => s as { ip?: unknown; port?: unknown })
    .filter((s) => typeof s.ip === "string" && Number.isInteger(Number(s.port)))
    .map((s) => ({ ip: String(s.ip), port: Number(s.port) }));
  if (!scales.length) {
    const port = Number.isInteger(Number(b.port)) ? Number(b.port) : askedPorts[0] ?? KRETZ_PORT;
    scales = asList(b.found).filter((ip): ip is string => typeof ip === "string").map((ip) => ({ ip, port }));
  }
  const seen = new Set<string>();
  scales = scales.filter((s) => {
    const k = `${s.ip}:${s.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const local = asList(b.local).map((l) => l as PcAddress).filter((l) => typeof l?.ip === "string");
  const wired = asList(b.wired)
    .map((w) => w as WiredNic)
    .filter((w) => typeof w?.name === "string")
    .map((w) => ({ name: w.name, up: !!w.up, ips: asList(w.ips).map((i) => i as { ip: string; mask: string }).filter((i) => typeof i?.ip === "string") }));
  return { scales, local, wired };
}

// ── El programa de la PC ────────────────────────────────────────────────────────────────────────────────────

export type AgentStatus = "sin_programa" | "bloqueado" | "viejo" | "listo";

/**
 * version null = la página no pudo hablar con el programa: no está corriendo, o Chrome no deja (permiso "red local"
 * bloqueado). Lo primero que se revisa, antes de buscar.
 */
export function agentStatus(version: number | null, chromePermission: PermissionState | null): AgentStatus {
  if (version === null) return chromePermission === "denied" ? "bloqueado" : "sin_programa";
  if (version < WIZARD_AGENT_VERSION) return "viejo";
  return "listo";
}

// ── Qué hacer con lo encontrado ─────────────────────────────────────────────────────────────────────────────

export type QuickResult = { kind: "una"; scale: FoundScale } | { kind: "varias"; scales: FoundScale[] } | { kind: "ninguna" };

/** UNA balanza: se conecta sola. Varias: se elige. Ninguna: pasos. */
export function quickResult(result: SearchResult): QuickResult {
  const scales = result.scales.filter((s) => brandForPort(s.port) !== null);
  if (scales.length === 1) return { kind: "una", scale: scales[0] };
  if (scales.length > 1) return { kind: "varias", scales: [...scales].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }) || a.port - b.port) };
  return { kind: "ninguna" };
}

/** Los pasos cuando no aparece ninguna, en este orden. Después de cada uno se vuelve a buscar sola. */
export const NO_SCALE_STEPS = ["luz", "prendida", "red"] as const;
export type NoScaleStep = (typeof NO_SCALE_STEPS)[number];

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

/** IP libre para la balanza en la red de la PC: terminada en 200 (o la siguiente libre), nunca la de la PC. */
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

export interface AddressAdvice {
  /** La IP exacta para poner en la balanza. */
  ip: string;
  mask: string;
  /** El cable va directo a la PC (sin router): la PC se puso una dirección de emergencia. */
  direct: boolean;
}

/**
 * Qué dirección ponerle a la balanza para que esté en la misma red que la PC. Si el cable va directo a la PC (placa
 * con cable prendida y sin dirección de verdad), la de esa placa; si no, la de la red de la PC (router).
 */
export function addressAdvice(result: Pick<SearchResult, "local" | "wired">): AddressAdvice | null {
  const direct = result.wired.find((w) => w.up && w.ips.length > 0 && w.ips.every((i) => isSelfAssigned(i.ip)));
  if (direct) {
    const ip = suggestScaleIp(direct.ips[0].ip);
    return ip ? { ip, mask: "255.255.0.0", direct: true } : null;
  }
  const lan = result.local.find((l) => !isSelfAssigned(l.ip) && /ethernet/i.test(l.kind)) ?? result.local.find((l) => !isSelfAssigned(l.ip));
  if (!lan) return null;
  const ip = suggestScaleIp(lan.ip);
  return ip ? { ip, mask: lan.mask, direct: false } : null;
}

/** La IP como la escribe la gente (coma del teclado numérico, espacios): "192,168,1,50" → "192.168.1.50". */
export function normalizeIp(text: string): string {
  return text.trim().replace(/\s*[,;]\s*|\s*\.\s*|\s+/g, ".");
}

export function isValidIp(text: string): boolean {
  return ipBytes(text) !== null;
}

// ── Textos ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Cada paso, en palabras del local. */
export function stepText(step: NoScaleStep, advice: AddressAdvice | null, result: Pick<SearchResult, "wired"> | null): { title: string; lines: string[] } {
  switch (step) {
    case "luz": {
      const pcOff = !!result && result.wired.length > 0 && result.wired.every((w) => !w.up);
      return {
        title: "Mirá la luz al lado del cable, en la balanza",
        lines: [
          "Tiene que estar prendida.",
          "Si está apagada: sacá el cable y volvé a ponerlo hasta que haga clic, en la balanza y en la otra punta (router o computadora). Si sigue apagada, probá con otro cable.",
          ...(pcOff ? ["Si el cable va a esta computadora: la computadora tampoco lo ve, así que el problema es el cable o que la balanza está apagada."] : [])
        ]
      };
    }
    case "prendida":
      return { title: "Prendé la balanza", lines: ["Esperá a que muestre el peso en cero. Si ya estaba prendida, apagala y volvé a prenderla."] };
    case "red":
      return {
        title: "Ponele a la balanza esta dirección",
        lines: advice
          ? [
              `IP: ${advice.ip}`,
              `Máscara: ${advice.mask}`,
              `Dónde: ${MENU_IP["kretz-report"]}. ${MENU_IP["systel-cuora-max"]}.`,
              "Guardá y apagá y prendé la balanza.",
              ...(advice.direct ? ["El cable va directo de la balanza a la computadora: también podés enchufarla al router del local y listo."] : [])
            ]
          : ["Esta computadora no está conectada a ninguna red. Enchufala al router del local (o al WiFi) y enchufá la balanza al mismo router."]
      };
  }
}

/** Todo lo que necesita soporte para entender un intento (se manda solo cuando no aparece ninguna). */
export function netDiagnostic(input: {
  agentVersion: number | null;
  chromePermission: PermissionState | null;
  result: SearchResult | null;
  step: NoScaleStep | null;
  searches: number;
  typedIp: string | null;
  lastError: string | null;
}): Record<string, unknown> {
  return {
    asistente: "balanza por cable de red (camino corto)",
    programa_pc_version: input.agentVersion,
    permiso_red_local_chrome: input.chromePermission,
    puertos_probados: SEARCH_PORTS,
    balanzas_encontradas: input.result?.scales ?? null,
    direcciones_pc: input.result?.local ?? null,
    placas_con_cable: input.result?.wired ?? null,
    paso: input.step,
    busquedas: input.searches,
    ip_escrita: input.typedIp,
    error: input.lastError
  };
}
