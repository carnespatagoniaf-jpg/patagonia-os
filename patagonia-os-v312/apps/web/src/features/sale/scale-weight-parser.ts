// Lectura del mensaje de peso que transmite la balanza Kretz Aura Eco por RS-232
// (manual AURA ECO Rev.01, sección 16.4). Puro y sin dependencias: se prueba solo.
//
// Formatos del manual (CR = ASCII 13, el primer "2" es el inicio de transmisión):
//   Solo peso:               2 , XX.XXX , CR
//   Peso-precio-importe:     2 , XX.XXX , CR , XXXX.XX , CR , XXXXX.XX , CR
// El manual no aclara si las comas y el "2" inicial son caracteres reales o parte
// del dibujo, así que el lector es tolerante: separa por CR, limpia comas y
// espacios, y toma el peso con el patrón fijo "hasta 2 enteros + punto + 3
// decimales" anclado al final del campo (así un "2" pegado adelante no se lee
// como parte del peso: "201.250" -> 1,250 kg).

export interface ScaleFrame {
  weightKg: number;
  /** Precio por kg y importe, solo en los modos "peso-precio-importe". */
  price?: number;
  amount?: number;
}

const MAX_WEIGHT_KG = 99.999;

export function bytesToText(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
}

/** Texto legible de lo recibido, para mostrarlo en la prueba de conexión. */
export function describeRawFrame(text: string): string {
  return Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    if (code === 13) return "⏎";
    if (code === 10) return "↵";
    if (code < 32) return `<${code}>`;
    return ch;
  }).join("");
}

function cleanField(field: string): string {
  return field.replace(/[\u0000-\u001f]/g, "").replace(/^[,\s]+|[,\s]+$/g, "");
}

function parseNumberField(field: string): number | undefined {
  const cleaned = cleanField(field).split(",").pop() ?? "";
  if (!/^\d+\.\d+$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/** Devuelve el primer mensaje completo que encuentre, o null si no hay un peso válido. */
export function parseScaleFrame(text: string): ScaleFrame | null {
  const fields = text.split(/[\r\n]+/);
  // Hace falta que el primer campo haya terminado (que llegue su CR); si el
  // texto termina sin CR, el mensaje puede estar cortado a la mitad.
  if (fields.length < 2) return null;

  const weightField = cleanField(fields[0]).split(",").pop() ?? "";
  const match = weightField.match(/(\d{1,2}\.\d{3})$/);
  if (!match) return null;

  const weightKg = Number(match[1]);
  if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > MAX_WEIGHT_KG) return null;

  const price = fields.length > 3 ? parseNumberField(fields[1]) : undefined;
  const amount = fields.length > 3 ? parseNumberField(fields[2]) : undefined;
  return price !== undefined && amount !== undefined ? { weightKg, price, amount } : { weightKg };
}
