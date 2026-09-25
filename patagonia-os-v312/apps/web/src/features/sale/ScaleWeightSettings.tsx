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

/** Sección del engranaje de Mostrador para leer el peso directo de la balanza
 * Kretz Aura por cable. Solo se activa después de una prueba confirmada: el
 * cajero compara lo que leyó el sistema con la pantalla de la balanza. */
export function ScaleWeightSettings() {
  const [enabled, setEnabled] = useState(isWeightScaleEnabled());
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState<ScaleReading | null>(null);

  useEffect(() => {
    void isWeightScalePaired().then(setPaired);
  }, []);

  if (!isWeightScaleSupported()) {
    return (
      <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 18 }}>
        <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Peso directo de la balanza (cable)</p>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Este navegador no soporta la conexión por cable. Abrí Patagonia OS en Chrome o Edge.</p>
      </div>
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
    <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 18 }}>
      <p style={{ margin: "0 0 8px", fontWeight: 700 }}>
        Peso directo de la balanza (cable){" "}
        <span className={enabled ? "scale-weight-pill scale-weight-on" : "scale-weight-pill"}>{enabled ? "Activado" : "Desactivado"}</span>
      </p>
      <p className="muted" style={{ margin: "0 0 4px", fontSize: 13 }}>
        Para la Kretz Aura: al elegir un producto por kilo en Mostrador, el peso lo trae la balanza solo. Así el stock baja producto por producto.
      </p>
      <ol className="muted" style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13, display: "grid", gap: 2 }}>
        <li>Conectá la balanza a la PC con el cable serie (RS-232). Está explicado en la guía que te dimos.</li>
        <li>En la balanza: menú COMUNI → MODO = "A pedido de peso" y puerto RS-232.</li>
        <li>Tocá "Conectar balanza", elegí el puerto, poné un producto en el plato y tocá "Probar lectura".</li>
      </ol>

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
    </div>
  );
}
