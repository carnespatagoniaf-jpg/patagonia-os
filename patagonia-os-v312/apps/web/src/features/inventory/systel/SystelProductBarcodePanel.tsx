import { useState } from "react";
import type { SystelClient } from "./systel-client";
import { compareWithBackup, restoreFromBackup, rewriteAllProductBarcodes, takeProductBackup, targetCodeFor, verifyBackup, type ProductBackup, type TypeByteMode } from "./systel-product-barcode";
import { runStage1FreeSlot, runStage2OneProduct, runTestProductRewrite, type WriteTestReport } from "./systel-barcode-write-test";
import { saveSystelPluBarcodes } from "../../sale/systel-label-format";
import { parsePluAs, pluEanSetting, type SystelLayout } from "./systel-plu";

/**
 * "Código de barras de cada producto" (Stock → Balanza, solo empresas piloto Systel).
 *
 * Siempre: respaldo y comparación (solo lectura).
 *
 * Escritura (configurar el código de cada producto), con estas protecciones:
 * 1. Solo existe si la web se armó con VITE_SYSTEL_BARCODE_WRITES=1. Producción NO la tiene: ahí no hay ningún
 *    botón que escriba y el cliente de la balanza se crea sin permiso de escritura.
 * 2. Solo función 61 (producto). Nunca precios, altas, borrados, cierre de ventas ni configuración general.
 * 3. Orden obligatorio, en la misma balanza (firma):
 *    1) número LIBRE (verificado "no existe" justo antes);
 *    2) UN producto real sin ventas en 40 días;
 *    3) el resto.
 *    Cada paso exige el anterior confirmado.
 * 4. Respaldo completo y verificado del día, y "AUTORIZO" escrito (dueño + cliente) en cada paso.
 * 5. Antes de mandar se compara con lo leído; después se relee; si cambió algo más que el código, se restaura y se frena.
 */
export const SYSTEL_PRODUCT_BARCODE_WRITE_ENABLED = import.meta.env.VITE_SYSTEL_BARCODE_WRITES === "1";

const BACKUP_KEY = "patagonia-systel-product-backup";
const STATE_KEY = "patagonia-systel-barcode-writes";

interface WriteState {
  signature: string;
  stage1?: { at: string; mode: TypeByteMode; number: number; unitNumber?: number };
  /** Reescritura de un producto de prueba (para ver si la balanza borra sus acumulados). */
  stage1b?: { at: string; number: number };
  stage2?: { at: string; number: number };
  bulk?: { at: string; done: number; stoppedAt: number | null };
}

export function loadProductBackup(): ProductBackup | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? (JSON.parse(raw) as ProductBackup) : null;
  } catch {
    return null;
  }
}
function loadState(): WriteState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as WriteState) : null;
  } catch {
    return null;
  }
}
function saveState(s: WriteState) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    // queda en soporte (report)
  }
}

export interface ProductBarcodePanelProps {
  busy: boolean;
  /** Productos de Patagonia con código de balanza (para saber qué números respaldar). */
  numbers: number[];
  /** Abre la conexión y devuelve el cliente y el formato de producto. Con write, el cliente puede escribir productos (61). */
  withReadClient: <T>(fn: (client: SystelClient, layout: SystelLayout) => Promise<T>, opts?: { write?: boolean }) => Promise<T | null>;
  /** Manda el resultado a soporte. */
  report: (step: string, detail: string) => void;
}

const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

export function SystelProductBarcodePanel(p: ProductBarcodePanelProps) {
  const [backup, setBackup] = useState<ProductBackup | null>(() => loadProductBackup());
  const [state, setState] = useState<WriteState | null>(() => loadState());
  const [note, setNote] = useState("");
  const [lastReport, setLastReport] = useState<WriteTestReport | null>(null);
  const [testPlu, setTestPlu] = useState("6");
  const [authorized, setAuthorized] = useState(false);
  const check = backup ? verifyBackup(backup) : null;
  const backupOk = !!backup && !!check?.ok && sameDay(backup.takenAt);

  async function handleBackup() {
    setNote("");
    const r = await p.withReadClient(async (client, layout) => {
      const sig = await client.signature();
      return { ...(await takeProductBackup(client, layout, p.numbers)), signature: sig ? JSON.stringify(sig) : "" };
    });
    if (!r) return;
    const v = verifyBackup(r.backup);
    const complete = p.numbers.length > 0 && r.missing.length === 0 && r.backup.records.length === p.numbers.length && v.ok;
    if (complete) {
      try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(r.backup));
      } catch {
        // se manda igual a soporte
      }
      setBackup(r.backup);
      // Otra balanza (otra firma): las pruebas hechas no valen para esta.
      if (!state || state.signature !== r.signature) {
        const fresh = { signature: r.signature };
        saveState(fresh);
        setState(fresh);
      }
    }
    const detail = `respaldo ${r.backup.records.length} de ${p.numbers.length} productos${r.missing.length ? `; NO se pudieron leer: ${r.missing.join(", ")}` : ""} · ${v.detail}`;
    setNote(complete ? `Respaldo completo y verificado: ${detail}.` : `Respaldo INCOMPLETO (no se guardó como válido): ${detail}.`);
    p.report("respaldo de productos (solo lectura)", `${detail}\n${JSON.stringify(r.backup)}`);
  }

  async function handleCompare() {
    if (!backup) return;
    setNote("");
    const states = await p.withReadClient(async (client) => compareWithBackup(client, backup));
    if (!states) return;
    const count = (s: string) => states.filter((x) => x.state === s).length;
    const text = `iguales al respaldo: ${count("igual")} · solo cambió el código: ${count("solo_codigo")} · con otra diferencia: ${count("otra_diferencia")} · sin leer: ${count("sin_lectura")}`;
    setNote(`Comparación (solo lectura): ${text}.`);
    p.report("comparar con el respaldo (solo lectura)", `${text}\n${JSON.stringify(states.filter((x) => x.state !== "igual"))}`);
  }

  /** Confirmación escrita, en cada paso que escribe. */
  function confirmWrite(what: string): boolean {
    if (!authorized) {
      setNote("Marcá primero que el dueño y el cliente autorizaron esta prueba.");
      return false;
    }
    const typed = window.prompt(`${what}\n\nSe escribe en la balanza. Antes se hizo el respaldo; si algo no coincide se restaura y se frena.\n\nEscribí AUTORIZO para seguir:`);
    if ((typed ?? "").trim().toUpperCase() !== "AUTORIZO") {
      setNote("No se escribió nada (falta la palabra AUTORIZO).");
      return false;
    }
    return true;
  }

  function finish(r: WriteTestReport, label: string, patch: Partial<WriteState>) {
    setLastReport(r);
    if (r.verdict === "confirmado" && state) {
      const next = { ...state, ...patch };
      saveState(next);
      setState(next);
    }
    setNote(`${label}: ${r.verdict === "confirmado" ? "CONFIRMADO" : r.verdict === "bloqueado" ? "bloqueado (no se escribió nada)" : "FRENADO"}.`);
    p.report(`${label} (escritura)`, JSON.stringify({ verdict: r.verdict, mode: r.mode, number: r.number, steps: r.steps, written: r.written, readBack: r.readBack, salesBefore: r.salesBefore, salesAfter: r.salesAfter }));
  }

  async function handleStage1() {
    if (!backup || !confirmWrite("Prueba 1: escribir un producto \"PRUEBA PATAGONIA\" (sin precio) en un número LIBRE de la balanza.")) return;
    // Moldes reales: un producto por peso y otro por unidad del respaldo (los productos de prueba se arman con su forma).
    const withEan = backup.records.filter((r) => pluEanSetting(r.raw).type !== null);
    const saleTypeOf = (raw: string) => parsePluAs(backup.layout, raw)?.saleType ?? "";
    const template = withEan.find((r) => saleTypeOf(r.raw) === "P")?.number ?? withEan[0]?.number;
    const unitTemplate = withEan.find((r) => saleTypeOf(r.raw) === "U")?.number;
    if (template === undefined) {
      setNote("El respaldo no tiene un producto de referencia con código de barras.");
      return;
    }
    const r = await p.withReadClient((client, layout) => runStage1FreeSlot(client, layout, { templateNumber: template, unitTemplateNumber: unitTemplate, protect: p.numbers, today: new Date() }), { write: true });
    // Los productos de prueba quedan en la lectura de esta computadora, para "Probar un código impreso".
    if (r?.verdict === "confirmado" && r.number !== null) {
      saveSystelPluBarcodes({
        [String(r.number)]: { type: 1, config: "20PPPPCCCCCC", p1: 1, p2: 0, name: "PRUEBA PATAGONIA", saleType: "P" },
        ...(r.unitNumber ? { [String(r.unitNumber)]: { type: 1, config: "21PPPPCCCCCC", p1: 1, p2: 0, name: "PRUEBA PATAGONIA", saleType: "U" } } : {})
      });
    }
    if (r) finish(r, "Prueba 1 (número libre)", r.mode && r.number !== null ? { stage1: { at: new Date().toISOString(), mode: r.mode, number: r.number, unitNumber: r.unitNumber } } : {});
  }

  async function handleStage1b() {
    if (!state?.stage1) return;
    const n = state.stage1.number;
    if (!confirmWrite(`Prueba 1b: reescribir el producto de prueba N.º ${n} (igual que se haría con uno real). Antes: vendé el producto de prueba en un ticket y anotá su total en el menú de la balanza (Totales por PLU); después de esto, mirá si el total sigue igual.`)) return;
    const mode = state.stage1.mode;
    const r = await p.withReadClient((client, layout) => runTestProductRewrite(client, layout, { number: n, mode, protect: p.numbers }), { write: true });
    if (r) finish(r, `Prueba 1b (reescritura del N.º ${n})`, { stage1b: { at: new Date().toISOString(), number: n } });
  }

  /**
   * REAL (Los gringos 14/10): con el tipo mandado como byte (0x01) la balanza lo guardó como 0xD1 y NO imprimió el
   * código debajo del producto. Se reescriben SOLO los productos de prueba con el tipo como dígito ("1", lo que dice el
   * documento) para imprimir otro ticket y comparar. Si queda bien, las pruebas 2 y 3 usan esa forma.
   */
  async function handleStage1c() {
    if (!state?.stage1) return;
    const nums = [state.stage1.number, ...(state.stage1.unitNumber ? [state.stage1.unitNumber] : [])];
    if (!confirmWrite(`Prueba 1c: reescribir los productos de prueba N.º ${nums.join(" y ")} con el tipo de código como dígito. No toca productos del cliente.`)) return;
    const reports: WriteTestReport[] = [];
    for (const n of nums) {
      const r = await p.withReadClient((client, layout) => runTestProductRewrite(client, layout, { number: n, mode: "ascii", protect: p.numbers }), { write: true });
      if (!r) return;
      reports.push(r);
      if (r.verdict !== "confirmado") break;
    }
    const ok = reports.length === nums.length && reports.every((r) => r.verdict === "confirmado");
    const merged: WriteTestReport = { ...reports[reports.length - 1], steps: reports.flatMap((r) => r.steps) };
    finish(merged, "Prueba 1c (productos de prueba, tipo como dígito)", ok && state.stage1 ? { stage1: { ...state.stage1, mode: "ascii" } } : {});
  }

  async function handleStage2() {
    const n = Number(testPlu);
    if (!state?.stage1) {
      setNote("Primero la prueba 1.");
      return;
    }
    if (!backup?.records.some((r) => r.number === n)) {
      setNote(`El producto ${testPlu} no está en el respaldo.`);
      return;
    }
    if (!confirmWrite(`Prueba 2: cambiar SOLO el código de barras del producto ${n} (tiene que no tener ventas en 40 días).`)) return;
    const mode = state.stage1.mode;
    const r = await p.withReadClient(async (client, layout) => {
      const plu = await client.readPlu(layout, n);
      return runStage2OneProduct(client, layout, { number: n, saleType: plu?.saleType ?? "", mode, protect: p.numbers, today: new Date() });
    }, { write: true });
    if (r) finish(r, `Prueba 2 (producto ${n})`, { stage2: { at: new Date().toISOString(), number: n } });
  }

  async function handleBulk() {
    if (!state?.stage1 || !state.stage2 || !backup) return;
    if (!confirmWrite(`Cambiar el código de barras de los ${p.numbers.length} productos (frena en el primero que no quede confirmado).`)) return;
    const mode = state.stage1.mode;
    const r = await p.withReadClient(async (client, layout) => {
      const items: { number: number; saleType: string }[] = [];
      for (const n of p.numbers) {
        const plu = await client.readPlu(layout, n);
        if (plu && targetCodeFor(plu.saleType)) items.push({ number: n, saleType: plu.saleType });
      }
      return rewriteAllProductBarcodes(client, layout, items, { mode });
    }, { write: true });
    if (!r) return;
    const done = r.results.filter((x) => x.ok).length;
    const next = { ...state, bulk: { at: new Date().toISOString(), done, stoppedAt: r.stoppedAt } };
    saveState(next);
    setState(next);
    setNote(r.stoppedAt === null ? `Listo: ${done} productos confirmados (incluye los que ya estaban).` : `FRENADO en el producto ${r.stoppedAt}: ${r.results.at(-1)?.detail ?? ""}. ${done} confirmados antes.`);
    p.report("código de todos los productos (escritura)", JSON.stringify({ done, stoppedAt: r.stoppedAt, results: r.results.map((x) => ({ number: x.number, verdict: x.verdict, detail: x.detail })) }));
  }

  async function handleRestore() {
    if (!backup || !confirmWrite("Restaurar desde el respaldo: los productos que difieran vuelven a como estaban.")) return;
    const mode = state?.stage1?.mode ?? "binario";
    const r = await p.withReadClient((client) => restoreFromBackup(client, backup, undefined, mode), { write: true });
    if (!r) return;
    const c = (v: string) => r.filter((x) => x.verdict === v).length;
    setNote(`Restauración: ${c("igual")} ya iguales · ${c("restaurado")} restaurados · ${c("no_restaurado")} NO restaurados · ${c("bloqueado")} bloqueados.`);
    p.report("restaurar desde el respaldo (escritura)", JSON.stringify(r));
  }

  const w = SYSTEL_PRODUCT_BARCODE_WRITE_ENABLED;
  return (
    <div className="panel" style={{ padding: 12, display: "grid", gap: 8 }}>
      <strong>Código de barras de cada producto</strong>
      <span className="muted" style={{ fontSize: 13 }}>
        Para que el ticket traiga, debajo de cada artículo, el código con el producto y sus kilos o unidades. Primero se hace un respaldo de todos los productos de la balanza (solo lectura).
      </span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="secondary" disabled={p.busy} onClick={() => void handleBackup()}>Respaldar los productos (solo lectura)</button>
        <button className="secondary" disabled={p.busy || !backup} onClick={() => void handleCompare()}>Comparar con el respaldo (solo lectura)</button>
      </div>
      {backup && check && (
        <span style={{ fontSize: 13 }} className={check.ok ? "" : "num-negative"}>
          Respaldo guardado {new Date(backup.takenAt).toLocaleString("es-AR")}: {check.detail}{check.ok ? "" : " (NO usar)"}{check.ok && !sameDay(backup.takenAt) ? " · es de otro día: hacé uno nuevo antes de escribir" : ""}
        </span>
      )}
      {!w ? (
        <span className="muted" style={{ fontSize: 12 }}>
          Cambiar el código en la balanza no está disponible en esta versión. Ningún botón de este recuadro cambia precios, productos ni ventas.
        </span>
      ) : (
        <div style={{ display: "grid", gap: 6, borderTop: "1px solid #ddd", paddingTop: 8 }}>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} /> El dueño y el cliente autorizaron esta prueba (el local está cerrado, sin tickets abiertos)
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button disabled={p.busy || !backupOk} onClick={() => void handleStage1()}>1. Probar en números libres</button>
            <span className="muted" style={{ fontSize: 12 }}>{state?.stage1 ? `✓ confirmada (N.º ${state.stage1.number} por peso${state.stage1.unitNumber ? ` y ${state.stage1.unitNumber} por unidad` : ""}, tipo ${state.stage1.mode})` : "Crea \"PRUEBA PATAGONIA\" ($1) por peso y por unidad en números que no existen."}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button className="secondary" disabled={p.busy || !state?.stage1} onClick={() => void handleStage1b()}>1b. Reescribir el producto de prueba</button>
            <button className="secondary" disabled={p.busy || !state?.stage1} onClick={() => void handleStage1c()}>1c. Productos de prueba con el tipo como dígito</button>
            <span className="muted" style={{ fontSize: 12 }}>{state?.stage1b ? "✓ hecha: compará el total del producto de prueba en la balanza antes y después" : "Para saber si la balanza borra los acumulados al escribir, sin tocar productos reales."}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label className="muted" style={{ fontSize: 13 }}>
              Producto N.º <input value={testPlu} onChange={(e) => setTestPlu(e.target.value.replace(/\D/g, ""))} style={{ width: 70 }} />
            </label>
            <button disabled={p.busy || !backupOk || !state?.stage1} onClick={() => void handleStage2()}>2. Probar en este producto</button>
            <span className="muted" style={{ fontSize: 12 }}>{state?.stage2 ? `✓ confirmada (producto ${state.stage2.number})` : "Solo después de la 1. Tiene que ser un producto sin ventas en 40 días."}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button disabled={p.busy || !backupOk || !state?.stage2} onClick={() => void handleBulk()}>3. Todos los productos</button>
            <span className="muted" style={{ fontSize: 12 }}>{state?.bulk ? `${state.bulk.done} confirmados${state.bulk.stoppedAt !== null ? `, frenó en el ${state.bulk.stoppedAt}` : ""}` : "Solo después de la 2."}</span>
          </div>
          <div>
            <button className="secondary" disabled={p.busy || !backup || !check?.ok} onClick={() => void handleRestore()}>Restaurar desde el respaldo</button>
          </div>
        </div>
      )}
      {lastReport && (
        <div style={{ fontSize: 12, display: "grid", gap: 2 }}>
          {lastReport.steps.map((s, i) => <span key={i}>{s.ok ? "✓" : "✗"} {s.label}: {s.detail}</span>)}
        </div>
      )}
      {note && <span style={{ fontSize: 13 }}>{note}</span>}
    </div>
  );
}
