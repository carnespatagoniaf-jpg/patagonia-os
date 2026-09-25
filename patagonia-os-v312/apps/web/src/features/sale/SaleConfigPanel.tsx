import { useEffect, useState } from "react";
import { parseAmount } from "../../lib/money";
import { deleteBranchScaleConfig, detectScaleConfig, saveBranchScaleConfig, type ScaleConfig, type ScalePayloadType } from "./scale-config-service";
import { ScaleWeightSettings } from "./ScaleWeightSettings";
import { setMostradorPin } from "./company-settings-service";
import { isThermalPrintSupported } from "./thermal-printer";

// Panel de configuración de Mostrador (engranaje): impresora, balanza (peso
// directo y calibración de etiquetas) y PIN. El asistente de calibración y el
// PIN llevan su propio estado; el padre solo guarda lo que necesita usar
// (formato de etiquetas, PIN vigente, impresora).

export interface SaleConfigPanelProps {
  visible: boolean;
  branchId: string | null;
  canSeeShiftTotals: boolean;
  autoPrintEnabled: boolean;
  onAutoPrintChange: (enabled: boolean) => void;
  thermalPaired: boolean;
  thermalConnectBusy: boolean;
  onConnectThermal: () => void;
  scaleConfigCalibrated: boolean;
  /** Formato detectado, o null si se borró la calibración. */
  onScaleConfigChange: (config: ScaleConfig | null) => void;
  mostradorPin: string | null;
  onPinChange: (pin: string | null) => void;
  onMessage: (message: string) => void;
}

export function SaleConfigPanel({
  visible, branchId, canSeeShiftTotals, autoPrintEnabled, onAutoPrintChange, thermalPaired, thermalConnectBusy, onConnectThermal,
  scaleConfigCalibrated, onScaleConfigChange, mostradorPin, onPinChange, onMessage
}: SaleConfigPanelProps) {
  const [scaleWizardCode, setScaleWizardCode] = useState("");
  const [scaleWizardWeight, setScaleWizardWeight] = useState("");
  const [scaleWizardPayload, setScaleWizardPayload] = useState<ScalePayloadType>("weight");
  const [scaleWizardBusy, setScaleWizardBusy] = useState(false);
  const [scaleWizardResult, setScaleWizardResult] = useState<"idle" | "success" | "not_found">("idle");
  const [pinSettingInput, setPinSettingInput] = useState("");
  const [pinSettingBusy, setPinSettingBusy] = useState(false);

  // Al abrir o cerrar el panel se limpia el resultado del asistente.
  useEffect(() => {
    setScaleWizardResult("idle");
  }, [visible]);

  async function handleCalibrateScale() {
    setScaleWizardResult("idle");
    if (!branchId) return;
    const code = scaleWizardCode.trim();
    const enteredValue = parseAmount(scaleWizardWeight || "0") || Number(scaleWizardWeight);
    if (!code) { onMessage("Escaneá una etiqueta de tu balanza primero."); return; }
    if (!Number.isFinite(enteredValue) || enteredValue <= 0) {
      onMessage(scaleWizardPayload === "weight" ? "Ingresá el peso que mostró la balanza." : "Ingresá el importe que mostró la balanza.");
      return;
    }
    setScaleWizardBusy(true);
    try {
      const detected = detectScaleConfig(code, enteredValue, scaleWizardPayload);
      if (!detected) {
        setScaleWizardResult("not_found");
        return;
      }
      await saveBranchScaleConfig(branchId, detected);
      onScaleConfigChange(detected);
      setScaleWizardResult("success");
      setScaleWizardCode("");
      setScaleWizardWeight("");
    } catch (err) {
      onMessage(err instanceof Error ? err.message : "No se pudo guardar la configuración de la balanza.");
    } finally {
      setScaleWizardBusy(false);
    }
  }

  async function handleResetScaleConfig() {
    if (!branchId) return;
    try {
      await deleteBranchScaleConfig(branchId);
      onScaleConfigChange(null);
      setScaleWizardResult("idle");
      onMessage("Se borró la calibración de la balanza -- vuelve al formato Kretz por defecto.");
    } catch (err) {
      onMessage(err instanceof Error ? err.message : "No se pudo borrar la configuración.");
    }
  }

  async function handleSavePin(value: string | null = pinSettingInput) {
    if (value && !/^\d{4}$/.test(value)) {
      onMessage("El PIN tiene que ser de 4 dígitos.");
      return;
    }
    setPinSettingBusy(true);
    try {
      await setMostradorPin(value || null);
      onPinChange(value || null);
      setPinSettingInput("");
      onMessage(value ? "PIN guardado." : "PIN sacado -- ya no va a pedir nada.");
    } catch (err) {
      onMessage(err instanceof Error ? err.message : "No se pudo guardar el PIN.");
    } finally {
      setPinSettingBusy(false);
    }
  }

  if (!visible) return null;
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-title">
        <h2>Configuración</h2>
      </div>
      <div style={{ display: "grid", gap: 18 }}>
        <div>
          <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Impresora</p>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
            <input
              type="checkbox"
              checked={autoPrintEnabled}
              onChange={(e) => onAutoPrintChange(e.target.checked)}
            />
            Imprimir el comprobante automáticamente al cobrar
          </label>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
            Si conectaste una impresora térmica abajo, el ticket sale ahí directo, sin ningún diálogo ni clic extra. Si no conectaste ninguna, al cobrar se abre el diálogo de impresión de Windows -- ahí elegís tu impresora por su nombre y confirmás "Imprimir" (ningún navegador permite saltear ese clic sin una impresora conectada por USB, es una protección de seguridad). Si no tenés impresora, dejalo apagado y nunca te va a aparecer nada solo.
          </p>
          {isThermalPrintSupported() && (
            <div style={{ marginTop: 10 }}>
              <button className="secondary" disabled={thermalConnectBusy} onClick={onConnectThermal}>
                {thermalConnectBusy ? "Conectando…" : thermalPaired ? "Volver a elegir impresora térmica" : "Conectar impresora térmica (USB)"}
              </button>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
                {thermalPaired
                  ? "Impresora térmica conectada en este navegador -- el ticket va a salir ahí solo, sin diálogo, mientras esté prendido \"Imprimir automáticamente\"."
                  : "Conectala una sola vez (elegila de la lista que te va a mostrar Chrome) para que el ticket salga solo al cobrar, sin ningún diálogo -- igual que se conecta la balanza en Stock."}
              </p>
              <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>
                ¿La conexión directa no funcionó (suele pasar cuando Windows ya tiene un driver instalado para esa impresora)? Descargá este script y ejecutalo en la PC del Mostrador -- configura un acceso directo especial que aprueba la impresión sola, sin mostrar ningún diálogo:{" "}
                <a href="/kiosco-impresora.bat" download>kiosco-impresora.bat</a>
              </p>
            </div>
          )}
        </div>

        <ScaleWeightSettings />

        <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 18 }}>
          <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Balanza</p>
          <p className="muted" style={{ margin: "0 0 4px", fontSize: 13 }}>
            {scaleConfigCalibrated ? "Tu balanza ya está calibrada." : "Todavía no calibraste tu balanza (usando el formato Kretz por defecto)."}
          </p>
          <p className="muted" style={{ margin: "0 0 4px", fontSize: 13 }}>
            Poné cualquier producto en la balanza, anotá lo que te muestra, escaneá acá la etiqueta que imprime, y decinos ese valor -- el sistema detecta el formato solo, sin que tengas que entender nada técnico.
          </p>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Ojo: esto sirve para etiquetas de UN producto por código (con su PLU). Los tickets de total de las balanzas tipo caja (Kretz Aura) se leen solos al escanearlos en Mostrador, sin calibrar nada: entran como una línea "Ticket de balanza" con el importe, sin descontar stock.
          </p>
          <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
            <div style={{ display: "flex", gap: 16, fontSize: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={scaleWizardPayload === "weight"} onChange={() => setScaleWizardPayload("weight")} />
                Mi balanza muestra el <b>peso</b>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={scaleWizardPayload === "amount"} onChange={() => setScaleWizardPayload("amount")} />
                Mi balanza muestra el <b>importe</b> final
              </label>
            </div>
            <input
              placeholder="Escaneá acá la etiqueta de la balanza…"
              value={scaleWizardCode}
              onChange={(e) => setScaleWizardCode(e.target.value)}
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder={scaleWizardPayload === "weight" ? "¿Qué peso mostró la balanza? (ej. 0,472)" : "¿Qué importe mostró la balanza? (ej. 1250)"}
              value={scaleWizardWeight}
              onChange={(e) => setScaleWizardWeight(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button disabled={scaleWizardBusy} onClick={handleCalibrateScale}>{scaleWizardBusy ? "Detectando…" : "Detectar formato"}</button>
              {scaleConfigCalibrated && (
                <button className="secondary" onClick={handleResetScaleConfig}>Borrar calibración</button>
              )}
            </div>
            {scaleWizardResult === "success" && (
              <p style={{ margin: 0, color: "#1a7a3c", fontWeight: 700 }}>Listo, detectado y guardado -- probá escanear otra etiqueta para confirmar.</p>
            )}
            {scaleWizardResult === "not_found" && (
              <p style={{ margin: 0, color: "#8a4b00", fontWeight: 700 }}>
                No pudimos detectar el formato solos con esa etiqueta. Probá de nuevo con otro producto/peso distinto, o escribinos y lo configuramos nosotros.
              </p>
            )}
          </div>
        </div>

        {canSeeShiftTotals && (
          <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 18 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 700 }}>PIN para ver movimientos</p>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
              {mostradorPin
                ? "Configurado -- hay que tipearlo para revelar \"Ver movimientos\" y \"Ver movimientos de caja\", así no queda a la vista de cualquiera que pase por el mostrador."
                : "Sin configurar -- \"Ver movimientos\" y \"Ver movimientos de caja\" se revelan con un clic, sin pedir nada."}
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                placeholder="Nuevo PIN (4 dígitos)"
                value={pinSettingInput}
                onChange={(e) => setPinSettingInput(e.target.value)}
                style={{ width: 160 }}
              />
              <button disabled={pinSettingBusy} onClick={() => handleSavePin()}>Guardar</button>
              {mostradorPin && (
                <button className="secondary" disabled={pinSettingBusy} onClick={() => void handleSavePin(null)}>
                  Sacar PIN
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
