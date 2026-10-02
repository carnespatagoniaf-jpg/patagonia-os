import { buildKretzFrame, parseKretzResponse, toHex, toPrintable, type KretzResponse } from "./kretz-frame";
import { collect, type KretzResponder } from "./discovery";
import { claimPort, closeQuietly, errorClassification, freshPortFor, newSession, openForSession, releasePort, type OpenAttempt } from "./port-session";

/**
 * Diagnóstico del MODELO DE DATOS de la Kretz Aura. Es SOLO DE LECTURA e
 * independiente de la carga de productos.
 *
 * Objetivo: saber si el registro de PLU de la Aura tiene los campos "Código
 * del PLU" y "Tipo de PLU", y en qué posición, para decidir si 2005 puede
 * escribirlos.
 *
 * Protocolo:
 * - DOCUMENTADO para la Report Nx ("Multiprotocolo Report Nx", Kretz R30 jun-2023):
 *   - §4.82, 5002 "Lectura del largo de campo". Respuesta = entidad (2) + campo (2) + cantidad de caracteres (3).
 *   - §4.81, 5001: entidad (2) + registros (6).
 *   - §4.22: 1500.
 *   - §4.91: 5026.
 * - El PEDIDO de 5002 no figura explícito en el documento. Lo REAL (Report LT
 *   de Carnes Patagonia, sept. 2026) es: datos = "05" + número de campo (01..22),
 *   respuesta 01 con "05NN" + ancho, y ancho "000" en los campos deshabilitados.
 *   Ese modelo dio los 22 anchos que usa scale-serial.ts (135 caracteres).
 * - NO documentado para la Aura. Lo REAL en la Aura:
 *   - 5002 con datos "05" (incompleto) → grupo "00", código "02", igual que 0002, que la Aura no tiene.
 *   - 1500 → la misma estructura que la Report Nx.
 *
 * SEGURIDAD (decisión del dueño, 2026-10-03): solo se mandan comandos que esta
 * Aura YA recibió antes sin ningún efecto, según las tramas registradas en
 * scale_support_reports (cliente "Pollo y mar", 2026-10-01/02):
 *   0001 (26 veces, contesta 01), 1500 (9 veces, datos técnicos),
 *   5005 (132 veces, lectura de PLU; los productos quedaron idénticos).
 * Ninguno modifica, borra, reinicia ni configura (Nx §2.2: 0001 test, 15xx
 * lectura de configuración, 50xx lectura de datos).
 * DESHABILITADOS porque la Aura nunca los recibió con estos datos y no hay
 * documento de la Aura que los cubra: 5001 "05", 5026 y 5002 "05NN".
 * (5002 solo se le mandó con "05" y contestó "comando inexistente"; con otros
 * datos no se puede garantizar el comportamiento.) Para habilitarlos hace
 * falta cambiar UNVERIFIED_ENABLED en el código: no hay ningún botón ni
 * opción en tiempo de ejecución que lo haga.
 * Siempre excluidos: 5008 (exige borrar con 3008), 0000-1499 (configuración),
 * 2xxx (escritura), 3xxx/4xxx (borrado).
 */

export const MODEL_PROBE_VERSION = "2026-10-03b";

/** Comandos ya recibidos por esta Aura sin efecto (ver arriba). */
export const VERIFIED_COMMANDS: Record<string, string> = {
  "0001": "test de conexión",
  "1500": "datos técnicos (modelo y firmware)",
  "5005": "lectura de un producto (el siguiente mayor al número pedido)"
};

/** Lecturas documentadas solo para la Report Nx; nunca enviadas a esta Aura. DESHABILITADAS. */
export const UNVERIFIED_COMMANDS: Record<string, string> = {
  "5001": "cantidad de registros de la entidad PLU",
  "5002": "largo de cada campo del PLU (modelo de datos)",
  "5026": "moneda y decimales"
};

export const UNVERIFIED_ENABLED = false;

export const PROBE_COMMANDS: Record<string, string> = { ...VERIFIED_COMMANDS, ...UNVERIFIED_COMMANDS };

export function assertProbeCommand(command: string, data: string): void {
  const verified = command in VERIFIED_COMMANDS && (command === "5005" ? /^\d{6}$/.test(data) : data === "");
  const unverified =
    UNVERIFIED_ENABLED &&
    command in UNVERIFIED_COMMANDS &&
    (command === "5002" ? /^05(0[1-9]|1\d|2[0-4])$/.test(data) : command === "5001" ? data === "05" : data === "");
  if (!verified && !unverified) throw new Error(`Bloqueado: el diagnóstico solo manda lecturas ya comprobadas en esta Aura (${command} ${data} no está permitido).`);
}

export interface ProbeExchange {
  command: string;
  data: string;
  label: string;
  txHex: string;
  rxHex: string;
  rxAscii: string;
  group: string | null;
  code: string | null;
  responseData: string | null;
  checksumOk: boolean | null;
  ms: number;
}

export interface ModelProbeResult {
  version: string;
  startedAt: string;
  finishedAt: string;
  responder: KretzResponder;
  opened: boolean;
  detail: string;
  exchanges: ProbeExchange[];
  openLog: OpenAttempt[];
}

/** Campos del PLU en el orden de la Report Nx/LT (numeración real de 5002 en la Report LT, 22 campos). */
export const NX_PLU_FIELDS = [
  "Número del PLU",
  "Código de departamento",
  "Código de familia",
  "Nombre",
  "Descripción",
  "Código del PLU",
  "Tipo de PLU",
  "Valor fijo (días consumo preferente)",
  "Precio",
  "Precio alternativo",
  "Precio anterior / punto decimal",
  "Impuesto 1",
  "Impuesto 2",
  "Tara preempaque",
  "Tara público",
  "Código de etiqueta",
  "Código de receta",
  "Código nutricional",
  "Fecha envase",
  "Vencimiento",
  "Código de imagen",
  "Campo 22 (sin documentar)"
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(port: SerialPort, responder: KretzResponder, result: ModelProbeResult, command: string, data: string, timeoutMs: number): Promise<ProbeExchange> {
  assertProbeCommand(command, data);
  const frame = buildKretzFrame(responder.deviceType, responder.equipmentId, command, data);
  const writer = port.writable!.getWriter();
  const t0 = Date.now();
  try {
    await writer.write(frame);
  } finally {
    writer.releaseLock();
  }
  const rx = await collect(port, timeoutMs, true);
  const k: KretzResponse | null = parseKretzResponse(rx);
  const ex: ProbeExchange = {
    command,
    data,
    label: PROBE_COMMANDS[command],
    txHex: toHex(frame),
    rxHex: toHex(rx),
    rxAscii: toPrintable(rx),
    group: k?.group ?? null,
    code: k?.code ?? null,
    responseData: k ? k.data : null,
    checksumOk: k ? k.checksumOk : null,
    ms: Date.now() - t0
  };
  result.exchanges.push(ex);
  return ex;
}

export async function runAuraModelProbe(port: SerialPort, responder: KretzResponder, options: { timeoutMs?: number; onProgress?: (t: string) => void } = {}): Promise<ModelProbeResult> {
  const timeout = options.timeoutMs ?? 1500;
  const progress = options.onProgress ?? (() => {});
  const result: ModelProbeResult = { version: MODEL_PROBE_VERSION, startedAt: new Date().toISOString(), finishedAt: "", responder, opened: false, detail: "", exchanges: [], openLog: [] };
  if (!claimPort(port)) {
    result.detail = "ya hay una prueba en curso con esta balanza en esta pestaña";
    result.finishedAt = new Date().toISOString();
    return result;
  }
  const claimed = port;
  try {
    port = await freshPortFor(port);
    try {
      await openForSession(port, { baudRate: responder.link.baudRate, dataBits: 8, stopBits: responder.link.stopBits, parity: "none" }, newSession(4, result.openLog));
      result.opened = true;
    } catch (err) {
      const c = errorClassification(err);
      result.detail = `no se pudo abrir el puerto: ${c ? c.explanation : String(err)}`;
      return result;
    }
    progress("Probando la conexión…");
    let hello = await probe(port, responder, result, "0001", "", timeout);
    if (!hello.code) hello = await probe(port, responder, result, "0001", "", timeout);
    if (!hello.code) {
      result.detail = "la balanza no contestó el test de conexión";
      return result;
    }
    progress("Leyendo los datos técnicos…");
    await probe(port, responder, result, "1500", "", timeout);

    // Todos los productos, uno por uno (5005 devuelve el siguiente mayor). Corta al final de la lista,
    // si la balanza no contesta, o si el número no avanza (para no quedar dando vueltas).
    let after = 0;
    for (let i = 0; i < 10000; i++) {
      const arg = String(after).padStart(6, "0");
      let ex = await probe(port, responder, result, "5005", arg, timeout);
      if (!ex.code) ex = await probe(port, responder, result, "5005", arg, timeout);
      if (ex.code !== "01" || !ex.responseData) break;
      const plu = Number(ex.responseData.slice(0, 6));
      if (!Number.isFinite(plu) || plu <= after) break;
      after = plu;
      progress(`Leyendo los productos de la balanza… va por el ${plu}`);
    }

    if (UNVERIFIED_ENABLED) {
      for (const [command, data] of [["5001", "05"], ["5026", ""]] as const) {
        await probe(port, responder, result, command, data, timeout);
        await sleep(50);
      }
      // 5002 campo por campo. Si el primero contesta "comando inexistente" (02), no se insiste.
      for (let field = 1; field <= 24; field++) {
        const ex = await probe(port, responder, result, "5002", `05${String(field).padStart(2, "0")}`, timeout);
        if (field === 1 && (ex.code === "02" || !ex.code)) break;
        await sleep(30);
      }
    }
    result.detail = "lectura terminada";
    return result;
  } catch (err) {
    result.detail = `error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
    return result;
  } finally {
    await closeQuietly(port);
    releasePort(claimed);
    result.finishedAt = new Date().toISOString();
  }
}

const KEY = "patagonia-scale-aura-model-probe";

export function saveModelProbe(r: ModelProbeResult): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // sin localStorage
  }
}

export function getLastModelProbe(): ModelProbeResult | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ModelProbeResult) : null;
  } catch {
    return null;
  }
}

/* ------------------------------ análisis (puro) ------------------------------ */

/** Posiciones REALES de la Aura (comprobadas en 6 registros reales y 5 escrituras). */
export const AURA_OBSERVED = {
  recordLength: 42,
  letterAt: 22,
  sixDigitsAt: [23, 29] as const,
  priceAt: [29, 35] as const,
  tareAt: [35, 39] as const,
  validityAt: [39, 42] as const
};

export type ModelVerdict =
  | "sin_conexion"
  | "modelo_no_consultado" // 5002 deshabilitado: no se preguntó
  | "modelo_no_disponible" // la Aura no informa el modelo (5002 inexistente o sin respuesta)
  | "modelo_incompleto"
  | "modelo_no_coincide" // la suma de anchos no da 42 o las posiciones no encajan con lo leído
  | "codigo_no_existe" // el registro no tiene el campo Código: 2005 no puede escribirlo
  | "codigo_y_tipo_existen"; // los dos campos están en el registro: la pérdida se debe a validación o a valores no aceptados

export interface FieldLayout {
  field: number;
  name: string;
  width: number;
  start: number;
}

export interface ModelAnalysis {
  verdict: ModelVerdict;
  /** Explicación para el informe, en castellano. */
  lines: string[];
  layout: FieldLayout[];
  total: number | null;
  technical: { model: string | null; firmware: string | null; currency: string | null; pluRecords: string | null };
  /** Productos leídos con 5005 en este diagnóstico (registro de 42 tal cual). */
  products: string[];
}

export function analyzeModelProbe(r: ModelProbeResult): ModelAnalysis {
  const find = (c: string) => r.exchanges.find((e) => e.command === c && e.code === "01");
  const t1500 = find("1500")?.responseData ?? null;
  const technical = {
    model: t1500 ? t1500.slice(0, 20).trim() : null,
    firmware: t1500 ? t1500.slice(20, 25).trim() : null,
    currency: find("5026")?.responseData ?? null,
    pluRecords: find("5001")?.responseData ?? null
  };
  const lines: string[] = [];
  const products = r.exchanges.filter((e) => e.command === "5005" && e.code === "01" && e.responseData).map((e) => e.responseData!);
  if (!r.exchanges.some((e) => e.command === "0001" && e.code)) {
    return { verdict: "sin_conexion", lines: [`No hubo comunicación: ${r.detail}.`], layout: [], total: null, technical, products };
  }
  const fieldEx = r.exchanges.filter((e) => e.command === "5002");
  if (fieldEx.length === 0) {
    lines.push(`Conexión correcta. Equipo ${technical.model ?? "?"}, firmware ${technical.firmware ?? "?"}. Productos leídos: ${products.length}.`);
    lines.push(
      'El modelo de datos (5002) NO se consultó: está deshabilitado porque nunca se comprobó en esta Aura con el pedido completo. Registro previo: 5002 con "05" contestó "comando inexistente" (grupo 00, código 02), igual que 0002.'
    );
    lines.push("Con lecturas ya comprobadas no se puede saber si el registro admite tipo y código. Lo que falta: la captura de lo que manda iTegra.");
    return { verdict: "modelo_no_consultado", lines, layout: [], total: null, technical, products };
  }
  const ok = fieldEx.filter((e) => e.code === "01" && /^05\d{2}\d{3}$/.test(e.responseData ?? ""));
  if (ok.length === 0) {
    const first = fieldEx[0];
    lines.push(
      first
        ? `La Aura no informa su modelo de datos: 5002 contestó grupo ${first.group ?? "-"}, código ${first.code ?? "sin respuesta"} (${first.rxHex || "nada"}).`
        : "No se llegó a preguntar el modelo de datos."
    );
    lines.push("Por lectura no se puede saber si el registro tiene código y tipo. Lo que falta: la captura de lo que manda iTegra.");
    return { verdict: "modelo_no_disponible", lines, layout: [], total: null, technical, products };
  }
  const widths = new Map(ok.map((e) => [Number(e.responseData!.slice(2, 4)), Number(e.responseData!.slice(4, 7))]));
  const layout: FieldLayout[] = [];
  let pos = 0;
  for (let f = 1; f <= 24; f++) {
    if (!widths.has(f)) continue;
    const w = widths.get(f)!;
    layout.push({ field: f, name: NX_PLU_FIELDS[f - 1] ?? `Campo ${f}`, width: w, start: pos });
    pos += w;
  }
  const total = pos;
  if (!widths.has(6) || !widths.has(7) || !widths.has(9)) {
    lines.push(`El modelo vino incompleto (campos con respuesta: ${[...widths.keys()].join(", ")}).`);
    return { verdict: "modelo_incompleto", lines, layout, total, technical, products };
  }
  const at = (f: number) => layout.find((l) => l.field === f)!;
  const code = at(6);
  const type = at(7);
  const price = at(9);
  lines.push(`Largo total del modelo: ${total} caracteres (lo que la Aura devuelve con 5005: ${AURA_OBSERVED.recordLength}).`);
  lines.push(`Código del PLU: ancho ${code.width}${code.width ? `, posición ${code.start}` : ""}. Tipo: ancho ${type.width}${type.width ? `, posición ${type.start}` : ""}. Precio: posición ${price.start}.`);
  const fits = total === AURA_OBSERVED.recordLength && price.start === AURA_OBSERVED.priceAt[0];
  if (!fits) {
    lines.push("El modelo que informa la balanza no encaja con el registro que devuelve (largo o posición del precio distintos). Hay que revisar la numeración de campos antes de sacar conclusiones.");
    return { verdict: "modelo_no_coincide", lines, layout, total, technical, products };
  }
  if (code.width === 0) {
    const six = layout.find((l) => l.start === AURA_OBSERVED.sixDigitsAt[0] && l.width > 0);
    lines.push(
      `El registro de PLU de esta Aura NO tiene el campo "Código del PLU" (ancho 0). Por eso 2005 no puede escribirlo.${six ? ` Los 6 dígitos que siguen a la letra son el campo ${six.field} (${six.name}).` : ""}`
    );
    lines.push(
      type.width === 1 && type.start === AURA_OBSERVED.letterAt
        ? 'El tipo SÍ está en el registro, en la posición 22. Si mandamos P o N y queda "D", la Aura valida o recalcula ese valor. Lo que falta es saber qué valor acepta (captura de iTegra).'
        : "El tipo no está donde lo leemos: revisar el informe."
    );
    return { verdict: "codigo_no_existe", lines, layout, total, technical, products };
  }
  lines.push(
    code.start < type.start
      ? `El código va ANTES que el tipo (posiciones ${code.start} y ${type.start}). Si eso es así también al escribir, explica la pérdida (hipótesis H2): habría que mandar código y tipo en ese orden.`
      : `El código (posición ${code.start}) y el tipo (posición ${type.start}) existen en el orden en que los leemos. Que la Aura los ponga en "D" y 0 indica que valida esos valores: falta saber qué acepta (captura de iTegra).`
  );
  return { verdict: "codigo_y_tipo_existen", lines, layout, total, technical, products };
}
