/**
 * Solo para pruebas: el programa de la PC (patagonia-print-agent.ps1) simulado, con la MISMA lógica de conexiones que
 * el de verdad:
 * - versión 6 o anterior: una sola conexión; abrir cierra la anterior y cerrar cierra lo que haya;
 * - versión 7: una conexión por dirección; `/scale/open?...&multi=1` devuelve `link`, y write/read/close con `link`
 *   tocan solo esa. Sin `link` (la web de antes), como la 6.
 * Cada balanza es una función que contesta a los bytes que recibe.
 */

type Device = (bytes: number[]) => number[];

interface Link {
  id: string;
  target: string;
  inbox: number[];
}

export interface FakeNetAgent {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  /** Cada pedido: ruta + parámetros. */
  calls: string[];
  /** Direcciones con la conexión abierta ahora. */
  openTargets(): string[];
}

export function fakeNetAgent(opts: { version: number; devices: Record<string, Device> }): FakeNetAgent {
  const links = new Map<string, Link>();
  let last: string | null = null;
  let seq = 0;
  const calls: string[] = [];
  const multiOk = opts.version >= 7;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const closeAll = () => {
    links.clear();
    last = null;
  };
  const find = (u: URL): Link | null => {
    const id = u.searchParams.get("link");
    if (multiOk && id) return links.get(id) ?? null;
    return last ? links.get(last) ?? null : null;
  };
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname === "/ping") return json(200, { ok: true, version: opts.version });
    if (u.pathname === "/scale/open") {
      const target = `${u.searchParams.get("host")}:${u.searchParams.get("port")}`;
      const multi = multiOk && u.searchParams.get("multi") === "1";
      if (!multi) closeAll();
      else for (const l of [...links.values()]) if (l.target === target) links.delete(l.id);
      if (!opts.devices[target]) return json(502, { ok: false, error: `La balanza no contesta en ${target}.`, local: [] });
      const id = `L${++seq}`;
      links.set(id, { id, target, inbox: [] });
      last = id;
      return json(200, multi ? { ok: true, target, link: id } : { ok: true, target });
    }
    if (u.pathname === "/scale/close") {
      const id = u.searchParams.get("link");
      if (multiOk && id) {
        links.delete(id);
        if (last === id) last = null;
      } else closeAll();
      return json(200, { ok: true });
    }
    const link = find(u);
    if (!link) return json(409, { ok: false, error: "La conexion con la balanza no esta abierta.", closed: true });
    if (u.pathname === "/scale/write") {
      const bytes = [...new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer())];
      link.inbox.push(...opts.devices[link.target](bytes));
      return json(200, { ok: true, bytes: bytes.length });
    }
    if (u.pathname === "/scale/read") {
      if (!link.inbox.length) await new Promise((r) => setTimeout(r, 5));
      const chunk = link.inbox.splice(0, link.inbox.length);
      return json(200, { ok: true, data: btoa(String.fromCharCode(...chunk)), closed: false });
    }
    return json(404, { ok: false });
  };
  return { fetchImpl, calls, openTargets: () => [...links.values()].map((l) => l.target) };
}
