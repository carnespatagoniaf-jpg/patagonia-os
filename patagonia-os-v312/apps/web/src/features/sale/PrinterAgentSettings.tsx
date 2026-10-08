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

export function PrinterAgentSettings({ onStatusChange }: { onStatusChange?: (status: "checking" | "up" | "down") => void } = {}) {
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

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

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
      setNote("Listo: mandó un ticket de prueba. Si salió bien, tildá 'Imprimir automáticamente al cobrar'.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "No se pudo imprimir el ticket de prueba.");
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {status === "checking" && <p className="setting-help">Buscando el programa de impresión de esta PC…</p>}

      {status === "down" && (
        <>
          <p className="setting-help">
            Para que el ticket salga directo en tu térmica (cualquier marca), instalá el programa de impresión. Una sola vez por PC: descargalo, abrilo con doble clic y esperá el "LISTO".
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <a className="button-link" href="/instalar-impresora.bat" download>Descargar el programa</a>
            <button className="secondary" onClick={() => void refresh(true)}>Ya lo instalé</button>
          </div>
          <p className="setting-help" style={{ fontSize: 12 }}>
            Si Chrome pregunta por "dispositivos de tu red local", tocá <strong>Permitir</strong> (es el programa de esta misma PC).
          </p>
        </>
      )}

      {status === "up" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={selected} onChange={(e) => handleSelect(e.target.value)}>
            <option value="">Elegí tu impresora de tickets…</option>
            {printers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="secondary" disabled={testBusy || !selected} onClick={() => void handleTest()}>
            {testBusy ? "Imprimiendo…" : "Imprimir prueba"}
          </button>
          <button className="secondary" onClick={() => void refresh(true)}>Actualizar</button>
        </div>
      )}

      {note && <p className="setting-help">{note}</p>}
    </div>
  );
}
