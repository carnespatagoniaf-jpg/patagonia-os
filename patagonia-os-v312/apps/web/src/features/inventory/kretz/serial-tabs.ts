/**
 * Coordinación del puerto serie entre pestañas de Patagonia OS.
 *
 * Problema real (Aura de una clienta, 2026-10-01/02): Windows contestaba
 * "Failed to open serial port" casi siempre. Un puerto serie lo puede tener
 * abierto UNA sola pestaña/programa a la vez, y Patagonia lo deja abierto
 * después de usarlo (la lectura de peso de Mostrador y el panel de precios).
 * Si la clienta tiene Mostrador en otra pestaña, la prueba no puede abrirlo.
 *
 * Cada pestaña escucha en un BroadcastChannel. "Probar todo":
 * - pregunta quién tiene un puerto abierto ("who"), y
 * - pide soltarlo ("release"): la pestaña cierra los puertos abiertos que NO
 *   estén en uso en ese momento (streams sin bloquear). Uno en uso no se toca.
 * Los módulos que lo usan (scale-serial, scale-weight) lo vuelven a abrir solos
 * la próxima vez (sus ensureOpen miran port.readable).
 *
 * Solo llega a pestañas de este mismo Chrome y perfil: otro perfil de Chrome,
 * otro navegador u otro programa no se pueden ver desde acá.
 */

const CHANNEL = "patagonia-serial";
const TAB_ID = Math.random().toString(36).slice(2, 10);
let pageLabel = "";

export function setSerialTabPage(label: string): void {
  pageLabel = label;
}

export interface TabAnswer {
  tab: string;
  page: string;
  /** Puertos serie abiertos en esa pestaña (antes de soltarlos). */
  openPorts: number;
  released: number;
  /** Abiertos y en uso en ese momento: no se cerraron. */
  busy: number;
}

type Request = { type: "who" | "release"; id: string };
type Answer = TabAnswer & { type: "answer"; id: string };

interface PortLike {
  readable: { locked: boolean } | null;
  writable: { locked: boolean } | null;
  close(): Promise<void>;
}

/** Lógica pura (testeable): cuenta los puertos abiertos y, si se pide, cierra los que no están en uso. */
export async function inspectAndRelease(ports: PortLike[], release: boolean): Promise<{ openPorts: number; released: number; busy: number }> {
  let openPorts = 0;
  let released = 0;
  let busy = 0;
  for (const p of ports) {
    if (!p.readable && !p.writable) continue;
    openPorts++;
    if (!release) continue;
    if (p.readable?.locked || p.writable?.locked) {
      busy++;
      continue;
    }
    try {
      await p.close();
      released++;
    } catch {
      busy++;
    }
  }
  return { openPorts, released, busy };
}

let installed = false;

/** Se instala una vez al cargar la app (main.tsx). */
export function installSerialTabResponder(): void {
  if (installed || typeof window === "undefined" || !("BroadcastChannel" in window) || !("serial" in navigator)) return;
  installed = true;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = async (event: MessageEvent<Request | Answer>) => {
    const msg = event.data;
    if (!msg || (msg.type !== "who" && msg.type !== "release")) return;
    try {
      const ports = (await navigator.serial.getPorts()) as unknown as PortLike[];
      const result = await inspectAndRelease(ports, msg.type === "release");
      const answer: Answer = { type: "answer", id: msg.id, tab: TAB_ID, page: pageLabel || "?", ...result };
      channel.postMessage(answer);
    } catch {
      // sin respuesta de esta pestaña
    }
  };
}

/** Pregunta a las otras pestañas de Patagonia (de este Chrome) y junta respuestas durante `waitMs`. */
export async function askOtherTabs(type: "who" | "release", waitMs = 800): Promise<TabAnswer[]> {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return [];
  const channel = new BroadcastChannel(CHANNEL);
  const id = Math.random().toString(36).slice(2);
  const answers: TabAnswer[] = [];
  channel.onmessage = (event: MessageEvent<Answer>) => {
    const a = event.data;
    if (a?.type === "answer" && a.id === id) answers.push({ tab: a.tab, page: a.page, openPorts: a.openPorts, released: a.released, busy: a.busy });
  };
  channel.postMessage({ type, id } satisfies Request);
  await new Promise((r) => setTimeout(r, waitMs));
  channel.close();
  return answers;
}
