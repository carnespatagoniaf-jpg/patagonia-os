import { SystelClient, type SystelExchangeLog, type SystelLink } from "./systel-client";
import { diffPlu, expectedAfterPriceChange, LAYOUT_INFO, type PluListEntry, type SystelLayout, type SystelPlu, type SystelSignature } from "./systel-plu";

/**
 * Herramienta de LABORATORIO para validar escrituras en una Cuora de BANCO (nunca la de un cliente).
 * Solo se monta con VITE_SYSTEL_LAB=1 (la compilación de producción no la incluye) y cada función
 * exige `lab: true`. Registra cada paso con sus órdenes (bytes, respuesta, ms), el protocolo usado y el
 * resultado. Se DETIENE ANTES DE ESCRIBIR si la lista no está completa, si una respuesta no pasa el
 * control (el cliente la descarta y el paso queda sin dato), si el formato del producto es ambiguo o no
 * se reconoce, si dos lecturas del mismo producto no coinciden, o si la balanza no informó decimales.
 *
 * Cambio de precio y alta son pruebas SEPARADAS: aprobar una no habilita la otra.
 * Ninguna habilita nada sola: con el informe aprobado, una persona agrega el perfil (operación + firma
 * + formato) a SYSTEL_VERIFIED_WRITE_PROFILES en el código.
 */

export interface LabStep {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
  /** Órdenes de este paso: bytes enviados y recibidos, ms y cómo se interpretó cada respuesta. */
  commands: SystelExchangeLog[];
}

export interface LabProtocol {
  signature: SystelSignature | null;
  listDigits: 4 | 6 | null;
  layout: SystelLayout | null;
  readFn: number | null;
  writeFn: number | null;
}

export type LabOutcome = "aprobado" | "detenido_antes_de_escribir" | "cancelado" | "indeterminado" | "fallo_al_escribir" | "fallo_al_restaurar" | "restaurar_a_mano";

export interface LabReport {
  test: "cambio_de_precio" | "alta";
  variant?: "con" | "sin_experimental";
  address: number;
  plu: number;
  startedAt: string;
  finishedAt: string;
  protocol: LabProtocol;
  initialList: PluListEntry[] | null;
  initial: SystelPlu | null;
  afterWrite: SystelPlu | null;
  afterRestore: SystelPlu | null;
  steps: LabStep[];
  outcome: LabOutcome;
  /** Qué falta hacer a mano (por ejemplo, borrar desde el menú el producto creado). */
  manualAction: string | null;
}

class Recorder {
  readonly steps: LabStep[] = [];
  constructor(private readonly log: SystelExchangeLog[]) {}
  async step<T>(name: string, fn: () => Promise<{ ok: boolean; detail: string; value?: T }>): Promise<{ ok: boolean; value?: T }> {
    const from = this.log.length;
    const t0 = Date.now();
    let res: { ok: boolean; detail: string; value?: T };
    try {
      res = await fn();
    } catch (err) {
      res = { ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.steps.push({ name, ok: res.ok, detail: res.detail, ms: Date.now() - t0, commands: this.log.slice(from) });
    return { ok: res.ok, value: res.value };
  }
}

interface LabContext {
  rec: Recorder;
  reader: SystelClient;
  protocol: LabProtocol;
  list: PluListEntry[] | null;
}

/** Pasos comunes, SOLO lectura: identificar, lista completa, formato inequívoco. */
async function prepare(link: SystelLink, address: number, log: SystelExchangeLog[]): Promise<LabContext & { ok: boolean }> {
  const rec = new Recorder(log);
  const reader = new SystelClient(link, { address, log });
  const protocol: LabProtocol = { signature: null, listDigits: null, layout: null, readFn: null, writeFn: null };
  const ctx: LabContext = { rec, reader, protocol, list: null };

  const id = await rec.step("identificar (firma 2 + ping 23)", async () => {
    const sig = await reader.signature();
    const ping = await reader.ping();
    protocol.signature = sig;
    if (!sig) return { ok: false, detail: "sin firma digital válida" };
    if (sig.priceDecimals !== 0 && sig.priceDecimals !== 2) return { ok: false, detail: `decimales de precio no reconocidos (${sig.priceDecimals})` };
    return { ok: true, detail: `firma ${sig.productType}/S${sig.protocolVersion}, ${sig.pluCapacity} PLU, ${sig.priceDecimals} decimales, ping ${ping?.state ?? "sin respuesta"}` };
  });
  if (!id.ok) return { ...ctx, ok: false };

  const listed = await rec.step<PluListEntry[]>("lista completa (31)", async () => {
    const l = await reader.list();
    if (!l) return { ok: false, detail: "la lista no llegó completa (sin 'F' o sin control válido): no se sigue" };
    if (l.digits === null) return { ok: false, detail: "lista vacía: no hay de dónde reconocer el formato" };
    protocol.listDigits = l.digits;
    return { ok: true, detail: `${l.entries.length} PLU de ${l.digits} dígitos`, value: l.entries };
  });
  if (!listed.ok) return { ...ctx, ok: false };
  ctx.list = listed.value ?? null;
  return { ...ctx, ok: true };
}

/** Lee un producto dos veces con el formato reconocido y exige que coincidan byte por byte. */
async function readTwice(ctx: LabContext, plu: number): Promise<SystelPlu | null> {
  const { rec, reader, protocol } = ctx;
  const det = await rec.step<SystelPlu>(`reconocer formato con el PLU ${plu} (62, o 3 si la 62 no existe)`, async () => {
    const d = await reader.detectLayout(plu, protocol.listDigits!);
    if (!d.layout) return { ok: false, detail: `formato ambiguo o no reconocido: ${d.detail}` };
    if (LAYOUT_INFO[d.layout].pluDigits !== protocol.listDigits) return { ok: false, detail: `el formato ${d.layout} no coincide con los ${protocol.listDigits} dígitos de la lista` };
    protocol.layout = d.layout;
    protocol.readFn = LAYOUT_INFO[d.layout].readFn;
    protocol.writeFn = LAYOUT_INFO[d.layout].writeFn;
    return { ok: true, detail: `${LAYOUT_INFO[d.layout].label} (lectura ${protocol.readFn})`, value: d.plu };
  });
  if (!det.ok || !det.value) return null;
  const again = await rec.step<SystelPlu>(`segunda lectura del PLU ${plu} (tiene que ser idéntica)`, async () => {
    const p = await reader.readPlu(protocol.layout!, plu);
    if (!p) return { ok: false, detail: "no se pudo releer" };
    if (p.raw !== det.value!.raw) return { ok: false, detail: "las dos lecturas no coinciden: no se escribe" };
    return { ok: true, detail: "idéntica", value: p };
  });
  return again.ok ? again.value ?? null : null;
}

function finish(base: Omit<LabReport, "finishedAt" | "steps" | "protocol">, ctx: LabContext): LabReport {
  return { ...base, protocol: ctx.protocol, steps: ctx.rec.steps, finishedAt: new Date().toISOString() };
}

/**
 * Solo se escribe sobre productos DESTINADOS A PRUEBAS: el nombre que tiene en la balanza tiene que
 * empezar con "PRUEBA" y ser exactamente el que la persona escribió. Ningún número (7999, 7998…) se
 * da por libre ni por "de prueba" por sí solo: se comprueba en la balanza cada vez.
 */
export const TEST_NAME_PREFIX = "PRUEBA";

export function isTestProductName(name: string): boolean {
  return name.trim().toUpperCase().startsWith(TEST_NAME_PREFIX);
}

export interface PriceLabOptions {
  lab: true;
  address: number;
  plu: number;
  /** Nombre del producto de prueba tal como se cargó a mano en la balanza (tiene que empezar con PRUEBA). */
  expectedName: string;
  /** Precio nuevo, crudo (6 números, con los decimales de esa balanza). */
  newPriceRaw: number;
  /** Última confirmación de la persona antes de escribir (muestra el estado inicial). */
  confirm: (initial: SystelPlu) => Promise<boolean>;
  log?: SystelExchangeLog[];
}

/**
 * Prueba de CAMBIO DE PRECIO (33): leer → guardar estado inicial → cambiar SOLO el precio → releer →
 * restaurar el precio original → releer y comparar con el estado inicial → releer la lista.
 */
export async function runPriceChangeLab(link: SystelLink, o: PriceLabOptions): Promise<LabReport> {
  if (o.lab !== true) throw new Error("solo para laboratorio");
  const log = o.log ?? [];
  const startedAt = new Date().toISOString();
  const ctx = await prepare(link, o.address, log);
  const base = { test: "cambio_de_precio" as const, address: o.address, plu: o.plu, startedAt, initialList: ctx.list, initial: null as SystelPlu | null, afterWrite: null as SystelPlu | null, afterRestore: null as SystelPlu | null, manualAction: null as string | null };
  if (!ctx.ok) return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  if (!ctx.list!.some((e) => e.number === o.plu)) {
    ctx.rec.steps.push({ name: "producto en la lista", ok: false, detail: `el PLU ${o.plu} no está en la balanza`, ms: 0, commands: [] });
    return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  }
  const initial = await readTwice(ctx, o.plu);
  if (!initial) return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  base.initial = initial;
  const onScale = initial.name.trim();
  if (!isTestProductName(onScale) || onScale.toUpperCase() !== o.expectedName.trim().toUpperCase()) {
    ctx.rec.steps.push({
      name: "producto destinado a pruebas",
      ok: false,
      detail: `en la balanza el PLU ${o.plu} se llama "${onScale}"; tiene que llamarse exactamente "${o.expectedName.trim()}" y empezar con ${TEST_NAME_PREFIX}: no se toca`,
      ms: 0,
      commands: []
    });
    return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  }
  if (!Number.isInteger(o.newPriceRaw) || o.newPriceRaw < 0 || o.newPriceRaw > 999999 || o.newPriceRaw === initial.prices[0]) {
    ctx.rec.steps.push({ name: "precio de prueba", ok: false, detail: "el precio nuevo tiene que ser distinto del actual y de 0 a 999999", ms: 0, commands: [] });
    return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  }
  if (!(await o.confirm(initial))) {
    ctx.rec.steps.push({ name: "confirmación", ok: false, detail: "cancelado por la persona", ms: 0, commands: [] });
    return finish({ ...base, outcome: "cancelado" }, ctx);
  }

  const writer = new SystelClient(link, { address: o.address, log, writes: { price: true } });
  const changed = await ctx.rec.step<SystelPlu>(`cambiar SOLO el precio (33): ${initial.prices[0]} → ${o.newPriceRaw}`, async () => {
    const out = await writer.changePrice(initial, o.newPriceRaw);
    return { ok: out.ok, detail: `${out.verdict}${out.detail ? `: ${out.detail}` : ""}${out.diff.length ? ` (distinto: ${out.diff.join(", ")})` : ""}`, value: out.readBack ?? undefined };
  });
  base.afterWrite = changed.value ?? null;
  const indeterminate = ctx.rec.steps.at(-1)!.detail.startsWith("indeterminado");
  const reread = await ctx.rec.step("releer: solo cambió la lista 1", async () => {
    const p = await ctx.reader.readPlu(ctx.protocol.layout!, o.plu);
    if (!p) return { ok: false, detail: "no se pudo releer" };
    base.afterWrite = p;
    const diff = diffPlu(expectedAfterPriceChange(initial, o.newPriceRaw), p);
    return { ok: diff.length === 0, detail: diff.length ? `distinto en: ${diff.join(", ")}` : `idéntico salvo el precio (gestión: "${initial.managedBy}" → "${p.managedBy}")` };
  });
  if (!changed.ok || !reread.ok) {
    // Igual se intenta dejarlo como estaba, y se registra.
    const back = await restorePrice(ctx, writer, o.plu, initial);
    base.afterRestore = back;
    const restored = !!back && diffPlu(expectedAfterPriceChange(initial, initial.prices[0]), back).length === 0;
    return finish({ ...base, outcome: !restored ? "fallo_al_restaurar" : indeterminate ? "indeterminado" : "fallo_al_escribir" }, ctx);
  }
  const back = await restorePrice(ctx, writer, o.plu, initial);
  base.afterRestore = back;
  const listAgain = await ctx.rec.step("lista después: mismos PLU que al empezar", async () => {
    const l = await ctx.reader.list();
    if (!l) return { ok: false, detail: "la lista no llegó completa" };
    const a = ctx.list!.map((e) => e.number).join(",");
    const b = l.entries.map((e) => e.number).join(",");
    const versions = l.entries.filter((e, i) => ctx.list![i]?.version !== e.version).map((e) => `${e.number}:${e.version}`);
    return { ok: a === b, detail: a === b ? `mismos ${l.entries.length} PLU${versions.length ? `; versión cambiada en ${versions.join(" ")}` : ""}` : "la lista de PLU cambió" };
  });
  const restoredOk = !!back && diffPlu(expectedAfterPriceChange(initial, initial.prices[0]), back).length === 0;
  return finish({ ...base, outcome: restoredOk && listAgain.ok ? "aprobado" : "fallo_al_restaurar" }, ctx);
}

async function restorePrice(ctx: LabContext, writer: SystelClient, plu: number, initial: SystelPlu): Promise<SystelPlu | null> {
  const r = await ctx.rec.step<SystelPlu>(`restaurar el precio original (33): ${initial.prices[0]}`, async () => {
    const now = await ctx.reader.readPlu(ctx.protocol.layout!, plu);
    if (!now) return { ok: false, detail: "no se pudo leer antes de restaurar" };
    if (now.prices[0] === initial.prices[0]) return { ok: true, detail: "ya tenía el precio original", value: now };
    const out = await writer.changePrice(now, initial.prices[0]);
    return { ok: out.ok, detail: `${out.verdict}${out.detail ? `: ${out.detail}` : ""}`, value: out.readBack ?? undefined };
  });
  const check = await ctx.rec.step<SystelPlu>("releer y comparar con el estado inicial", async () => {
    const p = await ctx.reader.readPlu(ctx.protocol.layout!, plu);
    if (!p) return { ok: false, detail: "no se pudo releer" };
    const diff = diffPlu(expectedAfterPriceChange(initial, initial.prices[0]), p);
    return { ok: diff.length === 0, detail: diff.length ? `distinto en: ${diff.join(", ")}` : `igual al inicial (bytes ${p.raw === initial.raw ? "idénticos" : "distintos solo en la gestión"})`, value: p };
  });
  return r.ok && check.ok ? check.value ?? null : check.value ?? null;
}

export interface CreateLabOptions {
  lab: true;
  address: number;
  /** Número LIBRE (no está en la lista). */
  plu: number;
  name: string;
  priceRaw: number;
  saleType: "P" | "U";
  /**
   * Forma del byte de control. "con" es la justificada por la documentación; "sin_experimental"
   * es una variante aparte, que la persona elige a propósito y en otra corrida. Nunca se prueban las dos solas.
   */
  variant: "con" | "sin_experimental";
  confirm: () => Promise<boolean>;
  log?: SystelExchangeLog[];
}

/**
 * Prueba de ALTA (61/4) en un número libre: leer lista → crear → releer y comparar campo por campo →
 * releer la lista. La restauración es BORRARLO A MANO desde el menú de la balanza (Patagonia nunca manda
 * la función 5); después `verifyCreateRestored` confirma que ya no está.
 */
export async function runCreateLab(link: SystelLink, o: CreateLabOptions): Promise<LabReport> {
  if (o.lab !== true) throw new Error("solo para laboratorio");
  const log = o.log ?? [];
  const startedAt = new Date().toISOString();
  const ctx = await prepare(link, o.address, log);
  const base = { test: "alta" as const, variant: o.variant, address: o.address, plu: o.plu, startedAt, initialList: ctx.list, initial: null as SystelPlu | null, afterWrite: null as SystelPlu | null, afterRestore: null as SystelPlu | null, manualAction: null as string | null };
  if (!ctx.ok) return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  const known = new Set(ctx.list!.map((e) => e.number));
  if (!isTestProductName(o.name)) {
    ctx.rec.steps.push({ name: "nombre de prueba", ok: false, detail: `el producto de prueba tiene que llamarse "${TEST_NAME_PREFIX}…"`, ms: 0, commands: [] });
    return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  }
  if (known.has(o.plu) || known.size === 0) {
    ctx.rec.steps.push({ name: "número libre", ok: false, detail: known.has(o.plu) ? `el PLU ${o.plu} ya existe: el alta se prueba en un número libre` : "balanza sin productos", ms: 0, commands: [] });
    return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  }
  // El formato se reconoce leyendo un producto que YA existe (el primero de la lista), dos veces.
  const sample = await readTwice(ctx, ctx.list![0].number);
  if (!sample) return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  // No alcanza con que falte en la lista: se pide el número directamente y tiene que contestar
  // "no existe" (E7). Cualquier otra cosa (un producto, sin respuesta, otro error) frena.
  const free = await ctx.rec.step(`comprobar que el PLU ${o.plu} está libre (lectura directa: tiene que dar E7)`, async () => {
    const before = ctx.reader.log.length;
    const p = await ctx.reader.readPlu(ctx.protocol.layout!, o.plu);
    if (p) return { ok: false, detail: `el PLU ${o.plu} existe ("${p.name.trim()}"): no se usa` };
    const answers = ctx.reader.log.slice(before).map((l) => l.rxText);
    return answers.includes("E7") ? { ok: true, detail: "la balanza contestó E7 (no existe)" } : { ok: false, detail: `la balanza no confirmó que esté libre (${answers.join(", ") || "sin respuesta"})` };
  });
  if (!free.ok) return finish({ ...base, outcome: "detenido_antes_de_escribir" }, ctx);
  if (!(await o.confirm())) {
    ctx.rec.steps.push({ name: "confirmación", ok: false, detail: "cancelado por la persona", ms: 0, commands: [] });
    return finish({ ...base, outcome: "cancelado" }, ctx);
  }
  const writer = new SystelClient(link, { address: o.address, log, writes: { create: true }, createChecksum: o.variant });
  const created = await ctx.rec.step<SystelPlu>(`alta del PLU ${o.plu} (${LAYOUT_INFO[ctx.protocol.layout!].writeFn}, ${o.variant === "con" ? "con control" : "SIN control, experimental"})`, async () => {
    const out = await writer.createPlu(ctx.protocol.layout!, { number: o.plu, name: o.name, code: o.plu, saleType: o.saleType, priceRaw: o.priceRaw }, known);
    return { ok: out.ok, detail: `${out.verdict}${out.detail ? `: ${out.detail}` : ""}${out.diff.length ? ` (distinto: ${out.diff.join(", ")})` : ""}`, value: out.readBack ?? undefined };
  });
  base.afterWrite = created.value ?? null;
  const listAgain = await ctx.rec.step("lista después: los de antes + el nuevo", async () => {
    const l = await ctx.reader.list();
    if (!l) return { ok: false, detail: "la lista no llegó completa" };
    const now = new Set(l.entries.map((e) => e.number));
    const missing = [...known].filter((n) => !now.has(n));
    return { ok: missing.length === 0 && now.has(o.plu) === created.ok, detail: missing.length ? `faltan: ${missing.join(", ")}` : `${l.entries.length} PLU` };
  });
  const exists = !!base.afterWrite || (await ctx.reader.readPlu(ctx.protocol.layout!, o.plu)) !== null;
  return finish(
    {
      ...base,
      outcome: created.ok && listAgain.ok ? "restaurar_a_mano" : ctx.rec.steps.some((s) => s.detail.startsWith("indeterminado")) ? "indeterminado" : "fallo_al_escribir",
      manualAction: exists ? `Borrar a mano el PLU ${o.plu} desde el menú de la balanza y después tocar "Verificar restauración".` : null
    },
    ctx
  );
}

/** Después de borrar a mano el producto de prueba: confirma que ya no está y que la lista volvió a la inicial. */
export async function verifyCreateRestored(link: SystelLink, report: LabReport, log: SystelExchangeLog[] = []): Promise<LabStep> {
  const reader = new SystelClient(link, { address: report.address, log });
  const from = log.length;
  const t0 = Date.now();
  const l = await reader.list();
  const before = (report.initialList ?? []).map((e) => e.number).join(",");
  const ok = !!l && l.entries.map((e) => e.number).join(",") === before;
  return { name: `verificar que el PLU ${report.plu} se borró`, ok, detail: !l ? "la lista no llegó completa" : ok ? "la lista volvió a la inicial" : "la lista no es la inicial", ms: Date.now() - t0, commands: log.slice(from) };
}
