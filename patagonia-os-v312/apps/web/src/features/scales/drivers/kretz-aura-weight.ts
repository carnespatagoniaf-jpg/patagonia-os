import { describeRawFrame } from "../../sale/scale-weight-parser";
import { WEIGHT_PORT_OPTIONS, exchangeWeightFrame, weightReadError } from "../../sale/scale-weight-protocol";
import type { ScaleDriver, ScaleIdentifyResult, ScaleWeightReading } from "../types";

/**
 * Driver del Scale Manager para la Kretz Aura Eco (peso en vivo por cable).
 * NO reimplementa el protocolo: cómo se le pide el peso vive en
 * `features/sale/scale-weight-protocol.ts`, la misma copia que usa
 * Mostrador (`scale-weight.ts`), así las dos nunca leen distinto. Este
 * archivo solo abre el puerto que le pasa el Manager y expone eso bajo la
 * interfaz `ScaleDriver`. La pantalla "Balanzas" usa este driver para
 * detectar y probar, y al guardar le pasa el puerto a `scale-weight.ts`
 * (`setWeightScalePort`), que es quien lee el peso al vender.
 */

async function requestWeight(port: SerialPort) {
  if (!(port.readable && port.writable)) {
    if (port.readable || port.writable) await port.close();
    await port.open(WEIGHT_PORT_OPTIONS);
  }
  return exchangeWeightFrame(port);
}

export const kretzAuraWeightDriver: ScaleDriver = {
  id: "kretz-aura-weight",
  brand: "Kretz",
  models: ["Aura Eco", "Aura"],
  status: "certified",
  capabilities: ["readWeight"],

  async identify(port, onProgress): Promise<ScaleIdentifyResult> {
    onProgress?.("Probando Kretz Aura Eco (9600 baudios, pedido de peso)…");
    try {
      const { raw, frame } = await requestWeight(port);
      if (frame) {
        return { matched: true, displayName: "Kretz Aura Eco", settings: {}, debug: describeRawFrame(raw) };
      }
      return { matched: false, debug: raw ? describeRawFrame(raw) : "sin respuesta" };
    } catch (err) {
      return { matched: false, debug: err instanceof Error ? err.message : String(err) };
    }
  },

  async readWeight(port): Promise<ScaleWeightReading> {
    const { raw, frame } = await requestWeight(port);
    if (frame) return { weightKg: frame.weightKg, price: frame.price, amount: frame.amount, raw };
    throw weightReadError(raw);
  }
};
