/**
 * Cliente del "programa de impresión" local (public/patagonia-print-agent.ps1,
 * se instala con instalar-impresora.bat). Es la forma de imprimir tickets que
 * funciona con cualquier térmica ESC/POS de cualquier marca: el programa
 * escucha solo en esta PC (127.0.0.1:9101) y manda los bytes que arma el
 * sistema directo a la cola de Windows en modo RAW, sin depender del driver
 * de la impresora (que es justo lo que falla con WebUSB y con el diálogo de
 * impresión cuando Windows le pone un driver genérico equivocado).
 *
 * Esta parte no importa nada de Supabase ni del DOM más que fetch/localStorage,
 * para poder probar la elección de impresora con node --test.
 */

export const AGENT_URL = "http://127.0.0.1:9101";

export interface AgentPrinter {
  name: string;
  isDefault: boolean;
  port: string;
  driver: string;
  driverMajor: number;
  isPhysical: boolean;
}

const PRINTER_KEY = "patagonia-agent-printer";

/** Nombres típicos de impresoras de tickets -- para elegir sola la térmica
 * cuando la PC tiene más de una impresora (ej. una láser de oficina). */
const THERMAL_NAME = /pos|thermal|term[ií]ca|receipt|ticket|\btp[0-9]|unnion|xprinter|epson tm|bixolon|star |203dpi|rongta|hasar|3nstar|zjiang|58mm|80mm/i;

/** Devuelve la impresora que casi seguro es la térmica, o null si hay que
 * preguntarle al usuario. Solo mira impresoras físicas. */
export function pickLikelyThermal(printers: AgentPrinter[]): AgentPrinter | null {
  const physical = printers.filter((p) => p.isPhysical);
  if (physical.length === 0) return null;
  const byName = physical.filter((p) => THERMAL_NAME.test(p.name) || THERMAL_NAME.test(p.driver));
  if (byName.length === 1) return byName[0];
  if (byName.length === 0 && physical.length === 1) return physical[0];
  return null;
}

export function getAgentPrinterName(): string {
  try {
    return localStorage.getItem(PRINTER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAgentPrinterName(name: string): void {
  try {
    if (name) localStorage.setItem(PRINTER_KEY, name);
    else localStorage.removeItem(PRINTER_KEY);
  } catch {
    // sin localStorage no se recuerda la elección, pero el ticket sale igual.
  }
}

async function agentFetch(path: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(AGENT_URL + path, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let lastUp: number | null = null;

const ENABLED_KEY = "patagonia-agent-enabled";

/** Este navegador ya encontró el programa de impresión alguna vez. Mientras no
 * sea así NO se toca nada de la PC: Chrome nuevo muestra un aviso de "acceso a
 * dispositivos de la red local" la primera vez que un sitio consulta a
 * localhost, y no tiene sentido asustar con eso a un cliente que nunca instaló
 * el programa (ni a uno que no usa térmica). */
export function isAgentEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function markAgentEnabled(): void {
  try {
    localStorage.setItem(ENABLED_KEY, "1");
  } catch {
    // sin localStorage igual funciona en esta sesión
  }
}

/** ¿Está corriendo el programa de impresión en esta PC? Sin `probe` solo se
 * pregunta si este navegador ya lo había encontrado antes; con `probe: true`
 * (lo pide una persona tocando "buscar") se pregunta siempre. Un "sí" se
 * recuerda 4 s para no preguntar dos veces seguidas; un "no" se vuelve a
 * chequear siempre (una conexión rechazada en localhost es instantánea). */
export async function pingPrintAgent(options: { probe?: boolean } = {}): Promise<boolean> {
  if (!options.probe && !isAgentEnabled()) return false;
  if (lastUp !== null && Date.now() - lastUp < 4000) return true;
  try {
    const res = await agentFetch("/ping", undefined, 1500);
    const body = (await res.json()) as { ok?: boolean };
    if (res.ok && body.ok) {
      lastUp = Date.now();
      markAgentEnabled();
      return true;
    }
  } catch {
    // no instalado, apagado, o el navegador bloqueó el acceso local
  }
  lastUp = null;
  return false;
}

export async function listAgentPrinters(): Promise<AgentPrinter[]> {
  const res = await agentFetch("/printers", undefined, 5000);
  const body = (await res.json()) as { ok?: boolean; printers?: AgentPrinter[]; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? "No se pudo leer la lista de impresoras.");
  return body.printers ?? [];
}

/** Manda los bytes a la impresora elegida. Si todavía no eligió ninguna
 * intenta elegir sola la térmica; si no puede, pide que la elija. */
export async function printViaAgent(bytes: Uint8Array): Promise<void> {
  let name = getAgentPrinterName();
  if (!name) {
    const likely = pickLikelyThermal(await listAgentPrinters());
    if (!likely) throw new Error("Elegí tu impresora de tickets en la Configuración de Mostrador (engranaje arriba a la derecha).");
    name = likely.name;
    setAgentPrinterName(name);
  }
  const res = await agentFetch(
    `/print?printer=${encodeURIComponent(name)}`,
    { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([bytes as unknown as BlobPart]) },
    10000
  );
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? "El programa de impresión no pudo imprimir el ticket.");
}
