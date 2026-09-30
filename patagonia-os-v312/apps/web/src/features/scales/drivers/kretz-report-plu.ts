import {
  autoDetectScale,
  checkScaleCompatibility,
  deleteScalePlu,
  describeResponseCode,
  readScalePlu,
  sendScalePing,
  syncOneProductToScale
} from "../../inventory/scale-serial";
import type { ScaleDriver, ScaleIdentifyResult, ScaleWriteResult } from "../types";

/**
 * Driver del Scale Manager para la familia Kretz Report NX/LT (PLU por
 * cable). NO reimplementa el protocolo: la trama STX/EOT, el checksum, el
 * modelo de 20 campos y todos los workarounds documentados (5005 "próximo
 * mayor", el flag de posición decimal, etc.) siguen viviendo, tal cual, en
 * `features/inventory/scale-serial.ts` (ya probado contra hardware real) --
 * este archivo solo expone esas funciones bajo la interfaz `ScaleDriver`.
 *
 * LIMITACIÓN CONOCIDA de esta envoltura (a propósito, para no tocar código
 * delicado todavía): `scale-serial.ts` maneja su propio puerto cacheado a
 * nivel de módulo (`pickPort()`/`cachedPort`, alimentado por
 * `navigator.serial.getPorts()`), no el `port` que el Manager le pasa a
 * cada método de este driver. Con una sola balanza Report conectada por PC
 * esto funciona igual que hoy -- pero todavía no permite que el Manager
 * dirija a una balanza Report específica cuando hay más de una. Corregir
 * esto es best hecho en la etapa de centralización (detección/reconexión),
 * no acá: requiere que `scale-serial.ts` acepte el puerto como parámetro en
 * vez de manejarlo internamente, que sí toca su plumbing de conexión (no
 * su protocolo) -- se avisa antes de tocarlo, como se pidió.
 */

function writeResultFrom(responseCode: string | null, rawResponseHex: string): ScaleWriteResult {
  if (responseCode === "01") {
    return { verified: "unconfirmed", raw: rawResponseHex, message: "La balanza confirmó haber recibido el dato (sin relectura de verificación en este paso)." };
  }
  return { verified: "failed", raw: rawResponseHex, message: `La balanza respondió código "${responseCode ?? "sin respuesta"}" (${describeResponseCode(responseCode)}).` };
}

/** Precio tal como lo manda `syncOneProductToScale` (entero, sin decimales
 * -- ver `fixedDigits` y el flag de posición decimal en scale-serial.ts).
 * No se reimplementa el formato de campo (ancho fijo, relleno de ceros):
 * alcanza con buscar los dígitos del precio como subcadena en el texto
 * ASCII que ya devuelve `readScalePlu` -- si el campo de precio se grabó
 * bien, esos dígitos van a estar ahí sí o sí, sea cual sea el ancho o el
 * relleno con el que la balanza los guardó. */
function priceDigitsAppear(rawDataAscii: string, priceRetail: number): boolean {
  const digits = String(Math.max(0, Math.round(priceRetail)));
  return rawDataAscii.includes(digits);
}

export const kretzReportPluDriver: ScaleDriver = {
  id: "kretz-report-plu",
  brand: "Kretz",
  models: ["Report NX", "Report LT"],
  status: "certified",
  capabilities: ["ping", "readPlu", "writePlu", "bulkSync"],

  async identify(_port, onProgress): Promise<ScaleIdentifyResult> {
    const result = await autoDetectScale((text) => onProgress?.(text));
    if (!result.found || !result.settings) {
      return { matched: false, debug: `Probé ${result.attempts} combinaciones, ninguna respondió.` };
    }
    return {
      matched: true,
      displayName: "Kretz Report (PLU por cable)",
      settings: { ...result.settings },
      debug: result.rawResponseHex
    };
  },

  async ping() {
    const result = await sendScalePing();
    return { ok: result.ok, raw: result.rawResponseHex, message: describeResponseCode(result.responseCode) };
  },

  async readPlu(_port, _settings, code) {
    const result = await readScalePlu(code);
    return { found: result.responseCode === "01", raw: result.rawResponseHex, message: result.rawDataAscii };
  },

  /**
   * `settings.verifyWrite` (default: true) controla si se relee el PLU
   * después de escribirlo para confirmar que el precio quedó bien grabado
   * -- lo decide quien orquesta la sincronización (ver features/scales/
   * sync.ts), no este driver; podría desactivarse por velocidad si algún
   * día hiciera falta, pero por ahora nunca se hace para precios sin que
   * el que llama lo pida explícitamente. */
  async writePlu(_port, settings, product) {
    const result = await syncOneProductToScale(product);
    const base = writeResultFrom(result.responseCode, result.rawResponseHex);
    if (base.verified !== "unconfirmed" || settings.verifyWrite === false) return base;

    try {
      const readBack = await readScalePlu(product.code);
      if (readBack.responseCode === "01" && priceDigitsAppear(readBack.rawDataAscii, product.priceRetail)) {
        return { verified: "confirmed", raw: base.raw, message: "Se relayó el PLU y el precio coincide con lo que se mandó." };
      }
      return { verified: "unconfirmed", raw: base.raw, message: "La balanza aceptó el envío, pero al releerlo no se pudo confirmar que el precio haya quedado bien grabado." };
    } catch {
      return base; // la relectura falló -- no degradar el resultado de la escritura en sí
    }
  },

  async deletePlu(_port, _settings, code) {
    const result = await deleteScalePlu(code);
    return writeResultFrom(result.responseCode, result.rawResponseHex);
  },

  async runCertificationTest() {
    const result = await checkScaleCompatibility();
    return {
      passed: result.compatible,
      message: result.message,
      debug: [
        `ping=${result.pingOk}`,
        result.writeResponseCode ? `write=${result.writeResponseCode}` : "",
        result.readResponseCode ? `read=${result.readResponseCode}` : "",
        `fieldsMatch=${result.fieldsMatch}`
      ].filter(Boolean).join(" ")
    };
  }
};
