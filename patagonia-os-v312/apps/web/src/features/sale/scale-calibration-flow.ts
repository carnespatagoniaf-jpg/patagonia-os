import { detectScaleConfigFromSamples, type CalibrationSample, type ScaleConfig, type ScalePayloadType } from "./scale-barcode";

/**
 * Pasos de la calibración de etiquetas (engranaje de Mostrador → "Etiquetas de la balanza"). Con una sola etiqueta casi
 * siempre hay dos formatos posibles (C6): en vez de elegir uno a ciegas, se pide el N.º de producto que dice la
 * etiqueta y, si hace falta, una segunda etiqueta (mejor de más de 10 kg). Nunca se guarda con dudas. Puro.
 */

export type CalibrationStep =
  | { kind: "save"; config: ScaleConfig }
  | { kind: "ask"; ask: "plu" | "label"; message: string }
  | { kind: "ambiguous"; message: string }
  | { kind: "none" };

export function calibrationStep(samples: CalibrationSample[], payloadType: ScalePayloadType = "weight"): CalibrationStep {
  const r = detectScaleConfigFromSamples(samples, payloadType);
  if (r.kind === "ok") return { kind: "save", config: r.config };
  if (r.kind === "none") return { kind: "none" };
  if (r.askPlu && samples[0].plu === undefined) {
    const plus = [...new Set(r.options.map((o) => o.readings[0].plu))];
    return { kind: "ask", ask: "plu", message: `Esa etiqueta se puede leer como el producto ${plus.join(" o el ")}. ¿Qué número de producto es? (el número con el que está cargado en la balanza)` };
  }
  if (samples.length < 2) {
    return { kind: "ask", ask: "label", message: "Todavía hay dos formatos posibles. Escaneá la etiqueta de OTRO producto y escribí su peso (mejor uno de más de 10 kg, o un peso que no termine en 0)." };
  }
  return { kind: "ambiguous", message: "No se guardó nada: con estas etiquetas todavía hay dos formatos posibles y no queremos adivinar. Probá con un producto de más de 10 kg, o escribinos y lo configuramos nosotros." };
}
