import { useEffect, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { useBoxLabelFormats } from "../sale/box-label-service";
import { cachedScaleConfig, scaleConfigLoaded } from "../sale/scale-config-cache";
import { DEFAULT_SCALE_CONFIG, getBranchScaleConfig, type ScaleConfig } from "../sale/scale-config-service";
import { quantityNumber } from "../sale/quantity";
import { findEnteredCodes, listStockEntries, registerStockEntry, undoStockEntry, type StockEntrySummary } from "./inventory-service";
import { countsAsBox, entryTotals, fmtKg, fmtQty, resolveEntryScan, type EntryLine } from "./stock-entry";

// Ingreso de stock por escaneo (migración 204, pedido de Carplat 18/11/2026): una sola pantalla para todo lo que llega.
// Cada caja escaneada es un renglón con su producto y sus kilos; al final "Ingresar stock" entra todo junto.

const DRAFT_KEY = (branchId: string) => `patagonia-stock-entry-draft-${branchId}`;

function loadDraft(branchId: string): EntryLine[] {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(branchId));
    return raw ? (JSON.parse(raw) as EntryLine[]) : [];
  } catch {
    return [];
  }
}

function saveDraft(branchId: string, lines: EntryLine[]) {
  try {
    if (lines.length === 0) localStorage.removeItem(DRAFT_KEY(branchId));
    else localStorage.setItem(DRAFT_KEY(branchId), JSON.stringify(lines));
  } catch {
    // sin almacenamiento: la lista vive mientras la pantalla esté abierta
  }
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit" });

export function StockEntry({ products, branchId, boxLabels, packages, boxWord, canUndo, onClose, onDone }: {
  products: Product[];
  branchId: string;
  boxLabels: boolean;
  /** Pantalla "Paquetes": cada renglón por kilo suma 1 caja/paquete. */
  packages: boolean;
  boxWord: "unidad" | "paquete";
  canUndo: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { formats } = useBoxLabelFormats(boxLabels);
  const [scaleConfig, setScaleConfig] = useState<ScaleConfig>(() => cachedScaleConfig(branchId)?.config ?? DEFAULT_SCALE_CONFIG);
  const [lines, setLines] = useState<EntryLine[]>(() => loadDraft(branchId));
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Product | null>(null);
  const [qty, setQty] = useState("");
  const [matches, setMatches] = useState<Product[]>([]);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<StockEntrySummary[]>([]);
  const codeRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const keySeq = useRef(0);
  const boxes = boxWord === "unidad" ? "unidades" : "paquetes";

  useEffect(() => {
    void getBranchScaleConfig(branchId)
      .then((c) => setScaleConfig(scaleConfigLoaded(branchId, c).config))
      .catch(() => undefined);
    void listStockEntries(branchId).then(setRecent);
    codeRef.current?.focus();
  }, [branchId]);

  useEffect(() => saveDraft(branchId, lines), [branchId, lines]);

  // Elegido el producto, el cursor va a los kilos (el campo recién aparece en este render).
  useEffect(() => {
    if (pending) qtyRef.current?.focus();
  }, [pending]);

  function addLine(line: Omit<EntryLine, "key">, detail: string) {
    if (line.code && lines.some((l) => l.code === line.code)) {
      setMessage(`Esa ${boxWord} ya está en la lista (${detail}). No se agregó de nuevo.`);
      return;
    }
    keySeq.current += 1;
    setLines((cur) => [{ ...line, key: `${Date.now()}-${keySeq.current}` }, ...cur]);
    setMessage(`Agregado: ${detail}.`);
  }

  function pick(product: Product) {
    setPending(product);
    setMatches([]);
    setCode("");
    setQty("");
    setMessage(`${product.name}: escribí ${product.unit === "kg" ? "los kilos" : "cuántas unidades"} y Enter.`);
  }

  function onCodeEnter() {
    const raw = code.trim();
    if (!raw) return;
    const r = resolveEntryScan(raw, products, formats, scaleConfig, packages);
    if (r.type === "line") {
      addLine(r.line, r.detail);
      setCode("");
      setMatches([]);
      setPending(null);
    } else if (r.type === "product") {
      pick(r.product);
    } else if (r.type === "error") {
      setMessage(r.message);
      setCode("");
    } else if (r.matches.length === 1) {
      pick(r.matches[0]);
    } else {
      setMatches(r.matches);
      setMessage(r.matches.length === 0 ? `No hay ningún producto "${raw}".` : "Elegí el producto:");
    }
    if (r.type !== "product" && !(r.type === "search" && r.matches.length === 1)) codeRef.current?.focus();
  }

  function onQtyEnter() {
    if (!pending) return;
    const n = quantityNumber(qty);
    if (!(n > 0) || n > 2000 || (pending.unit !== "kg" && !Number.isInteger(n))) {
      setMessage(pending.unit === "kg" ? "Escribí los kilos (por ejemplo 20,44)." : "Escribí una cantidad entera de unidades.");
      return;
    }
    const quantity = Math.round(n * 1000) / 1000;
    addLine(
      { productId: pending.id, name: pending.name, unit: pending.unit, quantity, code: "", box: countsAsBox(pending.unit, packages) },
      `${pending.name}: ${fmtQty(quantity, pending.unit)}`
    );
    setPending(null);
    setQty("");
    codeRef.current?.focus();
  }

  async function submit() {
    if (lines.length === 0 || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const seen = await findEnteredCodes(lines.map((l) => l.code));
      const repeated = lines.filter((l) => seen[l.code]);
      if (repeated.length > 0) {
        const list = repeated.slice(0, 5).map((l) => `• ${l.name} ${fmtQty(l.quantity, l.unit)} (entró el ${when(seen[l.code])})`).join("\n");
        if (!window.confirm(`${repeated.length === 1 ? `Esta ${boxWord} ya había entrado` : `Estas ${repeated.length} ${boxes} ya habían entrado`}:\n${list}\n\n¿Ingresar igual? (Si es la misma ${boxWord} escaneada de nuevo, tocá Cancelar y quitala de la lista.)`)) {
          setBusy(false);
          return;
        }
      }
      const r = await registerStockEntry(branchId, lines.map((l) => ({ productId: l.productId, quantity: l.quantity, code: l.code, box: l.box })), note);
      setLines([]);
      setNote("");
      const msg = `Ingreso cargado: ${r.lines} ${r.lines === 1 ? "renglón" : "renglones"}${r.kg > 0 ? `, ${fmtKg(r.kg)}` : ""}${r.boxes > 0 ? `, ${r.boxes} ${r.boxes === 1 ? boxWord : boxes}` : ""}.`;
      setMessage(msg);
      setRecent(await listStockEntries(branchId));
      onDone(msg);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo ingresar el stock.");
    } finally {
      setBusy(false);
      codeRef.current?.focus();
    }
  }

  async function undo(entry: StockEntrySummary) {
    if (!window.confirm(`¿Deshacer el ingreso del ${when(entry.createdAt)} (${fmtKg(entry.kg)}${entry.boxes ? `, ${entry.boxes} ${boxes}` : ""})? Se restan esos kilos y ${boxes} del stock.`)) return;
    try {
      await undoStockEntry(entry.id);
      setRecent(await listStockEntries(branchId));
      onDone("Ingreso deshecho.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo deshacer.");
    }
  }

  const totals = entryTotals(lines);

  return (
    <section className="panel form-box stock-entry">
      <div className="row-actions" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Ingreso de stock</h2>
        <button className="secondary" onClick={onClose}>Cerrar</button>
      </div>
      <p className="muted">
        Escaneá cada {boxWord} que llegó: el sistema reconoce el producto y los kilos{packages ? ` y cuenta 1 ${boxWord} por escaneo` : ""}. También podés escribir el código o el nombre de un producto y después los kilos. Cuando termines, tocá <strong>Ingresar stock</strong>.
      </p>

      <div className="form-grid">
        <label>
          Escaneá o escribí el código
          <input
            ref={codeRef}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCodeEnter();
              }
            }}
            placeholder="Código de barras, código o nombre"
            autoComplete="off"
          />
        </label>
        {pending && (
          <label>
            {pending.name}: {pending.unit === "kg" ? "kilos" : "unidades"}
            <input
              ref={qtyRef}
              type="text"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onQtyEnter();
                }
                if (e.key === "Escape") {
                  setPending(null);
                  codeRef.current?.focus();
                }
              }}
              placeholder={pending.unit === "kg" ? "20,44" : "1"}
            />
          </label>
        )}
      </div>

      {matches.length > 0 && (
        <div className="row-actions" style={{ flexWrap: "wrap" }}>
          {matches.map((p) => (
            <button key={p.id} className="secondary" onClick={() => pick(p)}>{p.code} · {p.name}</button>
          ))}
        </div>
      )}

      {message && <div className="message">{message}</div>}

      {lines.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Código</th>
                  <th>Producto</th>
                  <th style={{ textAlign: "right" }}>Peso / cantidad</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key}>
                    <td>{lines.length - i}</td>
                    <td className="cell-sub">{l.code || "a mano"}</td>
                    <td>{l.name}{l.box ? <span className="badge" style={{ marginLeft: 6 }}>{boxWord}</span> : null}</td>
                    <td style={{ textAlign: "right" }}>{fmtQty(l.quantity, l.unit)}</td>
                    <td><button className="link-button" onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}>Quitar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-scroll">
            <table className="data-table no-stack">
              <thead>
                <tr><th>Resumen</th><th style={{ textAlign: "right" }}>Entra</th>{packages && <th style={{ textAlign: "right" }}>{boxes}</th>}</tr>
              </thead>
              <tbody>
                {totals.byProduct.map((r) => (
                  <tr key={r.productId}>
                    <td>{r.name}</td>
                    <td style={{ textAlign: "right" }}>{fmtQty(r.quantity, r.unit)}</td>
                    {packages && <td style={{ textAlign: "right" }}>{r.boxes || "—"}</td>}
                  </tr>
                ))}
                <tr>
                  <td><strong>Total</strong></td>
                  <td style={{ textAlign: "right" }}><strong>{fmtKg(totals.kg)}</strong></td>
                  {packages && <td style={{ textAlign: "right" }}><strong>{totals.boxes}</strong></td>}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="form-actions">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota (opcional): remito, proveedor…" maxLength={120} style={{ flex: 1, minWidth: 0 }} />
            <button className="secondary" disabled={busy} onClick={() => window.confirm("¿Vaciar la lista? No se ingresa nada.") && setLines([])}>Vaciar</button>
            <button disabled={busy} onClick={() => void submit()}>{busy ? "Ingresando…" : `Ingresar stock (${totals.lines})`}</button>
          </div>
        </>
      )}

      {recent.length > 0 && (
        <details>
          <summary>Últimos ingresos</summary>
          <ul>
            {recent.map((e) => (
              <li key={e.id}>
                {when(e.createdAt)} · {fmtKg(e.kg)}{e.boxes ? ` · ${e.boxes} ${boxes}` : ""} · {e.lines} renglones{e.note ? ` · ${e.note}` : ""}
                {e.undone ? <span className="badge" style={{ marginLeft: 6 }}>deshecho</span> : canUndo ? <> · <button className="link-button" onClick={() => void undo(e)}>Deshacer</button></> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
