import { useEffect, useState } from "react";
import { formatMoney } from "../shifts/format";
import {
  autoDetectScale,
  checkScaleCompatibility,
  connectScalePort,
  deleteScalePlu,
  describeResponseCode,
  getScaleSerialSettings,
  isScalePortPaired,
  isScaleSerialSupported,
  planScaleSync,
  readScalePlu,
  saveScaleSerialSettings,
  sendScalePing,
  syncOneProductToScale,
  syncProductsToScale,
  type ScaleSerialSettings,
  type ScaleSyncableProduct
} from "./scale-serial";

/** Panel "Balanza por cable" completo (conectar, verificar compatibilidad,
 * envío masivo, un solo producto) como componente aparte -- lo usan tanto
 * Stock (con el catálogo entero, costo incluido) como Productos (la
 * pantalla del cajero, sin costo) pasándole solo `products`. Nace de un
 * pedido real: la balanza está conectada en la caja, pero el cable no lo
 * puede tocar el cajero porque Stock es una pantalla que no ve -- así que
 * este panel también vive en Productos, que el cajero sí puede abrir. */
export function ScaleSyncPanel({ products }: { products: ScaleSyncableProduct[] }) {
  const [showScalePanel, setShowScalePanel] = useState(false);
  const [scaleSettings, setScaleSettings] = useState<ScaleSerialSettings>(getScaleSerialSettings());
  const [scalePortReady, setScalePortReady] = useState(false);
  const [scaleBusy, setScaleBusy] = useState(false);
  const [scaleSyncProgress, setScaleSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [scaleLog, setScaleLog] = useState("");
  const [scaleTestCode, setScaleTestCode] = useState("");
  const [showScalePreview, setShowScalePreview] = useState(false);

  useEffect(() => {
    void isScalePortPaired().then(setScalePortReady);
  }, []);

  const scaleSyncPlan = planScaleSync(products);

  function updateScaleSettings(patch: Partial<ScaleSerialSettings>) {
    const next = { ...scaleSettings, ...patch };
    setScaleSettings(next);
    saveScaleSerialSettings(next);
  }

  async function handleConnectScale() {
    setScaleBusy(true);
    setScaleLog("");
    try {
      await connectScalePort();
      setScalePortReady(true);
      setScaleLog("Puerto conectado. Ahora probá la conexión antes de sincronizar productos.");
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "No se pudo conectar con el puerto.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handlePingScale() {
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await sendScalePing();
      setScaleLog(
        result.ok
          ? `La balanza respondió: ${result.rawResponseHex || "(sin bytes)"} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`
          : "La balanza no respondió nada -- revisá el cable, o probá otra velocidad de puerto."
      );
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló la prueba de conexión.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleAutoDetect() {
    setScaleBusy(true);
    setScaleLog("Buscando la configuración de tu balanza… no la desconectes ni cierres esta pantalla.");
    try {
      const result = await autoDetectScale((text) => setScaleLog(text));
      if (result.found && result.settings) {
        setScaleSettings(result.settings);
        setScaleLog(
          `¡Encontré tu balanza! Respondió con ${result.settings.baudRate} baudios, ${result.settings.stopBits} bit(s) de stop y equipo "${result.settings.deviceType}${result.settings.equipmentId}" (respuesta: ${result.rawResponseHex}). Ya quedó guardado: ahora usá "Verificar compatibilidad".`
        );
      } else {
        setScaleSettings(getScaleSerialSettings());
        setScaleLog(
          `Probé ${result.attempts} combinaciones y la balanza no respondió a ninguna. Revisá: 1) el cable (derecho, 1 a 1), 2) que la balanza esté en el menú COMUNI → MODO = "Datos" (la Aura) o el modo de comunicación con PC (otras Kretz), 3) que el adaptador USB tenga su driver instalado. Si todo está bien, mandá una captura de esta pantalla al equipo de Patagonia OS.`
        );
      }
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló la detección automática.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleCheckCompatibility() {
    setScaleBusy(true);
    setScaleLog("Probando compatibilidad… esto carga y borra un producto de prueba en la balanza, no toca productos reales.");
    try {
      const result = await checkScaleCompatibility();
      const details = [
        `Conexión: ${result.pingOk ? "OK" : "sin respuesta"}.`,
        result.writeResponseCode ? `Escritura de prueba: código "${result.writeResponseCode}".` : "",
        result.readResponseCode ? `Relectura: código "${result.readResponseCode}".` : ""
      ].filter(Boolean).join(" ");
      setScaleLog(`${result.compatible ? "✅" : "❌"} ${result.message} ${details}`);
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló la prueba de compatibilidad.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleSyncScale() {
    setScaleBusy(true);
    setScaleLog("");
    setScaleSyncProgress({ done: 0, total: 0 });
    try {
      const result = await syncProductsToScale(products, (done, total) => setScaleSyncProgress({ done, total }));
      const okCount = result.responseCodeCounts["01"] ?? 0;
      const failedCount = result.attempted - okCount;
      const codesSummary = Object.entries(result.responseCodeCounts)
        .filter(([code]) => code !== "01")
        .map(([code, count]) => `${count} con código "${code}" (${describeResponseCode(code)})`)
        .join(", ");
      const parts = [`${okCount} enviados con éxito de ${result.attempted} intentados.`];
      if (failedCount > 0 && codesSummary) parts.push(`Fallidos: ${codesSummary}.`);
      if (result.failed.length) {
        parts.push(
          "Detalle: " +
            result.failed.map((f) => `${f.product.name} (${f.product.code}, código "${f.responseCode}")`).join(", ") +
            "."
        );
      }
      if (result.skipped.length) parts.push(`${result.skipped.length} sin código numérico (no se enviaron).`);
      if (result.noResponse.length) parts.push(`${result.noResponse.length} sin ninguna respuesta.`);
      if (result.transportErrors.length) {
        parts.push(`${result.transportErrors.length} con error de conexión (${result.transportErrors[0].message}) -- probá enviar de nuevo, capaz fue un hipo del cable.`);
      }
      setScaleLog(parts.join(" "));
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló el envío a la balanza.");
    } finally {
      setScaleBusy(false);
      setScaleSyncProgress(null);
    }
  }

  async function handleSendOneProduct() {
    const product = products.find((p) => p.code === scaleTestCode.trim());
    if (!product) {
      setScaleLog(`No encontré ningún producto con código "${scaleTestCode.trim()}".`);
      return;
    }
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await syncOneProductToScale(product);
      setScaleLog(
        `Mandé "${product.name}" (código ${product.code}, $${product.priceRetail}). Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`
      );
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló el envío del producto.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleReadPlu() {
    if (!scaleTestCode.trim()) {
      setScaleLog("Ingresá un código de PLU para leer.");
      return;
    }
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await readScalePlu(scaleTestCode.trim());
      setScaleLog(
        `Leí PLU ${scaleTestCode.trim()}. Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}. Datos como texto: "${result.rawDataAscii}"`
      );
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló la lectura del PLU.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleDeletePlu() {
    const code = scaleTestCode.trim();
    if (!code) {
      setScaleLog("Ingresá un código de PLU para borrar.");
      return;
    }
    if (!window.confirm(`¿Seguro que querés borrar el PLU ${code} de la balanza? Esto borra el registro de la balanza (no de Patagonia OS).`)) return;
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await deleteScalePlu(code);
      setScaleLog(`Borré PLU ${code}. Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`);
    } catch (err) {
      setScaleLog(err instanceof Error ? err.message : "Falló el borrado del PLU.");
    } finally {
      setScaleBusy(false);
    }
  }

  return (
    <>
      <button className="secondary" onClick={() => setShowScalePanel((v) => !v)}>
        {showScalePanel ? "Ocultar balanza por cable" : "Balanza por cable (sin iTegra)"}
      </button>

      {showScalePanel && (
        <div style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 18, marginTop: 14, marginBottom: 14 }}>
          <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 16 }}>Balanza por cable</p>
          <p className="muted" style={{ margin: "0 0 16px", fontSize: 13 }}>
            Manda los productos directo a la balanza Kretz por cable, sin usar el software de iTegra. Solo funciona en Chrome o Edge.
          </p>
          {!isScaleSerialSupported() && (
            <p style={{ margin: "0 0 14px", color: "#8a4b00", fontWeight: 700 }}>
              Este navegador no soporta esto -- abrí Patagonia OS en Chrome o Edge.
            </p>
          )}

          <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 14, marginBottom: 14 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 700, fontSize: 13, textTransform: "uppercase", color: "#666" }}>1. Conexión</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button disabled={scaleBusy || !isScaleSerialSupported()} onClick={handleConnectScale}>
                {scalePortReady ? "Volver a elegir puerto" : "Conectar balanza"}
              </button>
              <button disabled={scaleBusy || !isScaleSerialSupported() || !scalePortReady} onClick={handleAutoDetect}>
                Detectar mi balanza automáticamente
              </button>
              <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={handlePingScale}>
                Probar conexión
              </button>
              <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={handleCheckCompatibility}>
                Verificar compatibilidad
              </button>
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              Si es una balanza que no probamos todavía (Report NX, Novel Eco, Aura Eco, o cualquier otra que no sea esta Report LT), usá "Verificar compatibilidad" antes de mandar productos: carga y borra un producto de prueba para confirmar que entiende el mismo formato, sin arriesgar datos reales. No hace falta saber el modelo -- la prueba es la misma para cualquiera.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <details style={{ display: "inline-block" }}>
                <summary className="secondary" style={{ display: "inline-block", cursor: "pointer", padding: "10px 14px", border: "1px solid #ccc", borderRadius: 6 }}>
                  Configuración avanzada
                </summary>
                <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginTop: 10, fontSize: 14 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    Velocidad
                    <select value={scaleSettings.baudRate} onChange={(e) => updateScaleSettings({ baudRate: Number(e.target.value) })}>
                      {[2400, 4800, 9600, 19200, 38400, 57600, 115200].map((rate) => (
                        <option key={rate} value={rate}>{rate}</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    Bits de stop
                    <select value={scaleSettings.stopBits} onChange={(e) => updateScaleSettings({ stopBits: Number(e.target.value) === 2 ? 2 : 1 })}>
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    ID de equipo
                    <input style={{ width: 50 }} value={scaleSettings.equipmentId} onChange={(e) => updateScaleSettings({ equipmentId: e.target.value.slice(0, 2) })} />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    Tipo de equipo
                    <input style={{ width: 40 }} value={scaleSettings.deviceType} onChange={(e) => updateScaleSettings({ deviceType: e.target.value.slice(0, 1).toUpperCase() })} />
                  </label>
                </div>
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                  Ya configurado para una Report LT (115200 baudios, tipo "C"). Solo tocar esto si conectás un modelo distinto.
                </p>
              </details>
            </div>
          </div>

          <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 14, marginBottom: 14 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 700, fontSize: 13, textTransform: "uppercase", color: "#666" }}>2. Envío masivo</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={() => setShowScalePreview((v) => !v)}>
                {showScalePreview ? "Ocultar vista previa" : `Vista previa (${scaleSyncPlan.toSend.length} productos)`}
              </button>
              <button disabled={scaleBusy || !isScaleSerialSupported()} onClick={handleSyncScale}>
                {scaleBusy && scaleSyncProgress ? `Enviando… ${scaleSyncProgress.done}/${scaleSyncProgress.total}` : "Enviar todos los productos"}
              </button>
            </div>
            {showScalePreview && (
              <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #eef0f3", borderRadius: 6, padding: 10, marginTop: 10, fontSize: 13 }}>
                <p style={{ margin: "0 0 8px", fontWeight: 700 }}>
                  Se enviarían {scaleSyncPlan.toSend.length} de {products.length} productos
                  {" "}({scaleSyncPlan.skipped.length} salteados, {scaleSyncPlan.inactive.length} inactivos).
                </p>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th>Código</th>
                      <th>Nombre</th>
                      <th>Precio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scaleSyncPlan.toSend.map((p) => (
                      <tr key={p.id}>
                        <td>{p.code}</td>
                        <td>{p.name}</td>
                        <td>{formatMoney(p.priceRetail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {scaleSyncPlan.skipped.length > 0 && (
                  <>
                    <p style={{ margin: "10px 0 4px", fontWeight: 700 }}>Salteados (no se envían):</p>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {scaleSyncPlan.skipped.map((s) => (
                        <li key={s.product.id}>{s.product.name} ({s.product.code}) -- {s.reason}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>

          <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 14 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 700, fontSize: 13, textTransform: "uppercase", color: "#666" }}>3. Un solo producto</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="Código del producto (ej. 12)"
                style={{ width: 200 }}
                value={scaleTestCode}
                onChange={(e) => setScaleTestCode(e.target.value)}
              />
              <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={handleSendOneProduct}>
                Enviar
              </button>
              <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" onClick={handleReadPlu}>
                Leer de la balanza
              </button>
              <button disabled={scaleBusy || !isScaleSerialSupported()} className="secondary" style={{ color: "#8a1f11" }} onClick={handleDeletePlu}>
                Borrar de la balanza
              </button>
            </div>
          </div>

          {scaleLog && (
            <p style={{ margin: "14px 0 0", fontSize: 13, whiteSpace: "pre-wrap", background: "#f7f7f8", borderRadius: 6, padding: 10 }}>{scaleLog}</p>
          )}
        </div>
      )}
    </>
  );
}
