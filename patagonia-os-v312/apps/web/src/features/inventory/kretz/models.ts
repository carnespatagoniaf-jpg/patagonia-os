/**
 * Modelos de balanza Kretz que maneja "Balanza por cable", cada uno con lo
 * que se sabe de él y CON QUÉ se sabe. Agregar un modelo = una entrada más acá.
 *
 * Regla: el envío de productos (escribir en la balanza) solo se habilita para
 * un modelo cuyo protocolo de PLU esté COMPROBADO CON UNA BALANZA REAL
 * (`plu.evidence === "real"`). Ni la documentación sola ni una hipótesis
 * alcanzan. Detalle y fuentes: docs/BALANZAS_KRETZ.md.
 */

export type Evidence = "real" | "documentado" | "terceros" | "hipotesis" | "desconocido";

export const EVIDENCE_LABELS: Record<Evidence, string> = {
  real: "Comprobado con una balanza real",
  documentado: "Documentado por Kretz",
  terceros: "Lo dice otra empresa (no Kretz)",
  hipotesis: "Hipótesis (falta probar)",
  desconocido: "Desconocido"
};

export interface SerialLink {
  baudRate: number;
  stopBits: 1 | 2;
}

export interface ModelFact {
  text: string;
  evidence: Evidence;
  source: string;
}

export type KretzModelId = "report-lt" | "aura" | "otra-kretz";

export interface KretzModel {
  id: KretzModelId;
  label: string;
  /** Velocidades a probar, la más probable primero. */
  links: SerialLink[];
  /** Letras de tipo de equipo a probar, la más probable primero. */
  deviceTypes: string[];
  /** Si el modelo puede mandar el peso por cable (modo "A pedido de peso"). */
  weight: Evidence;
  plu: {
    evidence: Evidence;
    /** Rango de números de PLU que acepta la balanza. */
    range: [number, number] | null;
  };
  facts: ModelFact[];
}

const ALL_LINKS: SerialLink[] = [
  { baudRate: 9600, stopBits: 2 },
  { baudRate: 9600, stopBits: 1 },
  { baudRate: 115200, stopBits: 1 },
  { baudRate: 19200, stopBits: 1 },
  { baudRate: 38400, stopBits: 1 },
  { baudRate: 57600, stopBits: 1 },
  { baudRate: 4800, stopBits: 1 }
];

const ALL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function order<T>(first: T[], all: T[], same: (a: T, b: T) => boolean = (a, b) => a === b): T[] {
  return [...first, ...all.filter((x) => !first.some((f) => same(f, x)))];
}

const sameLink = (a: SerialLink, b: SerialLink) => a.baudRate === b.baudRate && a.stopBits === b.stopBits;

const MANUAL_AURA = "Manual de usuario Aura Eco, Kretz, Rev.01 04/03/2015";
const GUIA_BT = "Guía rápida uso Bluetooth, Help Desk Kretz";
const DOC_NX = "Multiprotocolo para la comunicación con balanzas Report Nx, Kretz";

export const KRETZ_MODELS: KretzModel[] = [
  {
    id: "report-lt",
    label: "Kretz Report LT / NX",
    links: order([{ baudRate: 115200, stopBits: 1 }], ALL_LINKS, sameLink),
    deviceTypes: order(["C"], ALL_LETTERS),
    weight: "desconocido",
    plu: { evidence: "real", range: [1, 99999] },
    facts: [
      { text: "Trama Kretz: STX + tipo + ID + comando + datos + checksum + EOT; respuesta 0x07 … EOT.", evidence: "real", source: `${DOC_NX} + Report LT real (Carnes Patagonia, sept. 2026)` },
      { text: "115200 baudios, 1 bit de stop, tipo de equipo \"C\", ID \"01\".", evidence: "real", source: "Report LT real" },
      { text: "Alta/modificación de PLU 2005, borrar 3005, leer 5005 (devuelve el siguiente mayor), modelo de datos 5002.", evidence: "real", source: "Report LT real" },
      { text: "El modelo de campos del PLU difiere del documento público (precio de 6 dígitos, 20 campos, 135 caracteres).", evidence: "real", source: "Report LT real, comando 5002" }
    ]
  },
  {
    id: "aura",
    label: "Kretz Aura / Aura Eco",
    links: order([{ baudRate: 9600, stopBits: 2 }, { baudRate: 9600, stopBits: 1 }], ALL_LINKS, sameLink),
    // "H" comprobado con la primera Aura real (2026-10-01); el resto queda por si otra variante usa otra letra.
    deviceTypes: order(["H", "C", "A", "P", "K"], ALL_LETTERS),
    weight: "documentado",
    plu: { evidence: "desconocido", range: [1, 9999] },
    facts: [
      { text: "Puerto RS-232 con conector DB-9 hembra en la balanza: pin 2 Tx, pin 3 Rx, pin 5 masa.", evidence: "documentado", source: `${MANUAL_AURA}, §16.1` },
      { text: "Cable DIRECTO: 2 con 2, 3 con 3, 5 con 5 (macho del lado de la balanza, hembra del lado de la PC).", evidence: "documentado", source: `${MANUAL_AURA}, §16.2` },
      { text: "9600 baudios, 8 bits de datos, sin paridad, 2 bits de stop, ASCII.", evidence: "documentado", source: `${MANUAL_AURA}, §16.5` },
      { text: "Modos COMUNI: continua de peso, continua de peso-precio-importe, a pedido de peso, a pedido de peso-precio-importe, y Datos.", evidence: "documentado", source: `${MANUAL_AURA}, §7.3 y §16.3` },
      { text: "A pedido: se manda P, p, W o w y contesta \"2,XX.XXX,CR\" (con precio e importe en el otro modo).", evidence: "documentado", source: `${MANUAL_AURA}, §16.3.3 y §16.4` },
      { text: "Modo Datos: es para el programa iTegra o el driver JDataGate de Kretz. El protocolo NO está publicado.", evidence: "documentado", source: `${MANUAL_AURA}, §16.3.5` },
      { text: "Guarda PLU del 1 al 9999 (unas 800 memorias): nombre de hasta 16 letras, código de 6 dígitos, pesable sí/no, precio de 6 dígitos, tara de 4 dígitos, días de validez 0 a 250.", evidence: "documentado", source: `${MANUAL_AURA}, §8.2` },
      { text: "Número de balanza 1 a 99 (menú DATOS → n_bal).", evidence: "documentado", source: `${MANUAL_AURA}, §7.1.1` },
      { text: "Alta, baja y modificación de PLU, consulta de PLU y totales desde la app iTegra Mobile por Bluetooth (familia \"PPI\": Aura, Novel Eco 2, Delta Eco 2).", evidence: "documentado", source: GUIA_BT },
      { text: "Los drivers de iTegra son compatibles con la Aura Eco para cargar precios desde la PC.", evidence: "terceros", source: "Centro de ayuda de Autogestiones (blog.autogestiones.net)" },
      { text: "En modo Datos usa la misma trama Kretz que la Report (respuesta 0x07 … checksum … EOT, checksum correcto).", evidence: "real", source: "Primera Aura real de un cliente, 2026-10-01: TX 0001 → RX 07 48 30 31 30 30 30 31 37 31 04" },
      { text: "Tipo de equipo \"H\", ID \"01\", 9600 baudios, 2 bits de stop. Contesta el test de conexión 0001 con código \"01\" (OK).", evidence: "real", source: "Primera Aura real de un cliente, 2026-10-01" },
      { text: "Que el número de balanza (n_bal) sea el ID de equipo del protocolo.", evidence: "hipotesis", source: "Contestó con ID 01 (n_bal de fábrica es 1); falta probar con otro n_bal" },
      { text: "Datos técnicos (comando 1500): modelo AUI-030KMFBAPP4KAR, firmware V1.00 del 6 de febrero de 2024.", evidence: "real", source: "Aura del cliente Pollo y mar, 2026-10-01" },
      { text: "Los comandos 0002 (test silencioso) y 5002 (modelo de datos) NO existen en la Aura: contesta código \"02\".", evidence: "real", source: "Aura del cliente Pollo y mar, 2026-10-01" },
      { text: "Leer PLU: comando 5005 con un número de 6 dígitos; devuelve el siguiente PLU guardado (con 000000 devolvió el PLU 1). Respuesta grupo \"05\", código \"01\", registro de 42 caracteres: \"000001FRUTILLA        P0000100010500000005\".", evidence: "real", source: "Aura del cliente Pollo y mar, 2026-10-01" },
      { text: "Reparto del registro: PLU 6 + nombre 16 + tipo 1 + código 6 + precio 6 + tara 4 + validez 3 = 42 (coincide con los límites del manual). Falta confirmar el orden código/precio, los decimales del precio y las letras de tipo.", evidence: "hipotesis", source: "Registro real + manual §8.2; se confirma comparando con la lista que imprime la balanza (LISTAR → PRECI)" },
      { text: "Comandos para grabar y borrar PLU en la Aura.", evidence: "desconocido", source: "Hipótesis a probar: 2005 / 3005 como en la Report, con el mismo registro de 42 caracteres. Solo con un PLU de prueba en un código libre" }
    ]
  },
  {
    id: "otra-kretz",
    label: "Otra balanza Kretz",
    links: ALL_LINKS,
    deviceTypes: order(["C"], ALL_LETTERS),
    weight: "desconocido",
    plu: { evidence: "desconocido", range: null },
    facts: [{ text: "Modelo no probado: \"Probar la conexión\" averigua qué contesta, sin escribir nada.", evidence: "desconocido", source: "—" }]
  }
];

export function getKretzModel(id: string | null | undefined): KretzModel {
  return KRETZ_MODELS.find((m) => m.id === id) ?? KRETZ_MODELS[0];
}

/** Se puede escribir PLU en este modelo (solo si está comprobado con una balanza real). */
export function canWritePlu(model: KretzModel): boolean {
  return model.plu.evidence === "real";
}

const MODEL_KEY = "patagonia-scale-model";

export function getSavedModelId(): KretzModelId {
  try {
    const id = localStorage.getItem(MODEL_KEY);
    if (id && KRETZ_MODELS.some((m) => m.id === id)) return id as KretzModelId;
  } catch {
    // sin localStorage
  }
  return "report-lt";
}

export function saveModelId(id: KretzModelId): void {
  try {
    localStorage.setItem(MODEL_KEY, id);
  } catch {
    // no crítico
  }
}
