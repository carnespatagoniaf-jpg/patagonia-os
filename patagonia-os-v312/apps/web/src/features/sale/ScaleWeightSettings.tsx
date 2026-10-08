import { useEffect, useState } from "react";
import {
  connectWeightScale,
  forgetWeightScale,
  isWeightScaleEnabled,
  isWeightScalePaired,
  isWeightScaleSupported,
  readScaleWeight,
  setWeightScaleEnabled,
  type ScaleReading
} from "./scale-weight";
import { describeRawFrame } from "./scale-weight-parser";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";
import { SettingSection } from "../../components/SettingSection";

/** Sección del engranaje de Mostrador para leer el peso directo de la balanza
 * Kretz Aura por cable. Solo se activa después de una prueba confirmada: el
 * cajero compara lo que leyó el sistema con la pantalla de la balanza. */
export function ScaleWeightSettings() {
  const { profile } = useAuth();
  const [enabled, setEnabled] = useState(isWeightScaleEnabled());
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState<ScaleReading | null>(null);

  useEffect(() => {
    void isWeightScalePaired().then(setPaired);
  }, []);

  // La balanza por cable es del plan Estándar en adelante.
  if (!planAllows(profile, "estandar")) return null;

  if (!isWeightScaleSupported()) {
    return (
      <SettingSection title="Peso directo de la balanza (cable)" status="Solo en Chrome o Edge">
        <p className="setting-help">Este navegador no soporta la conexión por cable. Abrí Patagonia OS en Chrome o Edge.</p>
      </SettingSection>
    );
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No pude comunicarme con la balanza.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingSection title="Peso directo de la balanza (cable)" status={enabled ? "Activado" : "Desactivado"} tone={enabled ? "ok" : "neutral"}>
      <p className="setting-help">
        Kretz Aura: al elegir un producto por kilo, Mostrador toma el peso de la balanza. En la balanza: COMUNI → MODO "A pedido de peso", puerto RS-232. Después: "Conectar balanza", un producto en el plato y "Probar lectura".
      </p>

      <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await connectWeightScale();
              setPaired(true);
              setReading(null);
              setMessage("Balanza conectada. Poné un producto en el plato y tocá \"Probar lectura\".");
            })
          }
        >
          {paired ? "Volver a elegir puerto" : "Conectar balanza"}
        </button>
        <button
          disabled={busy || !paired}
          onClick={() =>
            run(async () => {
              setReading(null);
              setReading(await readScaleWeight());
            })
          }
        >
          {busy ? "Leyendo…" : "Probar lectura"}
        </button>
        {enabled && (
          <button
            className="secondary"
            onClick={() => {
              setWeightScaleEnabled(false);
              setEnabled(false);
              setMessage("Lectura de peso desactivada. Mostrador vuelve a cargar 1 kg por defecto.");
            }}
          >
            Desactivar
          </button>
        )}
        {paired && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await forgetWeightScale();
                setWeightScaleEnabled(false);
                setEnabled(false);
                setPaired(false);
                setReading(null);
              })
            }
          >
            Olvidar balanza
          </button>
        )}
      </div>

      {reading && (
        <div className="message" style={{ marginTop: 12 }}>
          <p style={{ margin: "0 0 8px" }}>
            Leí <strong>{reading.frame.weightKg.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg</strong>. ¿Es el peso que muestra la pantalla de la balanza?
          </p>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>Recibido: {describeRawFrame(reading.raw)}</p>
          <div className="cash-banner-form">
            <button
              onClick={() => {
                setWeightScaleEnabled(true);
                setEnabled(true);
                setReading(null);
                setMessage("Listo: desde ahora Mostrador toma el peso de la balanza al agregar productos por kilo.");
              }}
            >
              Sí, coincide
            </button>
            <button
              className="secondary"
              onClick={() => {
                setWeightScaleEnabled(false);
                setEnabled(false);
                setMessage(`No se activó. Mandá una captura de esta pantalla al equipo de Patagonia OS: recibimos "${describeRawFrame(reading.raw)}".`);
                setReading(null);
              }}
            >
              No coincide
            </button>
          </div>
        </div>
      )}

      {message && <p className="message" style={{ marginTop: 12 }}>{message}</p>}
    </SettingSection>
  );
}
