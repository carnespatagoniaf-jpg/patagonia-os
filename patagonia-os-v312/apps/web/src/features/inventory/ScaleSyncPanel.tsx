import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActiveBranch } from "../branches/BranchProvider";
import { exportActivityLogText, logScaleActivity } from "../scales/activity-log";
import { submitScaleSupportReport } from "../scales/support-service";
import { planAllows } from "../auth/permissions";
import { formatMoney } from "../shifts/format";
import {
  autoDetectScale,
  checkScaleCompatibility,
  connectScalePort,
  deleteScalePlu,
  describeResponseCode,
  diagnoseScaleLink,
  scanScalePlus,
  runAuraWriteTestOnScale,
  runAuraModelProbeOnScale,
  readAuraListOnScale,
  runAuraSyncOnScale,
  setAuraItemBarcodesOnScale,
  getScalePortDescription,
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
import { getLastDiagnosticRecord, getLastPluScan, summarizeDiagnosticRecord, type PluScan } from "./kretz/discovery";
import { auraPriceCandidates, parseAuraPlu } from "./kretz/aura-plu";
import { AURA_TEST_PLUS, AURA_TEST_PRODUCTS, getLastAuraWriteTest, type AuraWriteTestResult } from "./kretz/aura-write-test";
import { analyzeModelProbe, getLastModelProbe, type ModelProbeResult } from "./kretz/aura-model-probe";
import { AURA_ITEM_SCALE_CONFIG, planAuraSync, summarizeAuraPlan, type AuraSyncAction } from "./kretz/aura-sync";
import { saveBranchScaleConfig } from "../sale/scale-config-service";

/** El botón de diagnóstico de la Aura no se muestra todavía (decisión del dueño). */
const SHOW_AURA_DIAGNOSTIC = false;
/** La prueba de PLU 96 a 99 ya cumplió (2026-10-03): queda el código, pero no se muestra. */
const SHOW_AURA_TEST = false;

const AURA_ACTION_LABEL: Record<AuraSyncAction, string> = {
  crear: "Se crea",
  actualizar: "Cambia el precio",
  reemplazar: "Se reemplaza",
  sin_cambios: "Ya está igual",
  conflicto: "No se toca",
  omitir: "No se manda"
};
import { EVIDENCE_LABELS, KRETZ_MODELS, canWritePlu, getKretzModel, getSavedModelId, saveModelId, type KretzModelId } from "./kretz/models";

const BALANCE_NUMBER_KEY = "patagonia-scale-balance-number";
const VERIFIED_KEY = "patagonia-scale-verified";

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // no crítico
  }
}

/** Actividad de esta PC + el último "Probar todo" completo, para "Enviar a soporte". */
function supportLogText(): string {
  const record = getLastDiagnosticRecord();
  return record ? `${exportActivityLogText()}\n\n${summarizeDiagnosticRecord(record)}` : exportActivityLogText();
}

/** Con qué balanza/configuración se verificó el PLU de prueba (el envío masivo exige que coincida). */
function verificationKey(modelId: string, s: ScaleSerialSettings): string {
  return [modelId, s.baudRate, s.stopBits, s.deviceType, s.equipmentId].join("|");
}

/** Panel "Balanza por cable" completo (conectar, verificar compatibilidad,
 * envío masivo, un solo producto) como componente aparte -- lo usan tanto
 * Stock (con el catálogo entero, costo incluido) como Productos (la
 * pantalla del cajero, sin costo) pasándole solo `products`. Nace de un
 * pedido real: la balanza está conectada en la caja, pero el cable no lo
 * puede tocar el cajero porque Stock es una pantalla que no ve -- así que
 * este panel también vive en Productos, que el cajero sí puede abrir. */
export function ScaleSyncPanel({ products }: { products: ScaleSyncableProduct[] }) {
  const { profile } = useAuth();
  const [showScalePanel, setShowScalePanel] = useState(false);
  const [scaleSettings, setScaleSettings] = useState<ScaleSerialSettings>(getScaleSerialSettings());
  const [scalePortReady, setScalePortReady] = useState(false);
  const [scaleBusy, setScaleBusy] = useState(false);
  const [scaleSyncProgress, setScaleSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [scaleLog, setScaleLog] = useState("");
  const [scaleTestCode, setScaleTestCode] = useState("");
  const [showScalePreview, setShowScalePreview] = useState(false);
  const { branchId } = useActiveBranch();
  const [supportNote, setSupportNote] = useState("");
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [portLabel, setPortLabel] = useState<string | null>(null);
  const [pluScan, setPluScan] = useState<PluScan | null>(getLastPluScan());
  const [auraTest, setAuraTest] = useState<AuraWriteTestResult | null>(getLastAuraWriteTest());
  const [modelProbe, setModelProbe] = useState<ModelProbeResult | null>(getLastModelProbe());
  const stopScanRef = useRef(false);
  // Kretz Aura: envío real (kretz/aura-sync.ts)
  const [auraList, setAuraList] = useState<{ records: { plu: number; data: string }[]; complete: boolean; detail: string; readAt: string } | null>(null);
  const [auraReplace, setAuraReplace] = useState(false);
  const [auraShowPlan, setAuraShowPlan] = useState(false);
  const auraStopRef = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [modelId, setModelId] = useState<KretzModelId>(getSavedModelId());
  const [balanceNumber, setBalanceNumber] = useState(readLocal(BALANCE_NUMBER_KEY) ?? "1");
  const [verifiedKey, setVerifiedKey] = useState<string | null>(readLocal(VERIFIED_KEY));
  const model = getKretzModel(modelId);
  const writeAllowed = canWritePlu(model);
  // La Report LT ya funcionaba sin este paso: no se le agrega (pedido del dueño, 2026-10-02).
  // Para la Aura y otras Kretz, el envío masivo exige verificar antes con un producto de prueba.
  const verificationRequired = model.id !== "report-lt";
  const verified = !verificationRequired || verifiedKey === verificationKey(model.id, scaleSettings);
  const writeLockedReason = writeAllowed ? undefined : `Bloqueado: el envío de productos a ${model.label} todavía no está comprobado con una balanza real.`;

  useEffect(() => {
    void isScalePortPaired().then(setScalePortReady);
    void getScalePortDescription().then(setPortLabel);
  }, []);

  const scaleSyncPlan = planScaleSync(products);

  function updateScaleSettings(patch: Partial<ScaleSerialSettings>) {
    const next = { ...scaleSettings, ...patch };
    setScaleSettings(next);
    saveScaleSerialSettings(next);
  }

  /** Muestra el resultado y lo anota en la actividad de balanzas de esta PC (lo que se manda con "Enviar a soporte"). */
  function report(text: string) {
    setScaleLog(text);
    logScaleActivity({
      kind: /no respondi|fall|error|no se pudo|❌|no encontr/i.test(text) ? "error" : "test",
      connectionLabel: `Balanza por cable (${scaleSettings.baudRate} baudios, equipo ${scaleSettings.deviceType}${scaleSettings.equipmentId})`,
      message: text
    });
  }

  /** Devuelve true si llegó. `autoNote`: envío automático al terminar "Probar todo". */
  async function handleSendToSupport(autoNote?: string): Promise<boolean> {
    setSupportBusy(true);
    setSupportMessage("");
    try {
      await submitScaleSupportReport({
        note: autoNote ?? supportNote,
        logText: supportLogText(),
        connections: [
          {
            displayName: "Balanza por cable (Productos / Stock)",
            driverId: "kretz-report-plu (panel Balanza por cable)",
            status: scalePortReady ? "puerto elegido" : "sin puerto",
            settings: { ...scaleSettings, model: model.id, balanceNumber },
            diagnosticRecord: getLastDiagnosticRecord() ?? undefined,
            pluScan: getLastPluScan() ?? undefined,
            auraWriteTest: getLastAuraWriteTest() ?? undefined,
            auraModelProbe: getLastModelProbe() ?? undefined,
            confirmedCapabilities: [],
            pairedAt: "",
            connectedNow: scalePortReady
          }
        ],
        branchId: branchId ?? null
      });
      if (!autoNote) setSupportNote("");
      setSupportMessage("Listo, le llegó al equipo de Patagonia OS. Te vamos a contactar.");
      return true;
    } catch (err) {
      setSupportMessage(`No se pudo enviar: ${(err instanceof Error ? err.message : "error desconocido").replace(/\.$/, "")}. Sacale una captura a esta pantalla y mandala por WhatsApp.`);
      return false;
    } finally {
      setSupportBusy(false);
    }
  }

  async function handleConnectScale() {
    setScaleBusy(true);
    setScaleLog("");
    try {
      await connectScalePort();
      setScalePortReady(true);
      const label = await getScalePortDescription();
      setPortLabel(label);
      report(`Puerto elegido: ${label ?? "?"}. Ahora tocá "Probar todo".`);
    } catch (err) {
      report(err instanceof Error ? err.message : "No se pudo conectar con el puerto.");
    } finally {
      setScaleBusy(false);
    }
  }

  /** "Probar todo": dice en un click si es el cable/puerto o el modo de la balanza (scale-serial.ts → diagnoseScaleLink). */
  async function handleDiagnose() {
    setScaleBusy(true);
    setScaleLog("Probando… no desenchufes la balanza ni cierres esta pantalla (tarda hasta un minuto).");
    try {
      const d = await diagnoseScaleLink((text) => setScaleLog(text), { modelId: model.id, balanceNumber });
      setScaleSettings(getScaleSerialSettings());
      setScalePortReady(true);
      setPortLabel(d.portLabel);
      const technical = [
        `Puerto: ${d.portLabel}.`,
        `Prueba de peso (9600, 2 bits de stop): ${d.weightRaw ? JSON.stringify(d.weightRaw.slice(0, 80)) : "no llegó nada"}.`,
        d.dataResponseHex ? `Respuesta en modo datos: ${d.dataResponseHex}.` : `Modo datos: ${d.attempts - 1} combinaciones probadas, ninguna contestó como balanza Kretz.`
      ].join(" ");
      report(`${d.message}\n\nDetalle para soporte: ${technical}`);

      // Modelos todavía no habilitados (Aura, otra Kretz): todo de una, para no
      // tener que pedirle al cliente varias pruebas. Si la balanza contestó, se
      // leen sus productos (solo lectura) y se manda todo a soporte solo.
      if (model.id !== "report-lt") {
        let scanLine = "";
        if (d.record.responder) {
          stopScanRef.current = false;
          setScanning(true);
          try {
            const scan = await scanScalePlus((text) => setScaleLog(text), () => stopScanRef.current);
            setPluScan(scan);
            scanLine = `Productos leídos de la balanza: ${scan.records.length}${scan.stoppedBy === "fin" || scan.stoppedBy === "cancelado" ? "" : ` (se cortó: ${scan.lastDetail})`}.`;
          } finally {
            setScanning(false);
          }
        }
        const canSend = profile?.role === "owner" || profile?.role === "admin";
        const sent = canSend ? await handleSendToSupport("Probar todo (envío automático)") : false;
        setScaleLog(
          `${d.message}\n\n${scanLine ? `${scanLine}\n\n` : ""}` +
            (sent
              ? "✅ Listo: el resultado completo ya le llegó al equipo de Patagonia OS. No hace falta hacer nada más."
              : canSend
                ? "No se pudo mandar el resultado a soporte: sacale una foto a esta pantalla y mandala por WhatsApp."
                : "Para que nos llegue el resultado, el dueño o un administrador tiene que tocar \"Enviar a soporte\" (abajo).") +
            `\n\nDetalle para soporte: ${technical}`
        );
      }
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló la prueba.");
    } finally {
      setScaleBusy(false);
    }
  }

  /** Aura: lee todo lo que hay en la balanza (solo lectura) para armar el envío y guardar una copia. */
  async function handleAuraRead() {
    setScaleBusy(true);
    setScaleLog("Leyendo los productos de la balanza… no desenchufes el cable.");
    try {
      const r = await readAuraListOnScale((text) => setScaleLog(text));
      setAuraList({ records: r.records, complete: r.complete, detail: r.detail, readAt: new Date().toISOString() });
      report(r.complete ? `Listo: ${r.detail}. Revisá abajo qué se va a mandar.` : `No se pudo leer la balanza completa: ${r.detail}. No se va a mandar nada hasta poder leerla.`);
    } catch (err) {
      report(err instanceof Error ? err.message : "No se pudo leer la balanza.");
    } finally {
      setScaleBusy(false);
    }
  }

  function downloadAuraBackup() {
    if (!auraList) return;
    const text = auraList.records.map((r) => r.data).join("\r\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `copia_balanza_aura_${auraList.readAt.slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleAuraSend(plan: ReturnType<typeof planAuraSync>) {
    const s = summarizeAuraPlan(plan);
    const total = s.crear + s.actualizar + s.reemplazar;
    // El ajuste del código de barras se manda SIEMPRE a la balanza conectada: un local puede tener
    // varias Aura con el mismo cable (caso real, Pollo y mar, 2026-10-06) y no hay cómo distinguirlas.
    // Mandarlo de nuevo no cambia nada si ya estaba ajustada.
    const barcode = true;
    const what = total > 0 ? `Se van a mandar ${total} productos a la balanza (${s.crear} nuevos, ${s.actualizar} con precio nuevo${s.reemplazar ? `, ${s.reemplazar} reemplazos` : ""})` : "No hay productos para mandar";
    if (!window.confirm(`${what}${barcode ? ". También se ajusta el código de barras de los tickets para que Mostrador los lea" : ""}. No se borra nada. Tarda unos minutos: no desenchufes la balanza ni cierres esta pantalla. ¿Seguir?`)) return;
    auraStopRef.current = false;
    setScaleBusy(true);
    setScaleLog("Mandando productos a la balanza…");
    try {
      const r = await runAuraSyncOnScale(plan, (text) => setScaleLog(text), () => auraStopRef.current, barcode);
      const barcodeText =
        r.barcode === "ok"
          ? " También se ajustó el código de barras de los tickets: desde ahora Mostrador los lee con el importe."
          : r.barcode === "rechazada"
            ? " La balanza no aceptó el ajuste del código de barras."
            : r.barcode === "sin_respuesta"
              ? " La balanza no contestó el ajuste del código de barras."
              : "";
      if (r.after.length || r.before.length) setAuraList({ records: r.after.length ? r.after : r.before, complete: r.verdict === "ok", detail: r.detail, readAt: new Date().toISOString() });
      if (r.verdict === "ok") {
        report(`✅ Listo: ${r.detail}. Los demás productos de la balanza quedaron igual.${barcodeText}`);
      } else {
        const canSend = profile?.role === "owner" || profile?.role === "admin";
        const sent = canSend ? await handleSendToSupport(`Envío Aura (${r.verdict}): ${r.detail}`) : false;
        report(`❌ Se frenó: ${r.detail}. Se mandaron bien ${r.written.length} productos antes de frenar.\n\n${sent ? "El detalle ya le llegó al equipo de Patagonia OS." : "Sacale una foto a esta pantalla y mandala por WhatsApp."}`);
      }
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló el envío.");
    } finally {
      setScaleBusy(false);
    }
  }

  /**
   * Aura: código de barras por producto en el ticket (1080, kretz/aura-sync.ts). Si la balanza lo
   * acepta, Mostrador de esta sucursal pasa a leer esos códigos (2-3-7 con importe). Siempre manda
   * el resultado a soporte (dueño/admin), para no tener que pedirle fotos a la clienta.
   */
  async function handleAuraItemBarcodes(enable: boolean) {
    const question = enable
      ? "Se le va a pedir a la balanza que en cada ticket imprima un código de barras por producto (además del total). No toca productos ni precios, y se puede apagar. ¿Seguir?"
      : "Se le va a pedir a la balanza que vuelva a imprimir solo el código del total. ¿Seguir?";
    if (!window.confirm(question)) return;
    setScaleBusy(true);
    setScaleLog(enable ? "Activando el código por producto…" : "Apagando el código por producto…");
    try {
      const r = await setAuraItemBarcodesOnScale(enable, (text) => setScaleLog(text));
      logScaleActivity({ kind: r.verdict === "ok" ? "test" : "error", message: `Aura código por producto (${enable ? "activar" : "apagar"}): ${r.verdict} - ${r.detail}` });
      let mostradorText = "";
      if (r.verdict === "ok" && enable && branchId) {
        try {
          await saveBranchScaleConfig(branchId, AURA_ITEM_SCALE_CONFIG);
          mostradorText = " Mostrador de esta sucursal ya quedó preparado para leer esos códigos.";
        } catch {
          mostradorText = " Pero no se pudo preparar Mostrador: avisale al equipo de Patagonia OS.";
        }
      }
      const canSend = profile?.role === "owner" || profile?.role === "admin";
      const exchanges = r.exchanges.map((e) => `${e.step}: tx ${e.tx} | rx ${e.rx || "(nada)"}${e.kretz ? ` [${e.kretz.code}]` : ""}`).join("\n");
      const sent = canSend ? await handleSendToSupport(`Aura código por producto (1080 ${enable ? "1" : "0"}): ${r.verdict} - ${r.detail}\n${exchanges}`) : false;
      const supportText = sent ? " El resultado ya le llegó al equipo de Patagonia OS." : "";
      if (r.verdict === "ok") {
        report(
          enable
            ? `✅ La balanza aceptó imprimir un código por producto.${mostradorText}\n\nAhora: pesá 2 productos, imprimí el ticket y en Mostrador escaneá el código de CADA producto (no el del total de abajo).${supportText}`
            : `✅ La balanza vuelve a imprimir solo el código del total.${supportText}`
        );
      } else if (r.verdict === "rechazada") {
        report(`Esta balanza no tiene la opción de un código por producto (${r.detail}). No se cambió nada: los tickets siguen saliendo con el código del total, que Mostrador lee igual.${supportText}`);
      } else {
        report(`❌ No se pudo: ${r.detail}. No se cambió nada.${supportText}`);
      }
    } catch (err) {
      report(err instanceof Error ? err.message : "No se pudo hablar con la balanza.");
    } finally {
      setScaleBusy(false);
    }
  }

  /** Aura: carga los productos de prueba (PLU 96 a 99), los relee y comprueba que los de la clienta no cambiaron (kretz/aura-write-test.ts). */
  async function handleAuraWriteTest() {
    setScaleBusy(true);
    setScaleLog("Cargando los productos de prueba… no desenchufes la balanza ni cierres esta pantalla.");
    try {
      const r = await runAuraWriteTestOnScale((text) => setScaleLog(text));
      setAuraTest(r);
      const text =
        r.verdict === "ok"
          ? `✅ Se cargaron los productos de prueba (PLU ${AURA_TEST_PLUS.join(", ")}) y tus productos no cambiaron.`
          : r.verdict === "plu_ocupado" || r.verdict === "lectura_incompleta" || r.verdict === "sin_respuesta" || r.verdict === "puerto"
            ? `No se cargó nada: ${r.detail}.`
            : `❌ La prueba no salió bien: ${r.detail}.`;
      const canSend = profile?.role === "owner" || profile?.role === "admin";
      const sent = canSend ? await handleSendToSupport("Prueba de escritura Aura (envío automático)") : false;
      report(`${text}

${sent ? "El resultado ya le llegó al equipo de Patagonia OS." : "Sacale una foto a esta pantalla y mandala por WhatsApp."}`);
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló la prueba.");
    } finally {
      setScaleBusy(false);
    }
  }

  /** Aura: lee el modelo de datos de la balanza (SOLO LECTURA) para saber si el registro admite tipo y código. */
  async function handleModelProbe() {
    setScaleBusy(true);
    setScaleLog("Leyendo la balanza (no cambia nada)…");
    try {
      const r = await runAuraModelProbeOnScale((text) => setScaleLog(text));
      setModelProbe(r);
      const a = analyzeModelProbe(r);
      const canSend = profile?.role === "owner" || profile?.role === "admin";
      const sent = canSend ? await handleSendToSupport("Diagnóstico Aura (envío automático)") : false;
      report(`${a.lines.join(" ")}

${sent ? "✅ Listo: el resultado ya le llegó al equipo de Patagonia OS." : "Sacale una foto a esta pantalla y mandala por WhatsApp."}`);
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló la lectura.");
    } finally {
      setScaleBusy(false);
    }
  }

  /** Lee todos los productos guardados en la balanza (solo lectura): para comprobar el formato y como copia de seguridad. */
  async function handleScanPlus() {
    stopScanRef.current = false;
    setScaleBusy(true);
    setScanning(true);
    setScaleLog("Leyendo los productos de la balanza… no la desconectes (con muchos productos tarda unos minutos).");
    try {
      const scan = await scanScalePlus((text) => setScaleLog(text), () => stopScanRef.current);
      setPluScan(scan);
      const why = scan.stoppedBy === "fin" ? "llegó al final" : scan.stoppedBy === "cancelado" ? "la detuviste" : scan.stoppedBy === "limite" ? "llegó al límite" : `se cortó: ${scan.lastDetail}`;
      report(`Lectura de productos de la balanza: ${scan.records.length} leídos (${why}). No se escribió nada. Quedó guardada como copia de seguridad en esta PC.`);
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló la lectura de productos.");
    } finally {
      setScanning(false);
      setScaleBusy(false);
    }
  }

  function downloadPluScan() {
    if (!pluScan) return;
    const rows = [["plu", "nombre", "tipo", "codigo", "precio_6_digitos", "tara", "validez", "datos_crudos"]];
    for (const r of pluScan.records) {
      const a = model.id === "aura" ? parseAuraPlu(r.data) : null;
      rows.push(a ? [String(a.plu), a.name, a.type, a.code, a.priceRaw, a.tareRaw, String(a.validityDays), r.data] : [String(r.plu), "", "", "", "", "", "", r.data]);
    }
    const csv = rows.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    // BOM al principio para que Excel lo abra con acentos.
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `productos-balanza-${pluScan.startedAt.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handlePingScale() {
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await sendScalePing();
      report(
        result.ok
          ? `La balanza respondió: ${result.rawResponseHex || "(sin bytes)"} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`
          : "La balanza no respondió nada -- revisá el cable, o probá otra velocidad de puerto."
      );
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló la prueba de conexión.");
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
        report(
          `¡Encontré tu balanza! Respondió con ${result.settings.baudRate} baudios, ${result.settings.stopBits} bit(s) de stop y equipo "${result.settings.deviceType}${result.settings.equipmentId}" (respuesta: ${result.rawResponseHex}). Ya quedó guardado: ahora usá "Verificar compatibilidad".`
        );
      } else {
        setScaleSettings(getScaleSerialSettings());
        report(
          `Probé ${result.attempts} combinaciones y la balanza no respondió a ninguna. Revisá: 1) el cable (derecho, 1 a 1), 2) que la balanza esté en el menú COMUNI → MODO = "Datos" (la Aura) o el modo de comunicación con PC (otras Kretz), 3) que el adaptador USB tenga su driver instalado. Si todo está bien, mandá una captura de esta pantalla al equipo de Patagonia OS.`
        );
      }
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló la detección automática.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleCheckCompatibility() {
    setScaleBusy(true);
    setScaleLog("Probando compatibilidad… esto carga y borra un producto de prueba en la balanza, no toca productos reales.");
    try {
      if (!writeAllowed) throw new Error(writeLockedReason);
      const result = await checkScaleCompatibility();
      if (result.compatible) {
        const key = verificationKey(model.id, getScaleSerialSettings());
        writeLocal(VERIFIED_KEY, key);
        setVerifiedKey(key);
      }
      const details = [
        `Conexión: ${result.pingOk ? "OK" : "sin respuesta"}.`,
        result.writeResponseCode ? `Escritura de prueba: código "${result.writeResponseCode}".` : "",
        result.readResponseCode ? `Relectura: código "${result.readResponseCode}".` : ""
      ].filter(Boolean).join(" ");
      report(`${result.compatible ? "✅" : "❌"} ${result.message} ${details}`);
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló la prueba de compatibilidad.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleSyncScale() {
    if (!writeAllowed) return report(writeLockedReason ?? "Bloqueado.");
    if (!verified) return report("Primero hacé \"Verificar con un PLU de prueba\": el envío masivo se habilita recién cuando el producto de prueba se grabó y se releyó bien con esta balanza.");
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
      report(parts.join(" "));
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló el envío a la balanza.");
    } finally {
      setScaleBusy(false);
      setScaleSyncProgress(null);
    }
  }

  async function handleSendOneProduct() {
    if (!writeAllowed) return report(writeLockedReason ?? "Bloqueado.");
    const product = products.find((p) => p.code === scaleTestCode.trim());
    if (!product) {
      report(`No encontré ningún producto con código "${scaleTestCode.trim()}".`);
      return;
    }
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await syncOneProductToScale(product);
      report(
        `Mandé "${product.name}" (código ${product.code}, ${product.priceRetail}). Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`
      );
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló el envío del producto.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleReadPlu() {
    if (!scaleTestCode.trim()) {
      report("Ingresá un código de PLU para leer.");
      return;
    }
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await readScalePlu(scaleTestCode.trim());
      report(
        `Leí PLU ${scaleTestCode.trim()}. Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}. Datos como texto: "${result.rawDataAscii}"`
      );
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló la lectura del PLU.");
    } finally {
      setScaleBusy(false);
    }
  }

  async function handleDeletePlu() {
    if (!writeAllowed) return report(writeLockedReason ?? "Bloqueado.");
    const code = scaleTestCode.trim();
    if (!code) {
      report("Ingresá un código de PLU para borrar.");
      return;
    }
    if (!window.confirm(`¿Seguro que querés borrar el PLU ${code} de la balanza? Esto borra el registro de la balanza (no de Patagonia OS).`)) return;
    setScaleBusy(true);
    setScaleLog("");
    try {
      const result = await deleteScalePlu(code);
      report(`Borré PLU ${code}. Respuesta: ${result.rawResponseHex} -- código "${result.responseCode}": ${describeResponseCode(result.responseCode)}`);
    } catch (err) {
      report(err instanceof Error ? err.message : "Falló el borrado del PLU.");
    } finally {
      setScaleBusy(false);
    }
  }

  // La balanza por cable es del plan Estándar en adelante.
  if (!planAllows(profile, "estandar")) return null;

  const stepTitle = { margin: "0 0 8px", fontWeight: 700, fontSize: 13, textTransform: "uppercase", color: "#666" } as const;
  const step = { borderTop: "1px solid #eef0f3", paddingTop: 14, marginBottom: 14 } as const;
  const noSerial = !isScaleSerialSupported();
  const EVIDENCE_COLORS: Record<string, string> = { real: "#176329", documentado: "#1d4ed8", terceros: "#6b7280", hipotesis: "#8a4b00", desconocido: "#8a1f11" };

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
          {noSerial && (
            <p style={{ margin: "0 0 14px", color: "#8a4b00", fontWeight: 700 }}>
              Este navegador no soporta esto -- abrí Patagonia OS en Chrome o Edge.
            </p>
          )}

          {/* 1. Modelo */}
          <div style={step}>
            <p style={stepTitle}>1. ¿Qué balanza es?</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <select
                value={model.id}
                disabled={scaleBusy}
                onChange={(e) => {
                  const id = e.target.value as KretzModelId;
                  saveModelId(id);
                  setModelId(id);
                }}
              >
                {KRETZ_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              {model.id !== "report-lt" && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                  Número de balanza
                  <input
                    type="number"
                    min={1}
                    max={99}
                    step={1}
                    style={{ width: 70 }}
                    value={balanceNumber}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                      setBalanceNumber(v);
                      writeLocal(BALANCE_NUMBER_KEY, v || null);
                    }}
                  />
                  <span className="muted" style={{ fontSize: 12 }}>(en la balanza: menú DATOS → n_bal; de fábrica es 1)</span>
                </label>
              )}
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 13 }}>
              Envío de productos a esta balanza:{" "}
              {model.id === "aura" ? (
                <strong style={{ color: "#176329" }}>habilitado, por kilo y por unidad en pesos enteros (comprobado con una Aura real)</strong>
              ) : writeAllowed ? (
                <strong style={{ color: "#176329" }}>habilitado (comprobado con una balanza real)</strong>
              ) : (
                <strong style={{ color: "#8a1f11" }}>bloqueado hasta comprobarlo con una balanza real</strong>
              )}
            </p>
            {!writeAllowed && model.id !== "aura" && (
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                Mientras tanto, "Probar todo" averigua cómo se comunica esta balanza SIN escribir nada en ella, y "Enviar a soporte" nos manda el resultado para terminar de habilitarla.
              </p>
            )}
            <details style={{ marginTop: 10, fontSize: 13 }}>
              <summary style={{ fontWeight: 600 }}>Qué sabemos de esta balanza y cómo lo sabemos</summary>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
                {model.facts.map((f) => (
                  <li key={f.text}>
                    {f.text}{" "}
                    <span style={{ color: EVIDENCE_COLORS[f.evidence], fontWeight: 700, whiteSpace: "nowrap" }}>[{EVIDENCE_LABELS[f.evidence]}]</span>
                    <span className="muted" style={{ fontSize: 12 }}> — {f.source}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          {/* 2. Conexión */}
          <div style={step}>
            <p style={stepTitle}>2. Conectar y probar</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className={scalePortReady ? "secondary" : undefined} disabled={scaleBusy || noSerial} onClick={handleConnectScale}>
                {scalePortReady ? "Elegir otro puerto" : "Elegir el puerto"}
              </button>
              <button disabled={scaleBusy || noSerial || !scalePortReady} onClick={handleDiagnose}>
                Probar todo
              </button>
            </div>
            {portLabel && (
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                Puerto elegido: <strong>{portLabel}</strong>
              </p>
            )}
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              "Probar todo" prueba todas las formas de comunicarse y te dice si el problema es el cable, el puerto o el modo de la balanza. No escribe nada en la balanza (como mucho hace un "bip"). Tarda hasta dos minutos.
              {model.id !== "report-lt" && " Con esta balanza además lee sus productos y nos manda el resultado a soporte solo: no hace falta tocar nada más."}
            </p>
            {model.id === "aura" && (
              <details style={{ marginTop: 10, fontSize: 13 }} open={!scalePortReady}>
                <summary style={{ fontWeight: 600 }}>Kretz Aura: cómo se conecta</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 4 }}>
                  <li>Cable serie <strong>directo</strong> (pin 2 con 2, 3 con 3, 5 con 5): <strong>macho</strong> del lado de la balanza y hembra del lado de la PC. Los cables "null modem", "cruzados" o el cable de PC de otras Kretz no sirven. Si la PC no tiene puerto serie, un adaptador USB a serie.</li>
                  <li>En la balanza: menú de usuario (clave de fábrica 99999) → <strong>COMUNI</strong> → MODO = <strong>"Datos"</strong> y PUERT = <strong>RS-232</strong>. (Para que Mostrador lea el peso, en cambio, MODO = "A pedido de peso".)</li>
                  <li>La Aura usa 9600 baudios y 2 bits de stop: "Probar todo" ya lo prueba solo.</li>
                </ul>
              </details>
            )}
            <details style={{ marginTop: 10 }}>
              <summary className="secondary" style={{ display: "inline-block", cursor: "pointer", padding: "8px 14px", border: "1px solid #d6dce5", borderRadius: 10, fontSize: 14, fontWeight: 700, color: "#47505c" }}>
                Configuración avanzada
              </summary>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                <button disabled={scaleBusy || noSerial || !scalePortReady} className="secondary" onClick={handleAutoDetect}>
                  Detectar mi balanza automáticamente
                </button>
                <button disabled={scaleBusy || noSerial} className="secondary" onClick={handlePingScale}>
                  Probar conexión
                </button>
              </div>
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
                "Probar todo" completa esto solo. Solo tocar si soporte te lo pide.
              </p>
            </details>
          </div>

          {/* Productos guardados en la balanza (solo lectura) — para modelos todavía no habilitados */}
          {model.id !== "report-lt" && (
            <div style={step}>
              <p style={stepTitle}>Productos guardados en la balanza (solo lectura)</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button disabled={scaleBusy || noSerial || !scalePortReady} onClick={() => void handleScanPlus()}>
                  Leer productos de la balanza
                </button>
                {scanning && (
                  <button className="secondary" onClick={() => { stopScanRef.current = true; }}>
                    Detener
                  </button>
                )}
                {pluScan && !scanning && (
                  <button className="secondary" onClick={downloadPluScan}>
                    Descargar copia (Excel / CSV)
                  </button>
                )}
              </div>
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Lee lo que la balanza tiene cargado, sin cambiar nada. Usar después de "Probar todo". Queda como copia de seguridad en esta PC y viaja con "Enviar a soporte".
              </p>
              {pluScan && (
                <>
                  <p style={{ margin: "10px 0 6px", fontSize: 13 }}>
                    <strong>{pluScan.records.length}</strong> productos leídos el {new Date(pluScan.startedAt).toLocaleString("es-AR")}.
                  </p>
                  {pluScan.records.length === 0 && (
                    <p className="message warning" style={{ margin: "0 0 8px" }}>
                      {pluScan.stoppedBy === "fin" && pluScan.lastCode && pluScan.lastCode !== "01"
                        ? `La balanza contestó que no tiene productos cargados (${pluScan.lastDetail}).`
                        : `La balanza no contestó la lectura (${pluScan.lastDetail || "sin respuesta"}). Revisá que esté en modo Datos (menú → COMUNI → MODO = dAtOS), tocá "Probar todo" y después de nuevo "Leer productos de la balanza".`}
                    </p>
                  )}
                  {model.id === "aura" && (
                    <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
                      Las columnas con (?) todavía no están confirmadas. Para comprobarlas, compará con la lista que imprime la balanza (menú → LISTAR → PRECI).
                    </p>
                  )}
                  <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
                    <table className="data-table">
                      <thead>
                        {model.id === "aura" ? (
                          <tr><th>PLU</th><th>Nombre</th><th>Tipo (?)</th><th>Código (?)</th><th className="num">Precio (?)</th><th>Tara (?)</th><th>Validez (?)</th></tr>
                        ) : (
                          <tr><th>PLU</th><th>Datos tal cual</th></tr>
                        )}
                      </thead>
                      <tbody>
                        {pluScan.records.slice(0, 200).map((r) => {
                          const a = model.id === "aura" ? parseAuraPlu(r.data) : null;
                          if (!a) return <tr key={r.plu}><td>{r.plu}</td><td style={{ fontFamily: "monospace" }} colSpan={6}>{r.data}</td></tr>;
                          const price = auraPriceCandidates(a.priceRaw);
                          return (
                            <tr key={r.plu}>
                              <td>{a.plu}</td>
                              <td>{a.name}</td>
                              <td>{a.type}</td>
                              <td>{a.code}</td>
                              <td className="num">{price.sinDecimales} <span className="muted">ó {price.conDosDecimales.toFixed(2)}</span></td>
                              <td>{a.tareRaw}</td>
                              <td>{a.validityDays} días</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {pluScan.records.length > 200 && <p className="muted" style={{ fontSize: 12 }}>Mostrando 200 de {pluScan.records.length}. La copia descargable tiene todos.</p>}
                </>
              )}
            </div>
          )}

          {/* Aura: diagnóstico (solo lectura). Oculto hasta que el dueño lo autorice (2026-10-03): el código queda listo. */}
          {SHOW_AURA_DIAGNOSTIC && model.id === "aura" && (
            <div style={step}>
              <p style={stepTitle}>Kretz Aura: diagnóstico (solo lectura)</p>
              <button disabled={scaleBusy || noSerial} onClick={() => void handleModelProbe()}>
                Diagnóstico de la balanza
              </button>
              {modelProbe && (
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 12, whiteSpace: "pre-wrap" }}>
                  {analyzeModelProbe(modelProbe).lines.join(" ")}
                </p>
              )}
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Lee los datos técnicos de la balanza y la lista de productos. Solo lee: no cambia ni borra nada. El resultado se manda solo a soporte.
              </p>
            </div>
          )}

          {/* 3 (Aura). Envío real de productos */}
          {model.id === "aura" && (() => {
            const auraProducts = products
              .filter((p) => p.active ?? true)
              .map((p) => ({ code: p.code, name: p.name, byWeight: p.unit === "kg", price: p.priceRetail }));
            const auraPlan = auraList?.complete ? planAuraSync(auraList.records.map((r) => r.data), auraProducts, { replaceConflicts: auraReplace }) : [];
            const sum = summarizeAuraPlan(auraPlan);
            const toSend = sum.crear + sum.actualizar + sum.reemplazar;
            const conflicts = auraList?.complete ? summarizeAuraPlan(planAuraSync(auraList.records.map((r) => r.data), auraProducts)).conflicto : 0;
            return (
              <div style={step}>
                <p style={stepTitle}>3. Mandar productos a la balanza</p>
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
                  Primero leé la balanza: Patagonia guarda una copia de lo que tiene y te muestra qué va a hacer con cada producto. Los productos por kilo se cargan por kilo y los por unidad, por unidad; el precio va en pesos enteros (se redondea al peso). El número de producto en la balanza es el código del producto en Patagonia. No borra nada de la balanza.
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button disabled={scaleBusy || noSerial || !scalePortReady} onClick={() => void handleAuraRead()}>
                    {auraList ? "Volver a leer la balanza" : "Leer la balanza"}
                  </button>
                  {auraList && (
                    <button className="secondary" disabled={scaleBusy} onClick={downloadAuraBackup}>
                      Descargar copia de la balanza ({auraList.records.length})
                    </button>
                  )}
                </div>
                {auraList?.complete && (
                  <>
                    <p style={{ margin: "12px 0 6px", fontSize: 14 }}>
                      En la balanza hay <strong>{auraList.records.length}</strong> productos. Con los {auraProducts.length} productos activos de Patagonia:{" "}
                      <strong>{sum.crear}</strong> se crean, <strong>{sum.actualizar}</strong> cambian de precio
                      {sum.reemplazar > 0 && <>, <strong>{sum.reemplazar}</strong> se reemplazan</>}, {sum.sin_cambios} ya están igual
                      {sum.conflicto > 0 && <>, <strong style={{ color: "#8b1e1e" }}>{sum.conflicto}</strong> no se tocan (en la balanza ese número es otro producto)</>}
                      {sum.omitir > 0 && <>, {sum.omitir} no se pueden mandar</>}.
                    </p>
                    {conflicts > 0 && (
                      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, margin: "6px 0" }}>
                        <input type="checkbox" checked={auraReplace} disabled={scaleBusy} onChange={(e) => setAuraReplace(e.target.checked)} />
                        <span>Reemplazar los {conflicts} productos de la balanza que tienen el mismo número que un producto de Patagonia pero con otro nombre (se pisan con el de Patagonia).</span>
                      </label>
                    )}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                      <button disabled={scaleBusy || noSerial} onClick={() => void handleAuraSend(auraPlan)}>
                        {toSend > 0 ? `Mandar ${toSend} productos a la balanza` : "Ajustar el código de barras de la balanza"}
                      </button>
                      {scaleBusy && (
                        <button className="secondary" onClick={() => { auraStopRef.current = true; }}>
                          Frenar
                        </button>
                      )}
                      <button className="secondary" disabled={scaleBusy} onClick={() => setAuraShowPlan((v) => !v)}>
                        {auraShowPlan ? "Ocultar detalle" : "Ver detalle"}
                      </button>
                    </div>
                    {auraShowPlan && (
                      <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid #eef0f3", borderRadius: 6, marginTop: 10 }}>
                        <table className="data-table">
                          <thead>
                            <tr><th>N.º</th><th>Producto</th><th>Qué pasa</th><th>Detalle</th></tr>
                          </thead>
                          <tbody>
                            {auraPlan.map((it, idx) => (
                              <tr key={idx}>
                                <td>{it.plu ?? "-"}</td>
                                <td>{it.name}</td>
                                <td>{AURA_ACTION_LABEL[it.action]}</td>
                                <td className="muted" style={{ fontSize: 12 }}>{it.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}

          {/* 4 (Aura). Código de barras por producto en el ticket (1080) */}
          {model.id === "aura" && (
            <div style={step}>
              <p style={stepTitle}>4. Código de barras por producto en el ticket</p>
              <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
                Hoy el ticket trae un solo código de barras con el total: Mostrador cobra la plata pero no sabe qué productos ni cuántos kilos, y no descuenta stock.
                Con esta opción la balanza imprime además un código por cada producto: al escanearlos, Mostrador carga cada producto con sus kilos y descuenta stock.
                No toca productos ni precios. Si la balanza no tiene esta opción, avisa y no cambia nada.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button disabled={scaleBusy || noSerial || !scalePortReady} onClick={() => void handleAuraItemBarcodes(true)}>
                  Imprimir un código por producto
                </button>
                <button className="secondary" disabled={scaleBusy || noSerial || !scalePortReady} onClick={() => void handleAuraItemBarcodes(false)}>
                  Volver a solo el total
                </button>
              </div>
            </div>
          )}

          {/* (Aura) Prueba de escritura de los PLU 96 a 99: ya cumplió, queda oculta */}
          {model.id === "aura" && SHOW_AURA_TEST && (
            <div style={step}>
              <p style={stepTitle}>Kretz Aura: cargar productos de prueba</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button disabled={scaleBusy || noSerial || !scalePortReady || !getLastDiagnosticRecord()?.responder} onClick={() => void handleAuraWriteTest()}>
                  Cargar productos de prueba (PLU {Math.min(...AURA_TEST_PLUS)} a {Math.max(...AURA_TEST_PLUS)})
                </button>
                {auraTest && (
                  <span className={auraTest.verdict === "ok" ? undefined : "muted"} style={{ fontSize: 13 }}>
                    {auraTest.verdict === "ok" ? "✓ Cargados" : `Última prueba: ${auraTest.detail}`}
                  </span>
                )}
              </div>
              {auraTest?.items && auraTest.items.length > 0 && (
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table className="data-table">
                    <thead>
                      <tr><th>PLU</th><th>Mandado</th><th>Quedó en la balanza</th><th>Distinto</th></tr>
                    </thead>
                    <tbody>
                      {auraTest.items.map((it, idx) => (
                        <tr key={idx}>
                          <td>{it.plu}</td>
                          <td style={{ fontFamily: "monospace", fontSize: 12 }}>{it.sent}</td>
                          <td style={{ fontFamily: "monospace", fontSize: 12 }}>{it.readBack ?? `(no se pudo releer; código ${it.writeCode ?? "-"})`}</td>
                          <td>{it.same ? Object.entries(it.same).filter(([, ok]) => !ok).map(([k]) => k).join(", ") || "nada" : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Carga {AURA_TEST_PRODUCTS.map((p) => `"${p.name}" (PLU ${p.plu})`).join(", ")}, los vuelve a leer (por kilo y por unidad, con precios en pesos enteros), después le cambia el precio a uno y comprueba que no se pierda nada. Después de cada paso revisa que tus productos sigan igual (si algo no coincide, frena). Solo usa esos números: si alguno tiene otro producto, no carga nada. No cambia ni borra ningún producto tuyo, y no borra nada de la balanza. Usar después de "Probar todo".
              </p>
            </div>
          )}

          {model.id !== "aura" && (<>
          {/* 3. Verificar con un PLU de prueba */}
          <div style={step}>
            <p style={stepTitle}>3. Verificar con un producto de prueba</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button disabled={scaleBusy || noSerial || !writeAllowed} title={writeLockedReason} onClick={handleCheckCompatibility}>
                Verificar con un producto de prueba
              </button>
              {!verificationRequired ? (
                <span className="muted" style={{ fontSize: 13 }}>Opcional con esta balanza.</span>
              ) : verified ? (
                <strong style={{ color: "#176329", fontSize: 13 }}>✓ Verificado con esta balanza</strong>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>Todavía no verificado con esta configuración.</span>
              )}
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              Graba un producto de prueba en un código libre, lo vuelve a leer para comprobar que quedó exactamente igual y lo borra. Si ese código ya tiene un producto real, no hace nada. El envío de todos los productos se habilita recién cuando esto sale bien.
            </p>
          </div>

          {/* 4. Envío */}
          <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 14 }}>
            <p style={stepTitle}>4. Mandar productos</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="Código del producto (ej. 12)"
                style={{ width: 200 }}
                value={scaleTestCode}
                onChange={(e) => setScaleTestCode(e.target.value)}
              />
              <button disabled={scaleBusy || noSerial || !writeAllowed} title={writeLockedReason} className="secondary" onClick={handleSendOneProduct}>
                Enviar uno
              </button>
              <button disabled={scaleBusy || noSerial || !writeAllowed} title={writeLockedReason} className="secondary" onClick={handleReadPlu}>
                Leer de la balanza
              </button>
              <button disabled={scaleBusy || noSerial || !writeAllowed} title={writeLockedReason} className="danger" onClick={handleDeletePlu}>
                Borrar de la balanza
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <button disabled={scaleBusy || noSerial} className="secondary" onClick={() => setShowScalePreview((v) => !v)}>
                {showScalePreview ? "Ocultar vista previa" : `Vista previa (${scaleSyncPlan.toSend.length} productos)`}
              </button>
              <button
                disabled={scaleBusy || noSerial || !writeAllowed || !verified}
                title={!writeAllowed ? writeLockedReason : !verified ? "Primero verificá con un producto de prueba (paso 3)" : undefined}
                onClick={handleSyncScale}
              >
                {scaleBusy && scaleSyncProgress ? `Enviando… ${scaleSyncProgress.done}/${scaleSyncProgress.total}` : "Enviar todos los productos"}
              </button>
            </div>
            {writeAllowed && !verified && (
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>"Enviar todos los productos" se habilita después de verificar con un producto de prueba (paso 3).</p>
            )}
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
          </>)}

          {scaleLog && (
            <p style={{ margin: "14px 0 0", fontSize: 13, whiteSpace: "pre-wrap", background: "#f7f7f8", borderRadius: 6, padding: 10 }}>{scaleLog}</p>
          )}

          {/* Solo dueño y administrador pueden mandar el reporte (submit_scale_support_report, migración 100). */}
          {(profile?.role === "owner" || profile?.role === "admin") && (
          <div style={{ borderTop: "1px solid #eef0f3", paddingTop: 14, marginTop: 14 }}>
            <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 13, textTransform: "uppercase", color: "#666" }}>¿Algo no anda? Enviar a soporte</p>
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
              Le manda al equipo de Patagonia OS lo que pasó con la balanza en esta PC (pruebas, errores, configuración). No manda ventas, precios ni datos de clientes.
            </p>
            <textarea
              rows={2}
              placeholder="Contanos qué pasó (opcional). Ej.: no responde, se corta al pasar precios…"
              value={supportNote}
              maxLength={1000}
              onChange={(e) => setSupportNote(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", marginBottom: 8 }}
            />
            <button className="secondary" disabled={supportBusy} onClick={() => void handleSendToSupport()}>
              {supportBusy ? "Enviando…" : "Enviar a soporte"}
            </button>
            {supportMessage && <p className="message" style={{ marginTop: 10 }}>{supportMessage}</p>}
          </div>
          )}
        </div>
      )}
    </>
  );
}
