import { useEffect, useState } from "react";
import { parseAmount } from "../../lib/money";
import { deleteBranchScaleConfig, detectScaleConfig, saveBranchScaleConfig, type ScaleConfig, type ScalePayloadType } from "./scale-config-service";
import { ScaleWeightSettings } from "./ScaleWeightSettings";
import { setMostradorPin } from "./company-settings-service";
import { isThermalPrintSupported } from "./thermal-printer";
import { PrinterAgentSettings } from "./PrinterAgentSettings";
import { SettingSection } from "../../components/SettingSection";

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
  const [agentStatus, setAgentStatus] = useState<"checking" | "up" | "down">("checking");

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

  const printStatus =
    agentStatus === "up" ? (autoPrintEnabled ? "Imprime solo al cobrar" : "Conectada · no imprime sola") : autoPrintEnabled ? "Abre el diálogo de Windows" : "Sin configurar";
  const printTone = agentStatus === "up" && autoPrintEnabled ? "ok" : agentStatus === "up" ? "neutral" : autoPrintEnabled ? "warn" : "neutral";

  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-title">
        <h2>Configuración</h2>
      </div>

      <SettingSection title="Impresora de tickets" status={printStatus} tone={printTone}>
        <PrinterAgentSettings onStatusChange={setAgentStatus} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
          <input type="checkbox" checked={autoPrintEnabled} onChange={(e) => onAutoPrintChange(e.target.checked)} />
          Imprimir automáticamente al cobrar
        </label>
        <details>
          <summary className="setting-help" style={{ cursor: "pointer" }}>Otras formas de conectar la impresora (solo si el programa no te sirve)</summary>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {isThermalPrintSupported() && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button className="secondary" disabled={thermalConnectBusy} onClick={onConnectThermal}>
                  {thermalConnectBusy ? "Conectando…" : thermalPaired ? "Volver a elegir impresora (USB directo)" : "Conectar impresora (USB directo)"}
                </button>
                <span className="setting-help">Solo si Windows no le instaló driver; si dice "Access denied", usá el programa.</span>
              </div>
            )}
            <p className="setting-help">
              Modo kiosco (solo con el driver correcto de la impresora): <a href="/kiosco-impresora.bat" download>kiosco-impresora.bat</a>
            </p>
          </div>
        </details>
      </SettingSection>

      <ScaleWeightSettings />

      <SettingSection
        title="Etiquetas de la balanza"
        status={scaleConfigCalibrated ? "Calibradas" : "Formato Kretz de fábrica"}
        tone={scaleConfigCalibrated ? "ok" : "neutral"}
        actionLabel={scaleConfigCalibrated ? "Volver a calibrar" : "Calibrar"}
      >
        <p className="setting-help">
          Solo si al escanear una etiqueta de producto el peso o el importe no da bien. Poné un producto en la balanza, escaneá acá su etiqueta y escribí lo que mostró la balanza: el sistema detecta el formato solo. (Los tickets de total de la Kretz Aura no necesitan esto.)
        </p>
        <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
          <div style={{ display: "flex", gap: 16, fontSize: 14, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="radio" checked={scaleWizardPayload === "weight"} onChange={() => setScaleWizardPayload("weight")} />
              La etiqueta trae el <b>peso</b>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="radio" checked={scaleWizardPayload === "amount"} onChange={() => setScaleWizardPayload("amount")} />
              Trae el <b>importe</b>
            </label>
          </div>
          <input
            name="scale-label-code"
            autoComplete="off"
            placeholder="Escaneá acá la etiqueta de la balanza…"
            value={scaleWizardCode}
            onChange={(e) => setScaleWizardCode(e.target.value)}
          />
          <input
            name="scale-label-value"
            autoComplete="off"
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
            <p style={{ margin: 0, color: "#1a7a3c", fontWeight: 700 }}>Listo, guardado. Probá escanear otra etiqueta para confirmar.</p>
          )}
          {scaleWizardResult === "not_found" && (
            <p style={{ margin: 0, color: "#8a4b00", fontWeight: 700 }}>
              No se pudo detectar con esa etiqueta. Probá con otro producto o peso, o escribinos y lo configuramos nosotros.
            </p>
          )}
        </div>
      </SettingSection>

      {canSeeShiftTotals && (
        <SettingSection
          title="PIN para ver movimientos"
          status={mostradorPin ? "Activado" : "Sin PIN"}
          tone={mostradorPin ? "ok" : "neutral"}
          actionLabel={mostradorPin ? "Cambiar" : "Poner PIN"}
        >
          <p className="setting-help">Pide un PIN de 4 números para ver "Ver movimientos" y "Ver movimientos de caja", así no quedan a la vista en el mostrador.</p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="password"
              name="mostrador-pin"
              autoComplete="new-password"
              inputMode="numeric"
              maxLength={4}
              placeholder="PIN nuevo (4 números)"
              value={pinSettingInput}
              onChange={(e) => setPinSettingInput(e.target.value.replace(/\D/g, ""))}
              style={{ width: 170 }}
            />
            <button disabled={pinSettingBusy} onClick={() => handleSavePin()}>Guardar</button>
            {mostradorPin && (
              <button className="secondary" disabled={pinSettingBusy} onClick={() => void handleSavePin(null)}>
                Sacar PIN
              </button>
            )}
          </div>
        </SettingSection>
      )}
    </section>
  );
}
