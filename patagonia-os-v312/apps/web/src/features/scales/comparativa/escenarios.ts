/* eslint-disable @typescript-eslint/no-explicit-any -- el arnés carga DOS versiones del código (main y la rama nueva) con
   APIs distintas: los módulos se tratan como "any" a propósito y cada escenario elige la llamada según lo que existe. */
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeCuora } from "../../inventory/systel/systel-fake";
import { fakeNetAgent } from "../../inventory/kretz/test-fake-net-agent";
import { mirrorLinks, mirrorProducts, realCatalog, targetProfile } from "../sale/los-gringos-fixture";
import { FakeReport, FakeSerialPort, reportRecord } from "./simuladores";

/**
 * PRUEBA COMPARATIVA: sistema actual (main) contra el nuevo (integracion/balanzas-etapa1).
 *
 * Cada escenario es un caso REAL de un cliente (o derivado directo de un incidente de la auditoría del 26/11) con:
 * cliente, fecha, qué pasó, la entrada y el resultado correcto. `correr` ejecuta el caso con el código de UNA carpeta
 * (el Cargador importa los módulos de producción de esa carpeta) y los simuladores de balanza de abajo, que son los mismos
 * para las dos versiones. Nada de la lógica de producción está copiada acá.
 *
 * Lo corren:
 * - scripts/comparativa-balanzas.mjs (viejo y nuevo, arma la tabla de docs/COMPARATIVA_BALANZAS.md);
 * - comparativa.test.ts (solo el nuevo, en el test normal de la web: exige el resultado correcto).
 *
 * Adaptaciones por versión (documentadas en cada escenario, campo `adaptacion`): cuando una función no existe en main,
 * se llama a la que main usa para lo mismo, en el mismo orden que su pantalla. Si el paso de main vive DENTRO de un
 * componente de React (no se puede ejecutar fuera del navegador), el resultado se marca "parcial" y se cita la línea.
 */

export interface Cargador {
  version: "viejo" | "nuevo";
  /** Importa un módulo de producción de la carpeta bajo prueba. `ruta` es relativa a apps/web/src/features, sin ".ts". */
  importar(ruta: string): Promise<any>;
  /** ¿Existe ese módulo en la carpeta bajo prueba? */
  tiene(ruta: string): boolean;
}

export interface Observado {
  /** true = el sistema hizo lo correcto. */
  correcto: boolean;
  /** Lo que pasó, en palabras simples (sale en la tabla). */
  resultado: string;
  /** "parcial" = una parte del camino de esta versión no se pudo ejecutar fuera de la pantalla (ver `nota`). */
  ejecucion: "completa" | "parcial";
  nota?: string;
}

export interface Escenario {
  id: string;
  titulo: string;
  cliente: string;
  fecha: string;
  quePaso: string;
  /** De dónde sale el caso (commit, auditoría, etiqueta real). */
  fuente: string;
  /** "real" = datos tal cual del cliente; "derivado" = armado a partir del incidente (lo dice `fuente`). */
  evidencia: "real" | "derivado";
  entrada: string;
  esperado: string;
  /** Cómo se llamó al código viejo cuando la API cambió. */
  adaptacion?: string;
  correr(c: Cargador): Promise<Observado>;
}

// ───────────────────────────── ayudas ─────────────────────────────

const noop = () => {};

function withCheck(first12: string): string {
  const d = first12.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

const prod = (code: string, name: string, unit: "kg" | "unit", priceRetail: number, active = true, id = `id-${code}`) =>
  ({ id, code, name, unit, priceRetail, cost: 0, stock: 0, minStock: 0, active }) as any;

const eng = (id: string, code: string, name: string, unit: "kg" | "unit", priceRetail: number) => ({ id, code, name, unit, priceRetail, active: true });

const pesos = (n: number) => `$${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })}`;
const kilos = (n: number) => `${n.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;

/** Una lectura de Mostrador (resolveScan) en palabras. */
function decirLectura(r: any): string {
  switch (r?.type) {
    case "label":
      return `${r.product.name} ${r.product.unit === "kg" ? kilos(r.quantity) : `${r.quantity} u`}${r.amount !== undefined ? ` ${pesos(r.amount)}` : ""}`;
    case "product":
      return `producto ${r.product.name}`;
    case "ticket_total":
      return `TOTAL de ticket ${pesos(r.amount)} (se cobra sin productos)`;
    case "systel_total":
      return `TOTAL Systel ${pesos(r.amount)} (no se carga)`;
    case "ambiguous":
      return `pregunta cuál es (${r.options?.length ?? 0} opciones), no cobra solo`;
    case "error":
      return `no agrega nada: ${String(r.message).slice(0, 90)}`;
    case "ticket_without_amount":
      return "pide cargar el TOTAL a mano";
    case "search":
      return "lo toma como búsqueda";
    default:
      return `otro (${r?.type})`;
  }
}

function instalarNavegador(ports: unknown[] = []) {
  installFakeLocalStorage();
  const serial = Object.assign(new EventTarget(), { getPorts: async () => ports, requestPort: async () => { throw new Error("sin elegir"); } });
  Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });
}

/** Systel real de Los gringos (perfil + vínculos de su catálogo), para los locales que tienen Systel y Kretz. */
function systelLosGringos() {
  const catalog = realCatalog();
  const setup = { profile: targetProfile(), links: mirrorLinks(catalog), readAt: null, repeatWindowMinutes: 10, active: true };
  const products = mirrorProducts(catalog).map((p) => ({ ...p, priceRetail: 5000 }));
  return { setup, products };
}

/**
 * Cómo lee Mostrador una etiqueta en un local con balanza Systel ("artículos + TOTAL") y formato de sucursal.
 * Nuevo: resolveScaleLabel (un solo resolvedor). Viejo: main primero le pregunta a la Systel (useScalePapers.handleScan:
 * decodeAcross + addScannedItem) y solo si no es suya usa resolveScan con el formato de la sucursal (Sale.tsx).
 */
async function leerEnLocalConSystel(c: Cargador, raw: string, products: any[], config: any, setups: any[], soloSystel: boolean) {
  if (c.tiene("sale/scale-label-resolver")) {
    const { resolveScaleLabel } = await c.importar("sale/scale-label-resolver");
    const r = resolveScaleLabel(raw, { products, config, calibrated: true, setups, ...(soloSystel ? { branchFormatCompetes: false } : {}) });
    if (r.type === "scan") return { tipo: r.resolution.type, code: r.resolution.product?.code, qty: r.resolution.quantity, amount: r.resolution.amount, texto: decirLectura(r.resolution) };
    if (r.type === "systel") return { tipo: "systel", code: r.product.code, qty: r.quantity, texto: `Systel: ${r.product.name} ${kilos(r.quantity)}` };
    if (r.type === "ambiguous") return { tipo: "ambiguous", texto: `pregunta cuál es (${r.options.length} opciones)` };
    return { tipo: r.type, texto: `${r.type}: ${String(r.message ?? "").slice(0, 80)}` };
  }
  const { decodeAcross } = await c.importar("scales/sale/multi-decode");
  const { addScannedItem, emptyPaper } = await c.importar("scales/sale/paper");
  const { resolveScan } = await c.importar("sale/scan-resolve");
  const m = decodeAcross(raw, setups, null, undefined, null);
  if (m.kind === "match" && m.decoded.kind !== "not_scale") {
    const d = m.decoded;
    if (d.kind === "error") return { tipo: "error", texto: `Systel: no agrega (${d.reason})` };
    if (d.kind === "total") return { tipo: "total", texto: "Systel: TOTAL" };
    const a = addScannedItem(emptyPaper(), d, m.setup.links, products);
    if (!a.ok) return { tipo: "error", texto: `Systel: no agrega (${a.reason})` };
    const p = products.find((x) => x.id === a.item.productId);
    return { tipo: "systel", code: p?.code, qty: a.item.quantity, texto: `Systel: ${p?.name ?? "venta libre"} ${kilos(a.item.quantity)}` };
  }
  if (m.kind === "ambiguous") return { tipo: "ambiguous", texto: "dos balanzas: no agrega" };
  const r = resolveScan(raw, products, config);
  return { tipo: r.type, code: r.product?.code, qty: r.quantity, amount: r.amount, texto: decirLectura(r) };
}

const LT_PESOS = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" as const };
const M2_237 = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };
const PLU5_PESO = { prefixLength: 2, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" as const };
const FABRICA_155 = { prefixLength: 1, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" as const };

/**
 * Una Report LT que sincroniza en un local con DOS Kretz y la sucursal con otro formato guardado. Devuelve con qué
 * formato quedó leyendo Mostrador. saveItemConfig sin formato = el de la Aura (AURA_ITEM_SCALE_CONFIG), igual que
 * kretzSaveItemConfig en scales/engine/live.ts de las dos versiones.
 */
async function reportEnLocalConDosKretz(c: Cargador, guardado: any, products: any[], records: [number, string, number, "P" | "U"][]) {
  instalarNavegador();
  const scale = new FakeReport();
  for (const [plu, name, price, unit] of records) scale.records.set(plu, reportRecord(plu, name, price, { unit }));
  const { setScaleSerialPort } = await c.importar("inventory/scale-serial");
  const { KretzSession, KRETZ_IO } = await c.importar("scales/engine/adapters/kretz");
  const { AURA_ITEM_SCALE_CONFIG } = await c.importar("inventory/kretz/aura-sync");
  setScaleSerialPort(scale);
  let formato = guardado;
  const io = {
    ...KRETZ_IO,
    saveItemConfig: async (_b: string, cfg?: unknown) => void (formato = cfg ?? AURA_ITEM_SCALE_CONFIG),
    loadBranchConfig: async () => guardado,
    listBranchScales: async () => [{ key: "esta", active: true }, { key: "la-otra", active: true }]
  };
  const s = new KretzSession("kretz-report-lt", { branchId: "suc-1", products, online: true, scaleKey: "esta" }, "datos", io);
  const out = await s.sync(await s.prepare(noop), noop);
  return { formato, out, pisado: JSON.stringify(formato) !== JSON.stringify(guardado) };
}

// ───────────────────────────── escenarios ─────────────────────────────

export const ESCENARIOS: Escenario[] = [
  {
    id: "E01",
    titulo: "Producto 998/999 cobrado como TOTAL sin stock",
    cliente: "Pollo y mar (Aura, formato 2-3-7)",
    fecha: "26/11 (auditoría E2)",
    quePaso: "Con el formato 2-3-7 los códigos 998 y 999 son el 'ticket de suma' de la Aura. Si un producto tiene el número 998, su etiqueta se cobraba como TOTAL: sin producto y sin bajar stock.",
    fuente: "Auditoría 26/11 §7 y §10 E2 (scale-barcode.ts:101); commit e249b26/C2",
    evidencia: "derivado",
    entrada: "Etiqueta 20 998 0210600 (PECHITO DE CERDO 998 activo, 0,211 kg, $2.106) con el formato 2-3-7",
    esperado: "No se cobra sola como TOTAL: pregunta si es el TOTAL o el PECHITO",
    async correr(c) {
      const { resolveScan } = await c.importar("sale/scan-resolve");
      const r = resolveScan(withCheck("209980210600"), [prod("998", "PECHITO DE CERDO", "kg", 10000), prod("21", "COSTELETAS", "kg", 15900)], M2_237);
      return { correcto: r.type !== "ticket_total", resultado: decirLectura(r), ejecucion: "completa" };
    }
  },
  {
    id: "E02",
    titulo: "TOTAL de la Aura cobrado sin bajar stock",
    cliente: "Pollo y mar",
    fecha: "15/10 (decisión revertida el 26/11)",
    quePaso: "Un ticket de varios productos de la Aura trae solo el código del TOTAL. Mostrador lo cobraba como una línea 'Ticket de balanza' sin productos: la plata entraba y el stock no bajaba.",
    fuente: "Etiqueta real 2099806737003 (banco de regresión, contexto pollo-y-mar); commit e249b26 (C7)",
    evidencia: "real",
    entrada: "TOTAL real de Pollo y mar 2099806737003 ($6.737), escaneado solo, con su formato 2-3-7",
    esperado: "No se puede cobrar hasta detallar los productos del ticket (así baja stock)",
    adaptacion: "En main el paso del carrito está dentro de useSaleTicket.ts (componente de React, 'Decisión del dueño (15/10)': agrega la línea 'Ticket de balanza' cobrable). Se ejecuta la lectura real (resolveScan) y se cita esa línea; en el nuevo se ejecuta además scanTotal/pendingTotals.",
    async correr(c) {
      const { resolveScan } = await c.importar("sale/scan-resolve");
      const r = resolveScan("2099806737003", [prod("21", "COSTELETAS", "kg", 15900), prod("1", "milanesas de pollo", "kg", 11600)], M2_237);
      if (r.type !== "ticket_total") return { correcto: true, resultado: decirLectura(r), ejecucion: "completa" };
      if (!c.tiene("sale/scale-total-detail")) {
        return {
          correcto: false,
          resultado: `Lee el TOTAL ${pesos(r.amount)} y lo agrega como "Ticket de balanza" que se cobra sin productos (no baja stock)`,
          ejecucion: "parcial",
          nota: "useSaleTicket.ts de main, rama ticket_total: setCart(... name: 'Ticket de balanza', source: 'scale_total') y 'Detallar productos' es opcional."
        };
      }
      const { scanTotal, pendingTotals } = await c.importar("sale/scale-total-detail");
      const t = scanTotal([], r.key, r.amount);
      const bloquea = t.kind === "detail" && pendingTotals(t.cart).length > 0;
      return { correcto: bloquea, resultado: bloquea ? `TOTAL ${pesos(r.amount)}: pide detallar cada producto; no deja cobrar hasta que la suma dé el TOTAL` : `scanTotal → ${t.kind}`, ejecucion: "completa" };
    }
  },
  {
    id: "E03",
    titulo: "Systel + Kretz en el mismo local: etiqueta de M2",
    cliente: "M2 (etiqueta) en un local con la Systel de Los gringos",
    fecha: "24/10 (etiqueta) · 26/11 (auditoría C3)",
    quePaso: "Mostrador le preguntaba primero a la Systel y se quedaba con cualquier etiqueta '20…', aunque fuera de la Kretz.",
    fuente: "Etiqueta real 2000258567506 escaneada en M2 el 24/10; perfil Systel real de Los gringos (los-gringos-fixture); scale-label-resolver.test.ts",
    evidencia: "derivado",
    entrada: "2000258567506 = Matambre 4,275 kg $58.567,50 (Kretz 2-3-7), en un local que también tiene la Systel",
    esperado: "Matambre 4,275 kg $58.567,50",
    adaptacion: "main no tiene resolveScaleLabel: se llama decodeAcross + addScannedItem (useScalePapers.handleScan, que en main va primero) y, si la Systel no la reconoce, resolveScan.",
    async correr(c) {
      const { setup, products } = systelLosGringos();
      const r = await leerEnLocalConSystel(c, "2000258567506", [...products, prod("2", "Matambre novillo gorina", "kg", 13700)], M2_237, [setup], false);
      return { correcto: r.code === "2" && r.amount === 58567.5, resultado: r.texto, ejecucion: "completa" };
    }
  },
  {
    id: "E04",
    titulo: "Systel + Kretz en el mismo local: etiqueta de Oliem",
    cliente: "Oliem (etiqueta) en un local con la Systel de Los gringos",
    fecha: "18/11 (etiqueta) · 26/11 (auditoría C3)",
    quePaso: "La misma confusión: la Systel leía la etiqueta Kretz como otro producto de cientos de kilos.",
    fuente: "Etiqueta real 2000212051836 (commit #63, banco de regresión); scale-label-resolver.test.ts",
    evidencia: "derivado",
    entrada: "2000212051836 = PROMO PATA $5.183 (1,555 kg) de la Kretz, con la Systel en el local",
    esperado: "PROMO PATA 1,555 kg",
    adaptacion: "Igual que E03.",
    async correr(c) {
      const { setup, products } = systelLosGringos();
      const r = await leerEnLocalConSystel(c, "2000212051836", [...products, prod("212", "PROMO PATA", "kg", 3333)], PLU5_PESO, [setup], false);
      return { correcto: r.code === "212" && r.qty === 1.555, resultado: r.texto, ejecucion: "completa" };
    }
  },
  {
    id: "E05",
    titulo: "Dos Kretz que se pisan el formato (Formita leída como NALGA)",
    cliente: "El Abastero (Report LT + Aura)",
    fecha: "24/11",
    quePaso: "Sincronizar una Kretz le cambiaba a Mostrador el formato de la otra. La etiqueta de la Report 'CAJA FORMITA $42.000' se cobró como NALGA por $27.420 (y la Report se cobró 100 veces menos: $23 por $2.291,63).",
    fuente: "aura-sync.ts (comentario REAL El Abastero 24/11), weight-barcode.ts, auditoría §5 y E1 (kretz.ts:296)",
    evidencia: "derivado",
    entrada: "Local con 2 Kretz y el 1-6-5 en pesos guardado; se toca 'Mandar productos' en una Report LT de una empresa que no está en la lista fija de main; después se escanea la etiqueta real 2000127420000 (CAJA FORMITA $42.000)",
    esperado: "El formato del local no cambia y la etiqueta sigue siendo CAJA FORMITA $42.000",
    adaptacion: "Misma llamada en las dos (KretzSession.sync con la Report simulada). En main El Abastero está en una lista fija por empresa (REPORT_PESOS_BARCODE_COMPANIES) que evita esto SOLO para esa empresa: el escenario usa una empresa sin lista, como la siguiente que tenga dos Kretz.",
    async correr(c) {
      const products = [eng("f", "127", "CAJA FORMITA", "unit", 42000), eng("n", "1", "NALGA XKG", "kg", 18333)];
      const { formato, pisado } = await reportEnLocalConDosKretz(c, LT_PESOS, products, [[127, "CAJA FORMITA", 42000, "U"], [1, "NALGA XKG", 18333, "P"]]);
      const { resolveScan } = await c.importar("sale/scan-resolve");
      const r = resolveScan("2000127420000", [prod("1", "NALGA XKG", "kg", 18333), prod("127", "CAJA FORMITA", "unit", 42000)], formato);
      return { correcto: !pisado && r.type === "label" && r.product.code === "127" && r.amount === 42000, resultado: `${pisado ? "El formato del local cambió" : "El formato del local no cambió"}; la etiqueta se lee: ${decirLectura(r)}`, ejecucion: "completa" };
    }
  },
  {
    id: "E06",
    titulo: "Oliem: cada sincronización pisa el formato de la otra Report",
    cliente: "Oliem (Report por red + Report por USB)",
    fecha: "25/11",
    quePaso: "Con dos Report en el local, sincronizar la de USB dejaba a Mostrador leyendo su formato y las etiquetas de la otra dejaban de leerse bien.",
    fuente: "weight-barcode.ts (REAL Oliem 25/11), auditoría §4 y §5; etiqueta real 2000212051836",
    evidencia: "derivado",
    entrada: "Local con la sucursal leyendo el 2-5-5 de la Report por red; se manda productos a la Report USB (empresa sin lista fija); después se escanea la etiqueta real 2000212051836 (PROMO PATA $5.183)",
    esperado: "El formato no cambia y la etiqueta sigue siendo PROMO PATA 1,555 kg",
    adaptacion: "Igual que E05 (en main Oliem está en REPORT_PLU5_WEIGHT_COMPANIES, una lista fija que lo evita solo para Oliem).",
    async correr(c) {
      const products = [eng("p", "212", "PROMO PATA", "kg", 3333)];
      const { formato, pisado } = await reportEnLocalConDosKretz(c, PLU5_PESO, products, [[212, "PROMO PATA", 3333, "P"]]);
      const { resolveScan } = await c.importar("sale/scan-resolve");
      const r = resolveScan("2000212051836", [prod("0000003", "SALAME CAÑOLI", "kg", 40000), prod("212", "PROMO PATA", "kg", 3333)], formato);
      return { correcto: !pisado && r.type === "label" && r.product.code === "212" && r.quantity === 1.555, resultado: `${pisado ? "El formato del local cambió" : "El formato del local no cambió"}; la etiqueta se lee: ${decirLectura(r)}`, ejecucion: "completa" };
    }
  },
  {
    id: "E07",
    titulo: "Oliem: productos con código 6000+ salteados",
    cliente: "Oliem (Report que imprime 21 + producto de 5)",
    fecha: "25/11",
    quePaso: "El límite de 3 cifras del 2-3-7 salteaba sus 24 productos por kilo con código 6000-6xxx (asado, vacío…): nunca llegaban a la balanza.",
    fuente: "kretz.ts preflight (comentario REAL Oliem 25/11), auditoría §4",
    evidencia: "derivado",
    entrada: "Report con etiqueta '21 + producto de 5' y los productos 6001 ASADO y 6002 VACIO",
    esperado: "Los dos se mandan (no quedan salteados)",
    async correr(c) {
      instalarNavegador();
      const scale = new FakeReport();
      const { setScaleSerialPort } = await c.importar("inventory/scale-serial");
      const { KretzSession, KRETZ_IO } = await c.importar("scales/engine/adapters/kretz");
      setScaleSerialPort(scale);
      const s = new KretzSession("kretz-report-lt", { branchId: null, products: [eng("a", "6001", "ASADO", "kg", 15000), eng("v", "6002", "VACIO", "kg", 16000)], online: false, plu5Barcode: true }, "datos", KRETZ_IO);
      const prep = await s.prepare(noop);
      const salteados = (prep.skipped ?? []).map((x: any) => x.code);
      return { correcto: prep.writes === 2 && salteados.length === 0, resultado: salteados.length ? `Salteados: ${salteados.join(", ")}` : `Se mandan los ${prep.writes}`, ejecucion: "completa" };
    }
  },
  {
    id: "E08",
    titulo: "Local solo con Systel y un formato viejo calibrado",
    cliente: "Carnes premium, El Dorado, Los gringos, mercadito isabel, Pollo Pampa",
    fecha: "27/11 (commit 19e0189)",
    quePaso: "Estos locales tienen solo Systel y un formato de sucursal guardado de antes. Con la regla nueva de 'ante la duda preguntar', muchas etiquetas de la Systel pedían elegir.",
    fuente: "Commit 19e0189 (probado en staging con la Cuora simulada); scale-label-resolver.test.ts",
    evidencia: "derivado",
    entrada: "Etiqueta de la Systel de Los gringos 20 0010 003500 (PECHUGA 3,500 kg), con un formato viejo 2-3-7 calibrado en la sucursal",
    esperado: "Se carga la lectura de la Systel sin preguntar",
    adaptacion: "Igual que E03. En main la Systel siempre gana (no existía la pregunta); el control es que el nuevo no empeore.",
    async correr(c) {
      const { setup, products } = systelLosGringos();
      const r = await leerEnLocalConSystel(c, withCheck("200010003500"), [...products, prod("1", "ASADO", "kg", 10000)], M2_237, [setup], true);
      return { correcto: r.tipo === "systel" && r.qty === 3.5, resultado: r.texto, ejecucion: "completa" };
    }
  },
  {
    id: "E09",
    titulo: "Kretz con un error a mitad de la lectura: pisa productos",
    cliente: "Kretz Report (todas)",
    fecha: "29/10 (auditoría) · 26/11 (E3)",
    quePaso: "Si la balanza contestaba un error al leer un número, se tomaba como 'libre' y el envío escribía encima de lo que había.",
    fuente: "Auditoría §4 (29/10) y §10 E3 (discovery.ts:634); kretz-safety.test.ts (C8)",
    evidencia: "derivado",
    entrada: "Report con 1 VACIO y 3 NALGA; al leer el 3 contesta '60' (error). Patagonia tiene 3 = MATAMBRE",
    esperado: "No se escribe nada y se avisa; la NALGA queda",
    async correr(c) {
      instalarNavegador();
      const scale = new FakeReport();
      scale.records.set(1, reportRecord(1, "VACIO", 15000));
      scale.records.set(3, reportRecord(3, "NALGA", 9000));
      scale.badAfter = 2;
      const { setScaleSerialPort } = await c.importar("inventory/scale-serial");
      const { KretzSession, KRETZ_IO } = await c.importar("scales/engine/adapters/kretz");
      setScaleSerialPort(scale);
      const s = new KretzSession("kretz-report-lt", { branchId: null, products: [eng("a", "1", "VACIO", "kg", 16000), eng("b", "3", "MATAMBRE", "kg", 12000)], online: false }, "datos", KRETZ_IO);
      const prep = await s.prepare(noop);
      let aviso = prep.blocker ?? "";
      try {
        await s.sync(prep, noop);
      } catch (err) {
        aviso ||= err instanceof Error ? err.message : String(err);
      }
      const en3 = scale.nameAt(3);
      return { correcto: en3 === "NALGA" && !scale.writes.includes(3), resultado: en3 === "NALGA" ? `No escribió el 3; aviso: "${aviso.slice(0, 70)}"` : `Escribió encima: el 3 ahora es ${en3}`, ejecucion: "completa" };
    }
  },
  {
    id: "E10",
    titulo: "Systel con un envío frenado: Mostrador sin catálogo",
    cliente: "Los gringos (Cuora Max)",
    fecha: "26/11 (auditoría E4)",
    quePaso: "Si el envío se frenaba a mitad, no se guardaba qué quedó grabado: la balanza imprimía los productos nuevos y Mostrador no los reconocía.",
    fuente: "Auditoría §7 y E4 (systel.ts:452 vs :466); registros reales de Los gringos (respaldo 14/10); systel-safety.test.ts (C12)",
    evidencia: "real",
    entrada: "Cuora Max con 3 productos reales de Los gringos; el envío de 4 productos se frena en el 4",
    esperado: "Mostrador guarda los que sí quedaron (1 y 13) y sus vínculos",
    async correr(c) {
      installFakeLocalStorage();
      const T1 = "\u0001";
      const Z = "0".repeat(56);
      const SP = "0".repeat(44) + "          0 ";
      const f = new FakeCuora("max60", { address: 20, protocol: "0060", typeByteAccepted: "ascii", loteNulOnWrite: true });
      f.plus.set(1, `00010ALPINA CAJON DE   08200007800000001010000U00000000N                              ${Z}${T1}000000000000N`);
      f.plus.set(4, `00040POLLO ENTEROxKG   00520000000000004010000P00000000N                              ${Z}${T1}000000000000N`);
      f.plus.set(13, `00130PECHUGA S/H x1x3  00920000900000013010000P00000000N                              ${SP}${T1}20PPPPCCCCCCN`);
      f.corruptAfterWrite = 4;
      f.corruptOnce = true;
      let catalogo: number[] | null = null;
      const deps = {
        loadSetup: async () => null,
        saveCatalog: async (_b: string, _p: unknown, cat: { code: number }[]) => void (catalogo = cat.map((x) => x.code).sort((a, b) => a - b)),
        setLinks: async () => {},
        setActive: async () => {},
        saveLocalBackup: () => {},
        forceWritable: true
      };
      const { SystelSession } = await c.importar("scales/engine/adapters/systel");
      const products = [eng("p1", "1", "ALPINA CAJON DE 15 KG", "unit", 82000), eng("p4", "4", "POLLO ENTEROxKG", "kg", 5400), eng("p13", "13", "PECHUGA S/H x1x3", "kg", 9200), eng("p78", "78", "ARABES", "unit", 1000)];
      const s = new SystelSession(f, 20, { branchId: "b1", products, online: true }, deps);
      const out = await s.sync(await s.prepare(noop), noop);
      const lista = catalogo as number[] | null;
      const ok = !!lista && lista.includes(1) && lista.includes(13);
      return { correcto: ok, resultado: lista ? `Frenó; Mostrador guardó los productos ${lista.join(", ")}` : `Frenó ("${String(out.message).slice(0, 60)}") y Mostrador no guardó nada de lo grabado`, ejecucion: "completa" };
    }
  },
  {
    id: "E11",
    titulo: "Aura: código de barras (1070) fallido informado como 'Listo'",
    cliente: "Kretz Aura (Pollo y mar, El Abastero)",
    fecha: "26/11 (auditoría E6)",
    quePaso: "Si la Aura rechazaba el formato del código de barras, igual se decía 'Listo': las etiquetas salían sin código.",
    fuente: "Auditoría §9 (matriz, Aura) y E6 (kretz.ts:167, 236-243); kretz-safety.test.ts (C13)",
    evidencia: "derivado",
    entrada: "Aura que graba los productos pero contesta 'rechazada' al 1070",
    esperado: "No dice 'Listo': avisa que el código de barras no quedó",
    async correr(c) {
      installFakeLocalStorage();
      const { KretzSession } = await c.importar("scales/engine/adapters/kretz");
      const io = {
        diagnose: async () => { throw new Error("no se usa"); },
        readAuraList: async () => ({ records: [], complete: true, detail: "", exchanges: [] }),
        runAuraSync: async (plan: { plu: number | null; action: string }[]) => ({ verdict: "ok", detail: "", written: plan.filter((x) => x.action === "crear").map((x) => ({ plu: x.plu, action: x.action })), stoppedAt: null, barcode: "rechazada", before: [], after: [], exchanges: [], openLog: [], startedAt: "", finishedAt: "" }),
        readReport: async () => null,
        sendReport: async () => { throw new Error("no se usa"); }
      };
      const s = new KretzSession("kretz-aura", { branchId: null, products: [eng("a", "2", "MILANESA", "kg", 900)], online: false, scaleKey: "a1" }, "datos", io);
      const out = await s.sync(await s.prepare(noop), noop);
      return { correcto: out.ok === false, resultado: `${out.ok ? "Dice que salió bien" : "Avisa"}: "${String(out.message).slice(0, 80)}"`, ejecucion: "completa" };
    }
  },
  {
    id: "E12",
    titulo: "Envío parcial informado como éxito: Aura 'ya igual' sin código de barras",
    cliente: "Kretz Aura",
    fecha: "26/11 (auditoría E6, 2.ª parte)",
    quePaso: "Una Aura con los productos ya iguales nunca recibía el formato del código de barras y se informaba 'ya está todo listo': quedaba a medias.",
    fuente: "Auditoría E6 ('la Aura ya igual nunca recibe el 1070'); kretz-safety.test.ts (C13)",
    evidencia: "derivado",
    entrada: "Aura que ya tiene FRUTILLA igual que Patagonia y a la que nunca se le mandó el 1070",
    esperado: "No dice 'ya está todo listo' hasta mandar y confirmar el código de barras",
    async correr(c) {
      installFakeLocalStorage();
      const { KretzSession } = await c.importar("scales/engine/adapters/kretz");
      const io = {
        diagnose: async () => { throw new Error("no se usa"); },
        readAuraList: async () => ({ records: [{ plu: 1, data: "000001FRUTILLA        D0000100010500000000" }], complete: true, detail: "", exchanges: [] }),
        runAuraSync: async () => ({ verdict: "ok", detail: "", written: [], stoppedAt: null, barcode: "ok", before: [], after: [], exchanges: [], openLog: [], startedAt: "", finishedAt: "" }),
        readReport: async () => null,
        sendReport: async () => { throw new Error("no se usa"); }
      };
      const s = new KretzSession("kretz-aura", { branchId: null, products: [eng("a", "1", "FRUTILLA", "kg", 1050)], online: false, scaleKey: "a1" }, "datos", io);
      const prep = await s.prepare(noop);
      return { correcto: prep.upToDate === false, resultado: prep.upToDate ? "Dice 'ya está todo listo' sin haber mandado el código de barras" : "Dice que falta el código de barras y lo manda al sincronizar", ejecucion: "completa" };
    }
  },
  {
    id: "E13",
    titulo: "'Enviar todos' del panel de soporte sin relectura",
    cliente: "Kretz Report (iTegra)",
    fecha: "26/11 (C15)",
    quePaso: "La Report contesta '01' a algunos productos sin grabarlos. El panel contaba ese '01' como enviado.",
    fuente: "Commit 7c8e643 (C15); ScaleSyncPanel.tsx",
    evidencia: "derivado",
    entrada: "Report que contesta '01' al 5 NALGA sin grabarlo y graba bien el 6 PECETO; 'Enviar todos'",
    esperado: "Cuenta 1 enviado (el 6) y avisa que el 5 no quedó",
    adaptacion: "El conteo del panel vive en ScaleSyncPanel.tsx (React). main: okCount = responseCodeCounts['01'] (línea 571); nuevo: verifySentReportProducts. Se ejecutan syncProductsToScale y, si existe, verifySentReportProducts.",
    async correr(c) {
      instalarNavegador();
      const scale = new FakeReport();
      scale.records.set(5, reportRecord(5, "NALGA", 9000, { label: "03" }));
      scale.ignore.add(5);
      const serial = await c.importar("inventory/scale-serial");
      serial.setScaleSerialPort(scale);
      const products = [{ id: "a", code: "5", name: "NALGA", unit: "kg", priceRetail: 9500 }, { id: "b", code: "6", name: "PECETO", unit: "kg", priceRetail: 12000 }];
      const r = await serial.syncProductsToScale(products);
      if (!serial.verifySentReportProducts) {
        const ok = r.responseCodeCounts["01"] ?? 0;
        return { correcto: ok === 1, resultado: `"${ok} enviados con éxito" (cuenta el 01 sin releer; el 5 no quedó)`, ejecucion: "parcial", nota: "ScaleSyncPanel.tsx de main, línea 571: okCount = result.responseCodeCounts['01']." };
      }
      const v = await serial.verifySentReportProducts(products);
      return { correcto: v.confirmed.length === 1 && v.confirmed[0].code === "6", resultado: `Relee: ${v.confirmed.length} confirmado (${v.confirmed.map((p: any) => p.code).join(", ")}); no quedó: ${v.notConfirmed.map((x: any) => x.product.code).join(", ")}`, ejecucion: "parcial", nota: "El panel nuevo usa verifySentReportProducts (ScaleSyncPanel.tsx)." };
    }
  },
  {
    id: "E14",
    titulo: "Mostrador arrancando con el formato de fábrica (PC nueva)",
    cliente: "TripleS (etiqueta)",
    fecha: "13/10 (etiqueta) · 26/11 (C5)",
    quePaso: "En una PC nueva (o con el navegador borrado) Mostrador arrancaba con el formato de fábrica hasta que contestaba la base: la primera etiqueta se cobraba con kilos equivocados.",
    fuente: "Foto del ticket de TripleS 13/10 (banco de regresión 'triples-fabrica'); auditoría E17 (Sale.tsx:170); commit 9af96ed",
    evidencia: "real",
    entrada: "Etiqueta real 2001230001759 (MUZARELLA 0,175 kg) escaneada antes de que llegue el formato de la sucursal",
    esperado: "No agrega nada con kilos equivocados ('Cargando la balanza…')",
    adaptacion: "main arranca con useState(DEFAULT_SCALE_CONFIG) en Sale.tsx (línea 177): se ejecuta resolveScan con ese formato. Nuevo: initialScaleConfigState + resolveScaleLabel.",
    async correr(c) {
      installFakeLocalStorage();
      const products = [prod("123", "MUZARELLA PUNTA DA", "kg", 10000)];
      if (!c.tiene("sale/scale-label-resolver")) {
        const { resolveScan } = await c.importar("sale/scan-resolve");
        const { DEFAULT_SCALE_CONFIG } = await c.importar("sale/scale-barcode");
        const r = resolveScan("2001230001759", products, DEFAULT_SCALE_CONFIG);
        return { correcto: !(r.type === "label" && r.quantity !== 0.175), resultado: decirLectura(r), ejecucion: "parcial", nota: "Sale.tsx de main línea 177: useState<ScaleConfig>(DEFAULT_SCALE_CONFIG)." };
      }
      const { initialScaleConfigState } = await c.importar("sale/scale-config-cache");
      const { resolveScaleLabel } = await c.importar("sale/scale-label-resolver");
      const st = initialScaleConfigState("suc-1");
      const r = resolveScaleLabel("2001230001759", { products, config: st.config, calibrated: st.calibrated, setups: [], configStatus: st.status });
      const malo = r.type === "scan" && r.resolution.type === "label" && r.resolution.quantity !== 0.175;
      return { correcto: !malo, resultado: r.type === "not_ready" ? r.message.slice(0, 60) : r.type === "scan" ? decirLectura(r.resolution) : r.type, ejecucion: "completa" };
    }
  },
  {
    id: "E15",
    titulo: "Sucursal sin formato guardado: etiqueta Systel leída con el de fábrica",
    cliente: "TripleS",
    fecha: "13/10",
    quePaso: "Con la sucursal sin configurar, la etiqueta de la Systel (0,175 kg) entraba como 0,017 kg sin ningún aviso.",
    fuente: "Foto del ticket de TripleS 13/10; banco de regresión, marcado SOSPECHOSO ('triples-fabrica')",
    evidencia: "real",
    entrada: "Etiqueta real 2001230001759 (MUZARELLA 0,175 kg) con la base ya cargada y la sucursal SIN formato guardado",
    esperado: "No agrega 0,017 kg sin avisar (pide calibrar o el peso)",
    adaptacion: "main: resolveScan con DEFAULT_SCALE_CONFIG (lo que pone Sale.tsx cuando la base contesta 'sin formato'). Nuevo: scaleConfigLoaded(…, null) + resolveScaleLabel.",
    async correr(c) {
      installFakeLocalStorage();
      const products = [prod("123", "MUZARELLA PUNTA DA", "kg", 10000)];
      if (!c.tiene("sale/scale-label-resolver")) {
        const { resolveScan } = await c.importar("sale/scan-resolve");
        const { DEFAULT_SCALE_CONFIG } = await c.importar("sale/scale-barcode");
        const r = resolveScan("2001230001759", products, DEFAULT_SCALE_CONFIG);
        return { correcto: !(r.type === "label" && r.quantity !== 0.175), resultado: decirLectura(r), ejecucion: "completa" };
      }
      const { scaleConfigLoaded } = await c.importar("sale/scale-config-cache");
      const { resolveScaleLabel } = await c.importar("sale/scale-label-resolver");
      const st = scaleConfigLoaded("suc-1", null);
      const r = resolveScaleLabel("2001230001759", { products, config: st.config, calibrated: st.calibrated, setups: [], configStatus: "ready" });
      const malo = r.type === "scan" && r.resolution.type === "label" && r.resolution.quantity !== 0.175;
      return { correcto: !malo, resultado: r.type === "scan" ? decirLectura(r.resolution) : `${r.type}`, ejecucion: "completa" };
    }
  },
  {
    id: "E16",
    titulo: "Registro duplicado de la misma balanza",
    cliente: "Los gringos (4 ×), Carnes premium (3 ×), El Abastero (2 ×)…",
    fecha: "26/11 (base de producción, auditoría §7)",
    quePaso: "'Agregar balanza' registraba siempre otra, aunque fuera la misma: en producción hay la misma balanza registrada hasta 4 veces.",
    fuente: "Auditoría §7 (scale_profiles de producción); commit 03d90db (C22)",
    evidencia: "real",
    entrada: "Se agrega una Kretz con identidad {letter C, equipment 01} y ya hay una registrada igual (El Abastero)",
    esperado: "Pregunta '¿Es la Balanza Kretz?' antes de registrar otra",
    async correr(c) {
      installFakeLocalStorage();
      const { connectBranchScale } = await c.importar("scales/engine/connect-branch");
      const identity = { letter: "C", equipment: "01" };
      const known = [{ key: "kretz-1", name: "Balanza Kretz", family: "kretz", brand: "kretz", model: null, identity, active: true, lastSeenAt: "2026-11-20T13:00:00Z", sellsWithCodes: false }];
      const port = { getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x6001 }) };
      const adapter = {
        family: "kretz",
        identify: async () => ({ model: "kretz-x", label: "Kretz Report", identity: () => ({ ...identity }), close: async () => {}, prepare: async () => ({}), sync: async () => ({}), supportInfo: () => ({}) })
      };
      const r = await connectBranchScale({ branchId: "b1", products: [], online: false }, noop, { target: null, known, pick: true }, { serial: { getPorts: async () => [port], requestPort: async () => port }, adapters: [adapter] });
      const pregunta = (r.sameAsk?.candidates?.length ?? 0) > 0;
      return { correcto: pregunta && r.matched === null, resultado: pregunta ? `Pregunta si es "${r.sameAsk.candidates[0].name}"` : `La registra como nueva${r.lookalike ? " (solo con un aviso de 'parecida')" : ""}`, ejecucion: "completa" };
    }
  },
  {
    id: "E17",
    titulo: "Dos balanzas por red cortándose entre sí",
    cliente: "Oliem (Report por red) y cualquier local con 2 balanzas por red",
    fecha: "26/11 (auditoría E5)",
    quePaso: "El programa de la PC tenía UNA sola conexión: abrir la segunda balanza cortaba la primera en medio de un envío.",
    fuente: "Auditoría §7 y E5 (patagonia-print-agent.ps1:229); net-two-scales.test.ts (C19)",
    evidencia: "derivado",
    entrada: "Balanza A (192.168.1.50) abierta; se abre la B (192.168.1.51) y se le habla a las dos",
    esperado: "Cada una contesta lo suyo; la A no se corta",
    adaptacion: "Cada sistema con SU programa de la PC: main lleva el .ps1 versión 6 (una conexión), la rama nueva la versión 7. El programa se simula con test-fake-net-agent.ts (misma lógica de conexiones que el .ps1).",
    async correr(c) {
      installFakeLocalStorage();
      const net = await c.importar("inventory/kretz/net-port");
      net.netTiming.retryMs = 1;
      net.netTiming.relocateEveryMs = 60000;
      if ("lockWaitMs" in net.netTiming) net.netTiming.lockWaitMs = 1500;
      net.resetNetAgentForTests?.();
      if (c.tiene("inventory/kretz/scale-lock")) (await c.importar("inventory/kretz/scale-lock")).setScaleLocksForTests?.(undefined);
      const agent = fakeNetAgent({ version: c.version === "nuevo" ? 7 : 6, devices: { "192.168.1.50:1001": (b) => [0xaa, ...b], "192.168.1.51:1001": (b) => [0xbb, ...b] } });
      net.setNetAgentFetchForTests(agent.fetchImpl);
      const conTope = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("no contestó")), ms))]);
      const ask = async (port: any, bytes: number[]) => {
        const w = port.writable.getWriter();
        await w.write(new Uint8Array(bytes));
        w.releaseLock();
        const r = port.readable.getReader();
        try {
          const got = await conTope<ReadableStreamReadResult<Uint8Array>>(r.read(), 800);
          return [...(got.value ?? [])];
        } finally {
          r.releaseLock();
        }
      };
      const a = new net.NetScalePort({ host: "192.168.1.50", port: 1001 });
      const b = new net.NetScalePort({ host: "192.168.1.51", port: 1001 });
      const res: string[] = [];
      try {
        await a.open();
        const bOpen = b.open();
        let ra: number[] | string;
        try {
          ra = await ask(a, [1]);
        } catch (e) {
          ra = e instanceof Error ? e.message : String(e);
        }
        res.push(Array.isArray(ra) && ra[0] === 0xaa && ra[1] === 1 ? "A contestó bien" : typeof ra === "string" ? `A se cortó (${ra})` : "A se cortó: lo que se le mandó a la A le llegó a la B");
        await conTope(bOpen, 1500).catch(() => {});
        let rb: number[] | string;
        try {
          rb = await ask(b, [2]);
        } catch (e) {
          rb = e instanceof Error ? e.message : String(e);
        }
        res.push(Array.isArray(rb) && rb[0] === 0xbb ? "B contestó bien" : `B falló (${typeof rb === "string" ? rb : "bytes ajenos"})`);
      } finally {
        await a.close().catch(() => {});
        await b.close().catch(() => {});
        net.setNetAgentFetchForTests(null);
      }
      return { correcto: res[0] === "A contestó bien" && res[1] === "B contestó bien", resultado: res.join("; "), ejecucion: "completa" };
    }
  },
  {
    id: "E18",
    titulo: "Mostrador cerrando el puerto de otra parte",
    cliente: "Pollo y mar, Los gringos, Giuseppe, Oliem ('puerto ocupado')",
    fecha: "30/09–25/11 · 26/11 (auditoría E7)",
    quePaso: "Mostrador tomaba el único puerto autorizado aunque fuera el de la Report y, si estaba abierto por la sincronización, lo CERRABA para leer el peso: cortaba el envío.",
    fuente: "Auditoría §4 (puerto ocupado, 8 commits) y E7 (scale-weight.ts:93-126); scale-weight-ports.test.ts (C20)",
    evidencia: "derivado",
    entrada: "Un solo puerto autorizado, abierto por la sincronización de la Report; el cajero pide el peso",
    esperado: "No lo cierra (avisa que está ocupado)",
    async correr(c) {
      const report = new FakeSerialPort(null, { usbVendorId: 0x1a86, usbProductId: 0x7523 });
      await report.open();
      instalarNavegador([report]);
      const w = await c.importar("sale/scale-weight");
      let msg = "leyó un peso";
      try {
        await w.readScaleWeight();
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      await w.forgetWeightScale?.().catch?.(() => {});
      return { correcto: report.closes === 0, resultado: report.closes === 0 ? `No lo cerró; aviso: "${msg.slice(0, 70)}"` : `Le cerró el puerto a la sincronización (${report.closes} veces)`, ejecucion: "completa" };
    }
  },
  {
    id: "E19",
    titulo: "Solo lectura enviando productos a la balanza",
    cliente: "Todas (usuarios 'Solo lectura')",
    fecha: "27/11 (decisión del dueño, migración 224)",
    quePaso: "Un usuario de solo lectura veía 'Mis balanzas' en Stock y podía mandar productos o cambiar el formato de etiqueta.",
    fuente: "Commits 8520078 y 8217f5f; permissions-scales-send.test.ts",
    evidencia: "derivado",
    entrada: "Usuario 'Solo lectura' de una empresa en plan Estándar abre Stock → Mis balanzas",
    esperado: "No puede mandar productos",
    adaptacion: "La condición está en la pantalla (Inventory.tsx). main: planAllows(perfil, 'estandar') solamente (línea 1006); nuevo: planAllows + can(perfil, 'scales.send'). Se ejecutan las funciones reales de permissions.ts. La parte de la base (migración 224) no se ejecuta acá.",
    async correr(c) {
      const perm = await c.importar("auth/permissions");
      const perfil = { id: "u", company_id: "c", branch_id: "b", full_name: "X", role: "readonly", active: true, plan: "estandar" };
      const nuevo = typeof perm.PERMISSION_LABELS?.["scales.send"] === "string";
      const puede = nuevo ? perm.planAllows(perfil, "estandar") && perm.can(perfil, "scales.send") : perm.planAllows(perfil, "estandar");
      return { correcto: !puede, resultado: puede ? "Ve el botón y puede mandar productos" : "Ve el estado, sin enviar", ejecucion: "parcial", nota: "Condición de Inventory.tsx de cada versión; la base (migración 224) no se ejecuta en esta prueba." };
    }
  },
  {
    id: "E20",
    titulo: "La Report deja el puerto tomado al terminar",
    cliente: "Giuseppe ('port already open'), Oliem",
    fecha: "28/10 · 25/11 · 26/11 (auditoría E8)",
    quePaso: "Después de sincronizar, el puerto de la Report quedaba abierto: iTegra, otra pestaña u otro perfil no la podían usar.",
    fuente: "Auditoría §4 y E8 (kretz.ts:317); commit d418f84 (C21)",
    evidencia: "derivado",
    entrada: "Report: leer y mandar un producto",
    esperado: "Al terminar el puerto queda libre",
    async correr(c) {
      instalarNavegador();
      const scale = new FakeReport();
      const { setScaleSerialPort } = await c.importar("inventory/scale-serial");
      const { KretzSession, KRETZ_IO } = await c.importar("scales/engine/adapters/kretz");
      setScaleSerialPort(scale);
      const s = new KretzSession("kretz-report-lt", { branchId: null, products: [eng("a", "10", "Vacio", "kg", 15000)], online: false }, "datos", KRETZ_IO);
      await s.sync(await s.prepare(noop), noop);
      const libre = scale.readable === null;
      await s.close?.();
      return { correcto: libre, resultado: libre ? "Puerto libre al terminar" : "El puerto quedó abierto (tomado) al terminar", ejecucion: "completa" };
    }
  },
  {
    id: "E21",
    titulo: "La calibración elige un formato con dudas",
    cliente: "Calibración de Mostrador (todas las Kretz)",
    fecha: "26/11 (auditoría E18, C6)",
    quePaso: "Con una sola etiqueta que encaja en dos formatos que leen productos distintos, se guardaba el primero que coincidía.",
    fuente: "Auditoría E18 (scale-barcode.ts:208); commit 1ff098a; scale-barcode.test.ts",
    evidencia: "derivado",
    entrada: "Una etiqueta 20 00012 01256 con el peso 1,256 kg (puede ser el producto 12 o el 120)",
    esperado: "No elige sola: pide el N.º de producto u otra etiqueta",
    async correr(c) {
      const { detectScaleConfig, parseWeightBarcode } = await c.importar("sale/scale-barcode");
      const code = withCheck("200001201256");
      const cfg = detectScaleConfig(code, 1.256);
      if (!cfg) return { correcto: true, resultado: "No elige: pide el N.º de producto u otra etiqueta", ejecucion: "completa" };
      const p = parseWeightBarcode(code, cfg);
      return { correcto: false, resultado: `Guarda un formato que lee el producto ${p?.plu} (podía ser otro)`, ejecucion: "completa" };
    }
  }
];

/** Corre un escenario con un tope de tiempo (una balanza que no contesta no frena la prueba). */
export async function correrEscenario(e: Escenario, c: Cargador, topeMs = 15000): Promise<Observado> {
  try {
    return await Promise.race([
      e.correr(c),
      new Promise<Observado>((resolve) => setTimeout(() => resolve({ correcto: false, resultado: `No terminó en ${topeMs / 1000} s (se colgó)`, ejecucion: "completa" }), topeMs))
    ]);
  } catch (err) {
    return { correcto: false, resultado: `Error al ejecutar: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), ejecucion: "completa" };
  }
}

/** Formatos usados, para quien lea el informe. */
export const FORMATOS = { LT_PESOS, M2_237, PLU5_PESO, FABRICA_155 };
