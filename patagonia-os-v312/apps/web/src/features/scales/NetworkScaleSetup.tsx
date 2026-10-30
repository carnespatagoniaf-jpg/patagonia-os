import { useEffect, useState } from "react";
import { findNetScales, isLocalNetworkHost, KRETZ_NET_PORT, NET_AGENT_VERSION, netAgentVersion, sameSubnet, testNetScale, type LocalAddress, type NetAddress } from "../inventory/kretz/net-port";

/**
 * "Mi Kretz Report está conectada por cable de red": la balanza va con el cable de red (Ethernet) a la PC o al
 * router, sin Bluetooth ni USB. Chrome no puede hablarle por la red: lo hace el programa de Patagonia de la PC (el
 * mismo de la impresora, versión 4 o más). Pasos: programa → dirección de la balanza (se busca sola) → conectar.
 */

type AgentState = "buscando" | "sin_programa" | "viejo" | "listo";

export function NetworkScaleSetup({ onConnect, onBack }: { onConnect: (a: NetAddress) => void; onBack: () => void }) {
  const [agent, setAgent] = useState<AgentState>("buscando");
  const [found, setFound] = useState<string[] | null>(null);
  const [local, setLocal] = useState<LocalAddress[]>([]);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(KRETZ_NET_PORT));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function checkAgent() {
    setAgent("buscando");
    setMessage(null);
    const v = await netAgentVersion();
    if (v === null) return setAgent("sin_programa");
    if (v < NET_AGENT_VERSION) return setAgent("viejo");
    setAgent("listo");
    try {
      const r = await findNetScales(KRETZ_NET_PORT);
      setFound(r.found);
      setLocal(r.local);
      if (r.found.length === 1) setHost(r.found[0]);
    } catch {
      setFound([]);
    }
  }

  useEffect(() => {
    void checkAgent();
  }, []);

  async function connect(target: string) {
    const h = target.trim();
    const p = Number(port);
    if (!isLocalNetworkHost(h)) {
      setMessage("Escribí la dirección (IP) de la balanza, por ejemplo 192.168.1.50. Está en el menú de la balanza: Configuración de Red → IP.");
      return;
    }
    // El programa de la PC solo abre puertos de balanza (1000-1099), para no servir de puente a otros equipos de la red.
    if (!Number.isInteger(p) || p < 1000 || p > 1099) {
      setMessage("El puerto de la balanza va de 1000 a 1099 (el de fábrica es 1001). Fijate en el menú Configuración de Red.");
      return;
    }
    setBusy(true);
    setMessage(null);
    const r = await testNetScale({ host: h, port: p });
    setBusy(false);
    if (r.ok) return onConnect({ host: h, port: p });
    if (r.kind === "sin_programa") return setAgent("sin_programa");
    const pcs = r.local ?? local;
    setMessage(unreachableMessage(h, p, pcs));
  }

  return (
    <div className="my-scale-body">
      <p className="my-scale-status">Kretz Report por cable de red</p>

      {agent === "buscando" && <p className="muted">Buscando el programa de Patagonia en esta computadora…</p>}

      {(agent === "sin_programa" || agent === "viejo") && (
        <>
          <p>
            {agent === "viejo"
              ? "Esta computadora tiene una versión vieja del programa de Patagonia. Hay que actualizarlo (es el mismo instalador de siempre):"
              : "Para hablar con la balanza por la red hace falta el programa de Patagonia en esta computadora (es el mismo de la impresora de tickets). Se instala una sola vez:"}
          </p>
          <ol className="my-scale-net-steps">
            <li>
              <a href="/instalar-impresora.bat" download>Bajá el instalador</a> y abrilo con doble clic. Si Windows avisa, tocá "Más información" → "Ejecutar de todas formas".
            </li>
            <li>Esperá a que diga LISTO.</li>
            <li>Si Chrome pregunta si permitís acceder a dispositivos de tu red local, tocá Permitir.</li>
          </ol>
          <div className="my-scale-actions">
            <button className="my-scale-primary" onClick={() => void checkAgent()}>YA LO INSTALÉ</button>
            <button className="secondary" onClick={onBack}>Volver</button>
          </div>
        </>
      )}

      {agent === "listo" && (
        <>
          {found === null && <p className="muted">Buscando la balanza en la red…</p>}
          {found && found.length > 0 && (
            <>
              <p>{found.length === 1 ? "Encontramos una balanza en la red:" : "Encontramos estas balanzas en la red:"}</p>
              <div className="my-scale-actions">
                {found.map((ip) => (
                  <button key={ip} className="my-scale-primary" disabled={busy} onClick={() => void connect(ip)}>
                    CONECTAR {ip}
                  </button>
                ))}
              </div>
            </>
          )}
          {found && found.length === 0 && (
            <p className="muted">
              No encontramos la balanza sola. Fijate su dirección en el menú de la balanza: Configuración de Red → IP, y escribila acá.
            </p>
          )}
          <div className="form-grid">
            <label>
              Dirección (IP) de la balanza
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" inputMode="decimal" />
            </label>
            <label>
              Puerto
              <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </label>
          </div>
          <div className="my-scale-actions">
            <button className={found && found.length > 0 ? "secondary" : "my-scale-primary"} disabled={busy || !host.trim()} onClick={() => void connect(host)}>
              {busy ? "Probando…" : "CONECTAR"}
            </button>
            <button className="secondary" disabled={busy} onClick={() => void checkAgent()}>Buscar de nuevo</button>
            <button className="secondary" disabled={busy} onClick={onBack}>Volver</button>
          </div>
        </>
      )}

      {message && <p className="my-scale-warning">{message}</p>}
    </div>
  );
}

/** Por qué la PC no llega a la balanza, en palabras. Si no están en la misma red, qué dirección ponerle. */
export function unreachableMessage(host: string, port: number, pcs: LocalAddress[]): string {
  const lan = pcs.filter((l) => isLocalNetworkHost(l.ip));
  if (lan.length && !sameSubnet(host, lan)) {
    const wired = lan.find((l) => /ethernet/i.test(l.kind) && !l.ip.startsWith("169.254.")) ?? lan.find((l) => !l.ip.startsWith("169.254.")) ?? lan[0];
    const parts = wired.ip.split(".");
    const suggestion = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3] === "200" ? "201" : "200"}`;
    return `La balanza (${host}) no está en la misma red que esta computadora (${lan.map((l) => l.ip).join(", ")}). En el menú de la balanza, Configuración de Red, poné la IP ${suggestion} y la máscara ${wired.mask}, y tocá CONECTAR de nuevo. Si no podés cambiarla, escribinos.`;
  }
  return `La balanza no contesta en ${host} (puerto ${port}). Revisá que esté prendida, que el cable de red esté enchufado en los dos lados (la lucecita verde al lado del cable tiene que estar prendida) y que la IP y el puerto sean los del menú Configuración de Red de la balanza.`;
}
