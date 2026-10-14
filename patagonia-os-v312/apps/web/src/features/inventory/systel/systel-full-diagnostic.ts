import type { Product } from "@patagonia/domain";
import type { ScaleConfig } from "../../sale/scale-barcode";
import { resolveScan } from "../../sale/scan-resolve";
import { configFromSystelTemplate, systelConfigForCode } from "../../sale/systel-label-format";
import { SYSTEL_READ_FUNCTIONS, type SystelClient } from "./systel-client";
import { assignLineKeys, candidateTickets, groupTickets, linkTicketLines, parseSalesReport, type ScalePluInfo, type SystelSaleLine } from "./systel-sales";
import type { PluCache } from "./systel-ticket-detail";
import { pluEanSetting, type PluEan } from "./systel-plu";

/**
 * Diagnóstico COMPLETO de una Systel por cable, en una sola acción y SOLO LECTURA.
 *
 * Manda únicamente funciones de lectura (23 ping, 2 firma, 28 reloj, 39 configuración, 62/3 un producto,
 * 72 reporte de ventas). El cliente Systel además BLOQUEA cualquier otra función (lista blanca), así que
 * esto no puede cambiar precios, PLU, configuración ni ventas de la balanza, ni "Cerrar ventas" (32).
 *
 * Qué responde, paso por paso: ¿contesta? ¿qué modelo y protocolo? ¿qué fecha y hora tiene? ¿qué formato
 * de códigos usa y Patagonia lo puede leer? ¿sus productos coinciden con los de Patagonia (código y forma
 * de venta)? ¿guarda ventas y en qué forma se piden? ¿el detalle se interpreta bien (producto, kilos,
 * importe) y la etiqueta que imprimiría cada artículo se leería con los mismos kilos?
 *
 * E7 ("el dato pedido no existe", documento pág. 4) se informa como lo que es: para ESE pedido la balanza
 * no tiene datos. No prueba que no haya ventas (pudo pedirse mal, o se hizo "Cerrar ventas", que según el
 * manual las borra). Por eso se prueban varias formas del pedido antes de concluir.
 */

export type DiagStatus = "ok" | "aviso" | "falla" | "no_aplica";

export interface DiagStep {
  id: string;
  label: string;
  status: DiagStatus;
  detail: string;
}

export interface SystelDiagnostic {
  steps: DiagStep[];
  /** La conclusión en una frase, para la pantalla y para soporte. */
  verdict: string;
  /** Datos crudos útiles para soporte (sin datos personales). */
  data: Record<string, unknown>;
}

export interface DiagnosticInput {
  products: Product[];
  /** Formato de etiquetas guardado en la sucursal (Mostrador), para compararlo con el de la balanza. */
  branchConfig: ScaleConfig | null;
  now?: Date;
  onProgress?: (text: string) => void;
  /** Recibe la configuración leída (para que Mostrador use el formato de códigos de la balanza). */
  onConfig?: (values: Record<string, string>) => void;
  /** Recibe el código de barras propio de cada producto leído (por código de producto). */
  onPluBarcodes?: (perPlu: Record<string, { type: number | null; config: string | null; p1?: number; p2?: number }>) => void;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const ddmmyy = (d: Date) => `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${pad2(d.getFullYear() % 100)}`;
const money = (n: number) => `$${n.toLocaleString("es-AR")}`;

/**
 * Pedidos de la 72, de hoy hacia atrás, en día-mes-año con la fecha de FIN SIN INCLUIR (comprobado en la balanza
 * real el 14/10: "141026141026" → E7, "141026151026" → reporte válido).
 */
export function salesRequestVariants(today: Date): [string, string][] {
  const d = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  return [
    ["hoy", ddmmyy(d(0)) + ddmmyy(d(1))],
    ["últimos 7 días", ddmmyy(d(-7)) + ddmmyy(d(1))],
    ["este mes", ddmmyy(first) + ddmmyy(d(1))],
    ["todo lo guardado", "010100" + ddmmyy(d(1))]
  ];
}

function sameConfig(a: ScaleConfig | null, b: ScaleConfig | null): boolean {
  return !!a && !!b && a.prefixLength === b.prefixLength && a.pluLength === b.pluLength && a.weightLength === b.weightLength && a.weightDivisor === b.weightDivisor && a.totalLength === b.totalLength && a.payloadType === b.payloadType;
}

/** El código que imprimiría la balanza para un artículo, con su formato (P = código, C = cantidad, resto = 0). */
export function labelFor(template: string, code: number, quantityRaw: number): string | null {
  const p = template.split("P").length - 1;
  const c = template.split("C").length - 1;
  const pStr = String(code).padStart(p, "0");
  const cStr = String(quantityRaw).padStart(c, "0");
  if (pStr.length > p || cStr.length > c) return null;
  let pi = 0;
  let ci = 0;
  const first12 = [...template].map((ch) => (ch === "P" ? pStr[pi++] : ch === "C" ? cStr[ci++] : /\d/.test(ch) ? ch : "0")).join("");
  const sum = first12.split("").map(Number).reduce((a, n, i) => a + n * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

export async function runSystelDiagnostic(client: SystelClient, input: DiagnosticInput): Promise<SystelDiagnostic> {
  const now = input.now ?? new Date();
  const progress = input.onProgress ?? (() => {});
  const steps: DiagStep[] = [];
  const data: Record<string, unknown> = {};
  const add = (id: string, label: string, status: DiagStatus, detail: string) => steps.push({ id, label, status, detail });
  // Garantía: el diagnóstico solo usa funciones de lectura.
  data.funcionesPermitidas = [...SYSTEL_READ_FUNCTIONS];

  // 1. ¿Contesta?
  progress("1/8 ¿Contesta la balanza?");
  const ping = await client.ping();
  if (!ping) {
    const last = client.log[client.log.length - 1];
    add("respuesta", "La balanza contesta", "falla", last?.rxText ? `contestó "${last.rxText}" (${last.result})` : "no contestó");
    return { steps, verdict: "La balanza no contestó: no se pudo diagnosticar nada más. No es un problema de ventas ni de formatos.", data };
  }
  add("respuesta", "La balanza contesta", "ok", `sí (N.º ${client.address}, estado ${ping.state === "T" ? "actualizada" : ping.state === "D" ? "desactualizada (normal si no se sincroniza con un programa)" : "bloqueada esperando sincronización"})`);

  // 2. Modelo y protocolo.
  progress("2/8 Modelo y protocolo");
  const sig = await client.signature();
  data.firma = sig;
  add(
    "modelo",
    "Modelo y protocolo",
    sig ? "ok" : "aviso",
    sig ? `producto ${sig.productType}, capacidad ${sig.capacityGrams / 1000} kg, protocolo ${sig.protocolVersion}, ${sig.pluCapacity} productos, precios con ${sig.priceDecimals} decimales` : "no informó su firma"
  );

  // 3. Reloj.
  progress("3/8 Fecha y hora de la balanza");
  const clock = await client.clock();
  data.reloj = clock;
  let scaleToday = now;
  const cm = clock?.match(/(\d\d):(\d\d):(\d\d) (\d\d)\/(\d\d)\/(\d\d)/);
  if (cm) {
    const scaleDate = new Date(2000 + Number(cm[6]), Number(cm[5]) - 1, Number(cm[4]), Number(cm[1]), Number(cm[2]), Number(cm[3]));
    scaleToday = scaleDate;
    const diffMin = Math.round((scaleDate.getTime() - now.getTime()) / 60000);
    add("reloj", "Fecha y hora", Math.abs(diffMin) <= 10 ? "ok" : "aviso", `${clock}${Math.abs(diffMin) <= 10 ? " (coincide con la computadora)" : ` — difiere ${diffMin} minutos de la computadora`}`);
  } else {
    add("reloj", "Fecha y hora", "aviso", clock ? `formato inesperado: "${clock}"` : "no la informó (se usa la fecha de la computadora)");
  }

  // 4. Configuración y formato de códigos.
  progress("4/8 Configuración y formato de códigos");
  const config = await client.config();
  if (config) input.onConfig?.(config.values);
  const v = config?.values ?? {};
  data.formatos = { pesables: v.E_P ?? null, unitarios: v.E_U ?? null, sumas: v.E_S ?? null, codigoEnTicket: v.ETi ?? v.Eti ?? null };
  if (!config) {
    add("formatos", "Formato de los códigos", "aviso", "no se pudo leer la configuración");
  } else {
    const wCfg = v.E_P ? configFromSystelTemplate(v.E_P) : null;
    const uCfg = v.E_U ? configFromSystelTemplate(v.E_U) : null;
    const readable = !!wCfg && (!v.E_U || !!uCfg);
    const branchOk = sameConfig(wCfg, input.branchConfig);
    add(
      "formatos",
      "Formato de los códigos",
      readable ? (branchOk ? "ok" : "aviso") : "falla",
      `pesables ${v.E_P ?? "?"}, unitarios ${v.E_U ?? "?"}, total ${v.E_S ?? "?"}, código por producto en el ticket: ${(v.ETi ?? v.Eti) === "S" ? "sí" : (v.ETi ?? v.Eti) === "N" ? "no" : "?"}. ` +
        (readable ? "Patagonia lo puede leer. " : "Patagonia NO lo puede leer sin riesgo (no cargaría esas etiquetas). ") +
        (input.branchConfig ? (branchOk ? "Coincide con el de la sucursal." : "NO coincide con el guardado en la sucursal: Mostrador usa el de la balanza.") : "")
    );
  }

  // 5. Productos de la balanza ↔ Patagonia: código, forma de venta y código de barras PROPIO de cada uno.
  progress("5/8 Productos de la balanza");
  const cache: PluCache = { layout: null, plus: new Map() };
  const eans = new Map<number, PluEan>();
  const prices = new Map<number, number[]>();
  const readPlu = async (n: number): Promise<ScalePluInfo | null> => {
    if (cache.plus.has(n)) return cache.plus.get(n)!;
    let info: ScalePluInfo | null = null;
    let raw: string | null = null;
    if (!cache.layout) {
      for (const digits of [4, 6] as const) {
        const r = await client.detectLayout(n, digits);
        if (r.layout) {
          cache.layout = r.layout;
          info = { number: n, code: r.plu.code, name: r.plu.name, saleType: r.plu.saleType };
          prices.set(n, r.plu.prices);
          raw = r.plu.raw;
          data.formatoProducto = { layout: r.layout, ejemplo: r.plu.raw };
          break;
        }
      }
    } else {
      const plu = await client.readPlu(cache.layout, n);
      if (plu) {
        info = { number: n, code: plu.code, name: plu.name, saleType: plu.saleType };
        prices.set(n, plu.prices);
        raw = plu.raw;
      }
    }
    if (info) cache.plus.set(n, info);
    if (raw) eans.set(n, pluEanSetting(raw));
    return info;
  };
  // Todos los productos de Patagonia con código de balanza (hasta 150): así se sabe el formato de etiqueta de cada uno.
  const toRead = input.products.filter((p) => (p.active ?? true) && /^\d{1,4}$/.test(p.code)).slice(0, 150);
  const pluChecks: string[] = [];
  let pluProblems = 0;
  let notInScale = 0;
  for (const [i, p] of toRead.entries()) {
    if (i % 10 === 0) progress(`5/8 Productos de la balanza (${i + 1} de ${toRead.length})`);
    const info = await readPlu(Number(p.code));
    if (!info) {
      notInScale++;
      continue;
    }
    const sameCode = String(info.code) === p.code;
    const weighed = info.saleType === "P" || info.saleType === "C";
    const sameUnit = weighed === (p.unit === "kg");
    if (!sameCode || !sameUnit) {
      pluProblems++;
      pluChecks.push(`N.º ${p.code} "${info.name.trim()}" código ${info.code}${sameCode ? "" : ` (≠ ${p.code} de "${p.name}")`}, ${weighed ? "por peso" : "por unidad"}${sameUnit ? "" : ` (en Patagonia "${p.name}" es ${p.unit === "kg" ? "por kg" : "por unidad"})`}`);
    }
  }
  const readCount = toRead.length - notInScale;
  data.productos = [...cache.plus.values()].map((x) => ({ ...x, ean: eans.get(x.number) ?? null }));
  add(
    "productos",
    "Productos (código y forma de venta)",
    toRead.length === 0 ? "no_aplica" : pluProblems === 0 ? "ok" : "aviso",
    toRead.length === 0
      ? "no hay productos con código de balanza en Patagonia"
      : `${readCount} de ${toRead.length} productos de Patagonia están en la balanza${notInScale ? ` (${notInScale} no)` : ""}; ${pluProblems === 0 ? "todos con el mismo código y la misma forma de venta" : `${pluProblems} no coinciden: ${pluChecks.slice(0, 5).join(" · ")}`}`
  );

  // Código de barras propio de cada producto (lo que imprime debajo de cada artículo del ticket).
  const zeros: string[] = [];
  const ownFormat = new Map<string, string[]>();
  const generalUse: string[] = [];
  const noCode: string[] = [];
  for (const [n, e] of eans) {
    const name = `${n}`;
    if (e.type === 0) generalUse.push(name);
    else if (e.type === 1 && e.config && !e.config.includes("P")) zeros.push(name);
    else if (e.type === 1 && e.config) ownFormat.set(e.config, [...(ownFormat.get(e.config) ?? []), name]);
    else noCode.push(name);
  }
  // Con los precios de lista 1 y 2 (en pesos, según los decimales de la firma): Mostrador los usa para saber el
  // importe de cada artículo a partir del TOTAL (systel-ticket-settle.ts).
  const dec = sig?.priceDecimals === 2 ? 100 : 1;
  input.onPluBarcodes?.(Object.fromEntries([...eans].map(([n, e]) => [String(cache.plus.get(n)?.code ?? n), { type: e.type, config: e.config, p1: (prices.get(n)?.[0] ?? 0) / dec, p2: (prices.get(n)?.[1] ?? 0) / dec }])));
  data.codigoPorProducto = { enCeros: zeros, propio: Object.fromEntries(ownFormat), general: generalUse, otros: noCode };
  const ownText = [...ownFormat].map(([cfg, ns]) => `formato propio ${cfg}: ${ns.length} (${ns.slice(0, 8).join(", ")}${ns.length > 8 ? "…" : ""})`);
  add(
    "codigo_producto",
    "Código de barras de cada producto",
    eans.size === 0 ? "no_aplica" : zeros.length > 0 ? "aviso" : "ok",
    eans.size === 0
      ? "no se leyó ningún producto"
      : [
          zeros.length ? `imprimen el código EN CEROS (código propio vacío): ${zeros.length} (${zeros.slice(0, 12).join(", ")}${zeros.length > 12 ? "…" : ""})` : "",
          ...ownText,
          generalUse.length ? `usan el formato general: ${generalUse.length}` : "",
          noCode.length ? `sin código o desconocido: ${noCode.length}` : ""
        ]
          .filter(Boolean)
          .join(" · ") + ". Mostrador lee cada etiqueta con el formato de ESE producto."
  );

  // 6. Ventas guardadas (72). REAL 14/10: la fecha de fin no se incluye ("hoy a hoy" = E7) y sin ventas
  //    la balanza contesta solo "F". Se busca desde hoy hacia atrás hasta encontrar artículos.
  progress("6/8 Ventas guardadas en la balanza");
  const tried: string[] = [];
  let report: { data: string; request: string; label: string; lines: number } | null = null;
  let comm = false;
  let emptyAnswers = 0;
  for (const [label, req] of salesRequestVariants(scaleToday)) {
    const r = await client.salesReportRaw(req);
    if ("data" in r) {
      const p = parseSalesReport(r.data);
      const n = p.ok ? p.lines.length : -1;
      tried.push(`${label} (${req}): ${n === 0 ? "sin ventas" : n > 0 ? `${n} artículos` : "formato no reconocido"}`);
      if (n === 0) {
        emptyAnswers++;
        continue;
      }
      report = { data: r.data, request: req, label, lines: n };
      break;
    }
    tried.push(`${label} (${req}): ${r.code ?? r.error}`);
    if (r.code !== "E7") {
      comm = true;
      break;
    }
  }
  data.pedidosProbados = tried;
  if (!report) {
    const allEmpty = emptyAnswers > 0 && !comm;
    add(
      "ventas",
      "Ventas guardadas",
      comm ? "falla" : "aviso",
      comm
        ? `no se pudo pedir el reporte: ${tried[tried.length - 1]}`
        : allEmpty
          ? `la balanza contesta el pedido de ventas, pero no tiene ventas guardadas (${tried.join(" · ")}). Si hoy se vendió con la balanza, se borraron con "Cerrar ventas".`
          : `la balanza no aceptó ninguna forma del pedido (${tried.join(" · ")})`
    );
    add("detalle", "Detalle de las ventas", "no_aplica", "no hay ventas guardadas para interpretar");
    add("interpretacion", "Productos, kilos e importes", "no_aplica", "no hay ventas guardadas para interpretar");
    return {
      steps,
      verdict: comm
        ? "La balanza contesta, pero falló el pedido de ventas por comunicación: repetir el diagnóstico una vez."
        : allEmpty
          ? "La balanza entrega el reporte de ventas, pero hoy está vacío (sin ventas guardadas). Repetir el diagnóstico después de que la balanza imprima tickets."
          : "La balanza contesta, pero no entrega ventas por la función 72.",
      data
    };
  }
  data.pedidoQueAnduvo = report.request;
  add("ventas", "Ventas guardadas", "ok", `sí: ${report.lines} artículos en el pedido "${report.label}" (${report.request})`);

  // 7. Detalle: formato y numeración.
  progress("7/8 Detalle de las ventas");
  const parsed = parseSalesReport(report.data);
  data.reporteMuestra = report.data.slice(0, 600);
  if (!parsed.ok) {
    add("detalle", "Detalle de las ventas", "falla", `no coincide con el formato del documento: ${parsed.problem}`);
    add("interpretacion", "Productos, kilos e importes", "no_aplica", "el detalle no se pudo interpretar");
    return { steps, verdict: "La balanza entrega ventas, pero en un formato distinto del documentado: con este registro se ajusta el lector, sin volver a pedirle nada al cliente.", data };
  }
  const lines: SystelSaleLine[] = assignLineKeys(parsed.lines, client.address);
  const ids = new Set(lines.map((l) => `${l.date}|${Number(l.ticketId)}`)).size;
  const perArticle = ids === lines.length;
  const days = [...new Set(lines.map((l) => l.date))];
  data.numeracion = perArticle ? "por artículo" : "por ticket";
  add("detalle", "Detalle de las ventas", "ok", `${lines.length} artículos (${days.join(", ")}), numerados ${perArticle ? "uno por ARTÍCULO" : "por TICKET"}${perArticle ? "" : ` (${groupTickets(lines).length} tickets)`}`);

  // 8. Interpretación: producto, kilos e importe, y la etiqueta que imprimiría cada artículo.
  progress("8/8 Interpretación de productos, kilos e importes");
  for (const n of [...new Set(lines.map((l) => l.plu))].slice(0, 30)) await readPlu(n);
  const recent = [...lines].sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`)).slice(0, 20);
  let okLines = 0;
  const problems: string[] = [];
  const labelChecks: string[] = [];
  for (const l of recent) {
    const linked = linkTicketLines({ ticketId: l.ticketId, date: l.date, firstTime: l.time, time: l.time, seller: l.seller, lines: [l], total: l.amount }, cache.plus, input.products);
    if (!linked.ok) {
      problems.push(linked.reason);
      continue;
    }
    okLines++;
    const line = linked.lines[0];
    const info = cache.plus.get(l.plu)!;
    const tpl = info.saleType === "U" ? v.E_U : v.E_P;
    if (tpl && configFromSystelTemplate(tpl)) {
      const raw = info.saleType === "U" ? l.units : l.grams;
      const code = labelFor(tpl, info.code, raw);
      if (!code) {
        labelChecks.push(`${line.product.name} ${raw}: no entra en el código (${tpl})`);
      } else {
        const cfg = systelConfigForCode(code, { weighed: v.E_P ?? null, unit: v.E_U ?? null, at: 0 });
        const res = cfg && cfg !== "no_soportado" ? resolveScan(code, input.products, cfg) : null;
        const good = !!res && res.type === "label" && res.product.id === line.product.id && Math.abs(res.quantity - line.quantity) < 0.0005;
        if (!good) labelChecks.push(`${line.product.name}: su etiqueta (${code}) no se cargaría en Mostrador${res && res.type === "error" ? ` (${res.message.split(".")[0]})` : ""}`);
      }
    }
  }
  const sample = recent.slice(0, 3).map((l) => `N.º ${Number(l.ticketId)} ${l.time}: PLU ${l.plu} ${l.grams ? `${(l.grams / 1000).toFixed(3)} kg` : `${l.units} u.`} ${money(l.amount)}`);
  const status: DiagStatus = problems.length === 0 && labelChecks.length === 0 ? "ok" : "aviso";
  add(
    "interpretacion",
    "Productos, kilos e importes",
    status,
    `${okLines} de ${recent.length} artículos recientes se vinculan con su producto de Patagonia (código y forma de venta)` +
      (problems.length ? `. Problemas: ${[...new Set(problems)].slice(0, 5).join(" · ")}` : "") +
      (labelChecks.length ? `. Etiquetas: ${labelChecks.slice(0, 3).join(" · ")}` : ". Las etiquetas de esos artículos se leerían con los mismos kilos") +
      `. Ejemplos: ${sample.join(" · ")}`
  );
  // Tickets de varios artículos encontrables por su total (sin elegir ninguno).
  const multi = groupTickets(lines).filter((t) => t.lines.length > 1).length;
  data.ticketsVariosArticulos = perArticle ? "numeración por artículo: se arman por N.º consecutivos del mismo vendedor" : multi;
  data.candidatosEjemplo = recent[0] ? candidateTickets(lines, recent[0].amount, 1).length : 0;
  return {
    steps,
    verdict:
      status === "ok"
        ? "La balanza entrega el detalle de las ventas y Patagonia lo interpreta bien: el TOTAL escaneado en Mostrador va a cargar cada producto con sus kilos."
        : "La balanza entrega el detalle; hay productos o datos a corregir de nuestro lado (ver el detalle).",
    data
  };
}
