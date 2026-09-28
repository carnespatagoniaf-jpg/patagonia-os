import { useCallback, useEffect, useState } from "react";
import { buildTestTicket, getThermalPrintSettings, printBytes } from "./thermal-printer";
import {
  getAgentPrinterName,
  listAgentPrinters,
  pickLikelyThermal,
  pingPrintAgent,
  setAgentPrinterName,
  type AgentPrinter
} from "./printer-agent";

// "Impresora de tickets" en la Configuración de Mostrador: es la forma
// recomendada de imprimir en una térmica (cualquier marca, cualquier driver de
// Windows). Muestra si el programa de impresión está instalado en esta PC, deja
// elegir la impresora y manda un ticket de prueba. La instalación en sí es
// instalar-impresora.bat (una vez por PC).

type Status = "checking" | "up" | "down";

export function PrinterAgentSettings() {
  const [status, setStatus] = useState<Status>("checking");
  const [printers, setPrinters] = useState<AgentPrinter[]>([]);
  const [selected, setSelected] = useState(getAgentPrinterName());
  const [testBusy, setTestBusy] = useState(false);
  const [note, setNote] = useState("");

  // `probe` = lo pidió una persona tocando el botón. Al abrir la pantalla solo
  // se consulta si este navegador ya había encontrado el programa antes (ver
  // isAgentEnabled): así nadie ve el aviso de "red local" de Chrome sin haberlo
  // pedido.
  const refresh = useCallback(async (probe: boolean) => {
    setStatus("checking");
    setNote("");
    if (!(await pingPrintAgent({ probe }))) {
      setStatus("down");
      if (probe) setNote("Todavía no encuentro el programa. Si ya lo instalaste, esperá unos segundos y probá de nuevo; si Chrome pidió permiso, tocá Permitir.");
      return;
    }
    try {
      const list = (await listAgentPrinters()).filter((p) => p.isPhysical);
      setPrinters(list);
      let current = getAgentPrinterName();
      if (!current || !list.some((p) => p.name === current)) {
        // Elige sola la térmica si se la reconoce (ej. una sola física, o un
        // nombre tipo POS/Thermal/Unnion entre varias); si no, que elija el usuario.
        const likely = pickLikelyThermal(list);
        current = likely?.name ?? "";
        setAgentPrinterName(current);
      }
      setSelected(current);
      setStatus("up");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "No se pudo leer la lista de impresoras.");
      setStatus("up");
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  function handleSelect(name: string) {
    setSelected(name);
    setAgentPrinterName(name);
    setNote("");
  }

  async function handleTest() {
    setNote("");
    setTestBusy(true);
    try {
      await printBytes(buildTestTicket(getThermalPrintSettings()));
      setNote("Listo: mandó un ticket de prueba. Si salió bien, tildá 'Imprimir el comprobante automáticamente al cobrar' (arriba) y los comprobantes van a salir solos.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "No se pudo imprimir el ticket de prueba.");
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ margin: "0 0 6px", fontWeight: 700 }}>
        Impresora de tickets{" "}
        {status === "up" && <span className="badge-ok" style={{ fontSize: 12, fontWeight: 600, color: "#1a7f37" }}>· Programa de impresión activo</span>}
      </p>

      {status === "checking" && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Buscando el programa de impresión de esta PC…</p>}

      {status === "down" && (
        <>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            Para imprimir los tickets directo en tu térmica, sin ningún cartel y sin importar la marca ni el driver de Windows, instalá el programa de impresión. Se hace una sola vez en esta PC: descargá el archivo, abrilo con doble clic y esperá el "LISTO".
          </p>
          <p style={{ margin: "0 0 8px" }}>
            <a href="/instalar-impresora.bat" download>Descargar instalar-impresora.bat</a>
          </p>
          <button className="secondary" onClick={() => void refresh(true)}>Ya lo instalé, volver a buscar</button>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
            Si Chrome pregunta si permitís que este sitio acceda a dispositivos de tu red local, tocá <strong>Permitir</strong>: es el programa de impresión que está en esta misma PC. Si tocaste Bloquear sin querer: clic en el candado de la barra de direcciones → Configuración del sitio → "Acceso a la red local" (o "Dispositivos de la red local") → Permitir, y volvé a buscar.
          </p>
        </>
      )}

      {status === "up" && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 14 }}>
            Imprimir en
            <select value={selected} onChange={(e) => handleSelect(e.target.value)}>
              <option value="">Elegí tu impresora de tickets…</option>
              {printers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="secondary" disabled={testBusy || !selected} onClick={() => void handleTest()}>
              {testBusy ? "Imprimiendo…" : "Imprimir ticket de prueba"}
            </button>
            <button className="secondary" onClick={() => void refresh(true)}>Actualizar lista</button>
          </div>
        </>
      )}

      {note && <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>{note}</p>}
    </div>
  );
}
