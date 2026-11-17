import { agentStatus, parseFindResponse, quickResult, SEARCH_PORTS, type AgentStatus, type QuickResult, type SearchResult } from "./net-wizard";

/**
 * Una búsqueda del camino corto: primero el programa de la PC (si falta o está viejo no se busca), después la red.
 * Las funciones de afuera se reciben para poder probarlo sin PC ni balanza (net-quick.test.ts).
 */

export interface QuickDeps {
  agentVersion: () => Promise<number | null>;
  permission: () => Promise<PermissionState | null>;
  find: (ports: number[]) => Promise<unknown>;
}

export type QuickSearch =
  | { kind: "programa"; status: Exclude<AgentStatus, "listo">; version: number | null; permission: PermissionState | null }
  | { kind: "buscado"; result: SearchResult; quick: QuickResult; version: number; permission: PermissionState | null }
  | { kind: "error"; message: string; version: number | null; permission: PermissionState | null };

export async function quickSearch(deps: QuickDeps): Promise<QuickSearch> {
  const [version, permission] = await Promise.all([deps.agentVersion(), deps.permission()]);
  const status = agentStatus(version, permission);
  if (status !== "listo") return { kind: "programa", status, version, permission };
  try {
    const result = parseFindResponse(await deps.find(SEARCH_PORTS), SEARCH_PORTS);
    return { kind: "buscado", result, quick: quickResult(result), version: version!, permission };
  } catch (err) {
    // El programa contestó el ping pero no la búsqueda (se cerró justo, o es una versión rara).
    return { kind: "error", message: err instanceof Error ? err.message : String(err), version, permission };
  }
}
