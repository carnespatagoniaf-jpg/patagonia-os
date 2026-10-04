import type { SystelClient } from "./systel-client";
import type { PluListEntry, SystelLayout, SystelPlu, SystelSignature } from "./systel-plu";

/**
 * Identificación + respaldo completo de una balanza Systel. SOLO LECTURA
 * (funciones 2, 23, 39, 31 y 62/3). Es lo primero que se hace siempre: sin un
 * respaldo completo y un formato reconocido, Patagonia no escribe nada.
 */

export interface SystelBackup {
  takenAt: string;
  address: number;
  signature: SystelSignature | null;
  ping: { state: "T" | "D" | "S" } | null;
  config: { raw: string; values: Record<string, string> } | null;
  list: PluListEntry[];
  layout: SystelLayout | null;
  /** Lectura completa de cada PLU (el texto tal cual vino, para restaurar a mano si hiciera falta). */
  plus: SystelPlu[];
  /** PLU de la lista que no se pudieron leer. */
  unreadable: number[];
  complete: boolean;
  detail: string;
}

export async function takeSystelBackup(client: SystelClient, onProgress: (text: string) => void = () => {}): Promise<SystelBackup> {
  const backup: SystelBackup = {
    takenAt: new Date().toISOString(),
    address: client.address,
    signature: null,
    ping: null,
    config: null,
    list: [],
    layout: null,
    plus: [],
    unreadable: [],
    complete: false,
    detail: ""
  };
  onProgress("Identificando la balanza…");
  backup.signature = await client.signature();
  backup.ping = await client.ping();
  if (!backup.signature && !backup.ping) {
    backup.detail = "la balanza no contestó (revisá el cable, el puerto y el número de identificación de la balanza)";
    return backup;
  }
  onProgress("Leyendo la configuración…");
  backup.config = await client.config();
  onProgress("Leyendo la lista de productos…");
  const list = await client.list();
  if (!list) {
    backup.detail = "no se pudo leer la lista de productos";
    return backup;
  }
  backup.list = list.entries;
  if (list.entries.length === 0 || list.digits === null) {
    backup.complete = true;
    backup.detail = "la balanza no tiene productos: cargá uno a mano para que Patagonia reconozca el formato";
    return backup;
  }
  const detected = await client.detectLayout(list.entries[0].number, list.digits);
  if (!detected.layout) {
    backup.detail = `no se reconoció el formato de los productos (${detected.detail})`;
    return backup;
  }
  backup.layout = detected.layout;
  for (const [i, entry] of list.entries.entries()) {
    if (i % 20 === 0) onProgress(`Respaldando productos: ${i} de ${list.entries.length}…`);
    const plu = i === 0 && detected.plu.number === entry.number ? detected.plu : await client.readPlu(detected.layout, entry.number);
    if (plu) backup.plus.push(plu);
    else backup.unreadable.push(entry.number);
  }
  backup.complete = backup.unreadable.length === 0;
  backup.detail = backup.complete ? `${backup.plus.length} productos respaldados` : `no se pudieron leer ${backup.unreadable.length} productos (${backup.unreadable.slice(0, 10).join(", ")}…)`;
  return backup;
}

/** El respaldo como archivo para descargar (JSON legible). */
export function backupToJson(backup: SystelBackup): string {
  return JSON.stringify(backup, null, 2);
}

const KEY = "patagonia-systel-last-backup";

/** Guarda el último respaldo en este navegador (si entra; si no, solo queda la descarga). */
export function saveBackupLocally(backup: SystelBackup): boolean {
  try {
    localStorage.setItem(KEY, backupToJson(backup));
    return true;
  } catch {
    return false;
  }
}

export function loadLocalBackup(): SystelBackup | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SystelBackup) : null;
  } catch {
    return null;
  }
}
