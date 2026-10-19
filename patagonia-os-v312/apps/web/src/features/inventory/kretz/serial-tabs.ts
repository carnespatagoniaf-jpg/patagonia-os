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

/**
 * Módulos que dejan un puerto abierto CON el lector tomado (Mostrador ↔ Systel: lee los tickets por cable) y por
 * eso no se pueden cerrar desde afuera. Se anotan acá con una función que suelta el puerto cuando no están en
 * medio de una operación; la próxima vez lo vuelven a abrir solos. Real (Los gringos, 19/10/2026): con Mostrador
 * abierto en otra ventana, "Mi balanza" daba siempre "la balanza está abierta en otra pestaña".
 */
const holders = new Set<() => Promise<number>>();

/** Anota quién tiene un puerto tomado. `release` suelta (cuando termina lo que esté haciendo) y dice cuántos cerró. */
export function registerSerialHolder(release: () => Promise<number>): () => void {
  holders.add(release);
  return () => holders.delete(release);
}

/** Pide a los módulos de ESTA pestaña que suelten sus puertos. */
export async function releaseLocalHolders(): Promise<number> {
  let released = 0;
  for (const h of [...holders]) {
    try {
      released += await h();
    } catch {
      // si uno no puede soltar, siguen los demás
    }
  }
  return released;
}

/**
 * Antes de abrir un puerto para conectar una balanza: que lo suelten esta pestaña y las demás de Patagonia.
 * Devuelve lo que contestaron las otras pestañas (para el reporte y para saber si el puerto lo tiene OTRO programa).
 */
export async function releaseSerialEverywhere(waitMs = 700): Promise<{ localReleased: number; otherTabs: TabAnswer[] }> {
  const localReleased = await releaseLocalHolders();
  const otherTabs = await askOtherTabs("release", waitMs);
  return { localReleased, otherTabs };
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
      const fromHolders = msg.type === "release" ? await releaseLocalHolders() : 0;
      const ports = (await navigator.serial.getPorts()) as unknown as PortLike[];
      const result = await inspectAndRelease(ports, msg.type === "release");
      const answer: Answer = { type: "answer", id: msg.id, tab: TAB_ID, page: pageLabel || "?", ...result, released: result.released + fromHolders };
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
