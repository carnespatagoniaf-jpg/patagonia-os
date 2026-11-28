import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { useAuth } from "../auth/AuthProvider";
import { useScaleLabelProfiles } from "../scales/useScaleLabelProfiles";
import { SCALE_CONFIG_UNKNOWN } from "../sale/scale-config-cache";
import { useActiveBranch } from "../branches/BranchProvider";
import { isSupabaseConfigured } from "../../lib/supabase";
import { demoProducts } from "../../lib/demo-data";
import { listProductsForBranch } from "../inventory/inventory-service";
import { fmtKg, fmtQty, resolveEntryScan } from "../inventory/stock-entry";
import { useBoxLabelFormats } from "../sale/box-label-service";
import { quantityNumber } from "../sale/quantity";
import { cachedScaleConfig, scaleConfigLoaded } from "../sale/scale-config-cache";
import { DEFAULT_SCALE_CONFIG, getBranchScaleConfig, type ScaleConfig } from "../sale/scale-config-service";
import { FREEZER_OLD_DAYS, TAKE_OUT_REASONS, daysStored, daysText, sameCodeStored, summarizeFreezer, type FreezerPackage } from "./freezer-logic";
import { listFreezer, putBackInFreezer, storeInFreezer, takeOutOfFreezer } from "./freezer-service";

// Freezer (migración 214, pantalla a pedido 'freezer'): qué hay guardado en el freezer del local. Se guarda escaneando
// la etiqueta de la balanza que se pegó en la bolsa; al venderla en Mostrador (escaneando esa misma etiqueta) sale sola.
// Guardar no mueve stock: el freezer dice dónde está la mercadería.

interface DraftLine {
  key: string;
  productId: string;
  name: string;
  unit: Product["unit"];
  quantity: number;
  code: string;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
const dayOnly = (iso: string) => new Date(iso).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "2-digit" });
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : (err as { message?: string })?.message ?? fallback);

export function Freezer() {
  const { branchId } = useActiveBranch();
  const { profile } = useAuth();
  const boxLabels = Boolean(profile?.features?.includes("etiquetas_caja"));
  const { formats } = useBoxLabelFormats(boxLabels);
  const [products, setProducts] = useState<Product[]>([]);
  const [packages, setPackages] = useState<FreezerPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [scaleConfig, setScaleConfig] = useState<ScaleConfig>(() => (branchId ? cachedScaleConfig(branchId)?.config : undefined) ?? SCALE_CONFIG_UNKNOWN);
  const labelProfiles = useScaleLabelProfiles(branchId ?? null, Boolean(profile?.features?.includes("balanzas_v2")));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Guardar
  const [showStore, setShowStore] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Product | null>(null);
  const [qty, setQty] = useState("");
  const [matches, setMatches] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const keySeq = useRef(0);

  // Ver y sacar
  const [openProduct, setOpenProduct] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<string>(TAKE_OUT_REASONS[0]);
  const [otherReason, setOtherReason] = useState("");

  const reload = useCallback(async () => {
    if (!branchId) return;
    setPackages(await listFreezer(branchId));
  }, [branchId]);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([isSupabaseConfigured ? listProductsForBranch(branchId) : Promise.resolve(demoProducts), listFreezer(branchId)])
      .then(([p, f]) => {
        if (cancelled) return;
        setProducts(p);
        setPackages(f);
      })
      .catch((err) => !cancelled && setError(errorText(err, "No se pudo leer el freezer.")))
      .finally(() => !cancelled && setLoading(false));
    void getBranchScaleConfig(branchId)
      .then((c) => !cancelled && setScaleConfig(scaleConfigLoaded(branchId, c).config))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  useEffect(() => {
    if (pending) qtyRef.current?.focus();
  }, [pending]);
  useEffect(() => {
    if (showStore) codeRef.current?.focus();
  }, [showStore]);

  const activeProducts = useMemo(() => products.filter((p) => p.active !== false), [products]);
  const summary = useMemo(() => summarizeFreezer(packages, products), [packages, products]);
  const recentOut = useMemo(
    () => packages.filter((p) => p.status !== "guardado" && p.outAt).sort((a, b) => (b.outAt ?? "").localeCompare(a.outAt ?? "")).slice(0, 40),
    [packages]
  );
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? "Producto borrado";
  const unitOf = (id: string) => products.find((p) => p.id === id)?.unit ?? "kg";

  function addLine(line: Omit<DraftLine, "key">, detail: string) {
    if (line.code) {
      const inDraft = lines.filter((l) => l.code === line.code).length;
      const inFreezer = sameCodeStored(line.code, packages);
      if ((inDraft > 0 || inFreezer > 0) && !window.confirm(
        `Ya hay ${inDraft + inFreezer === 1 ? "una bolsa" : `${inDraft + inFreezer} bolsas`} con esta misma etiqueta (${detail})${inFreezer > 0 ? " en el freezer" : " en la lista"}.\n\n¿Es OTRA bolsa del mismo peso? Si escaneaste la misma bolsa dos veces, tocá Cancelar.`
      )) {
        setMessage("No se agregó.");
        return;
      }
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
    setMessage(`${product.name}: escribí ${product.unit === "kg" ? "los kilos" : "cuántas unidades"} de la bolsa y Enter.`);
  }

  function onCodeEnter() {
    const raw = code.trim();
    if (!raw) return;
    const r = resolveEntryScan(raw, activeProducts, formats, scaleConfig, false, labelProfiles);
    if (r.type === "line") {
      addLine({ productId: r.line.productId, name: r.line.name, unit: r.line.unit, quantity: r.line.quantity, code: r.line.code }, r.detail);
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
    if (!(n > 0) || n > 500 || (pending.unit !== "kg" && !Number.isInteger(n))) {
      setMessage(pending.unit === "kg" ? "Escribí los kilos (por ejemplo 1,850)." : "Escribí una cantidad entera de unidades.");
      return;
    }
    const quantity = Math.round(n * 1000) / 1000;
    addLine({ productId: pending.id, name: pending.name, unit: pending.unit, quantity, code: "" }, `${pending.name}: ${fmtQty(quantity, pending.unit)}`);
    setPending(null);
    setQty("");
    codeRef.current?.focus();
  }

  async function store() {
    if (!branchId || lines.length === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await storeInFreezer(branchId, lines.map((l) => ({ productId: l.productId, quantity: l.quantity, code: l.code })));
      setLines([]);
      setShowStore(false);
      setMessage(`Guardado en el freezer: ${r.packages} ${r.packages === 1 ? "bolsa" : "bolsas"}${r.kg > 0 ? `, ${fmtKg(r.kg)}` : ""}.`);
      await reload();
    } catch (err) {
      setError(errorText(err, "No se pudo guardar."));
    } finally {
      setBusy(false);
    }
  }

  async function takeOut() {
    const ids = [...selected];
    const why = reason === "Otro" ? otherReason.trim() : reason;
    if (ids.length === 0) return;
    if (!why) {
      setError("Escribí por qué sale del freezer.");
      return;
    }
    if (!window.confirm(`¿Sacar ${ids.length === 1 ? "esta bolsa" : `estas ${ids.length} bolsas`} del freezer (${why})? El stock no cambia: si se tiró o se usó, ajustalo en Stock.`)) return;
    setBusy(true);
    setError("");
    try {
      const n = await takeOutOfFreezer(ids, why);
      setSelected(new Set());
      setMessage(`${n === 1 ? "Salió 1 bolsa" : `Salieron ${n} bolsas`} del freezer (${why}).`);
      await reload();
    } catch (err) {
      setError(errorText(err, "No se pudo sacar."));
    } finally {
      setBusy(false);
    }
  }

  async function putBack(pkg: FreezerPackage) {
    if (!window.confirm(`¿Volver a guardar ${productName(pkg.productId)} ${fmtQty(pkg.quantity, unitOf(pkg.productId))} en el freezer?`)) return;
    try {
      await putBackInFreezer(pkg.id);
      setMessage("Volvió al freezer.");
      await reload();
    } catch (err) {
      setError(errorText(err, "No se pudo volver a guardar."));
    }
  }

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!branchId) return <section className="panel">Elegí un local arriba para ver su freezer.</section>;

  const draftKg = Math.round(lines.reduce((s, l) => s + (l.unit === "kg" ? l.quantity : 0), 0) * 1000) / 1000;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">STOCK</p>
          <h1>Freezer</h1>
          <p className="muted">Lo que está guardado en el freezer de este local. Al venderlo en Mostrador escaneando su etiqueta, sale solo.</p>
        </div>
        {!showStore && <button onClick={() => setShowStore(true)}>+ Guardar en el freezer</button>}
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      {showStore && (
        <section className="panel form-box">
          <div className="row-actions" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Guardar en el freezer</h2>
            <button className="secondary" onClick={() => setShowStore(false)}>Cerrar</button>
          </div>
          <p className="muted">
            Pesá cada bolsa en la balanza como siempre, pegale la etiqueta y escaneala acá: el sistema reconoce el producto y los kilos. Si no tiene etiqueta, escribí el producto y después los kilos (esa bolsa se saca a mano). Cuando termines, tocá <strong>Guardar</strong>.
          </p>
          <div className="form-grid">
            <label style={{ gridColumn: "1 / -1", maxWidth: 520 }}>
              Escaneá la etiqueta o escribí el producto
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
                placeholder="Etiqueta de la balanza, código o nombre"
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
                  placeholder={pending.unit === "kg" ? "1,850" : "1"}
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
          {lines.length > 0 && (
            <>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr><th>#</th><th>Producto</th><th style={{ textAlign: "right" }}>Peso / cantidad</th><th>Etiqueta</th><th></th></tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.key}>
                        <td>{lines.length - i}</td>
                        <td>{l.name}</td>
                        <td style={{ textAlign: "right" }}>{fmtQty(l.quantity, l.unit)}</td>
                        <td className="cell-sub">{l.code || "a mano"}</td>
                        <td><button className="link-button" onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}>Quitar</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <span className="muted" style={{ flex: 1 }}>{lines.length} {lines.length === 1 ? "bolsa" : "bolsas"}{draftKg > 0 ? ` · ${fmtKg(draftKg)}` : ""}</span>
                <button className="secondary" disabled={busy} onClick={() => window.confirm("¿Vaciar la lista? No se guarda nada.") && setLines([])}>Vaciar</button>
                <button disabled={busy} onClick={() => void store()}>{busy ? "Guardando…" : `Guardar (${lines.length})`}</button>
              </div>
            </>
          )}
        </section>
      )}

      <div className="ws-cards ws-cards-4">
        <div className="ws-card"><span>Bolsas guardadas</span><strong>{summary.packages}</strong></div>
        <div className="ws-card"><span>Kilos en el freezer</span><strong>{fmtKg(summary.kg)}</strong></div>
        <div className="ws-card"><span>Productos</span><strong>{summary.rows.length}</strong></div>
        <div className="ws-card"><span>Más de {FREEZER_OLD_DAYS} días</span><strong style={summary.old > 0 ? { color: "var(--warn)" } : undefined}>{summary.old}</strong></div>
      </div>

      <section className="panel">
        <h2>Qué hay en el freezer</h2>
        {loading ? (
          <p className="muted">Cargando…</p>
        ) : summary.rows.length === 0 ? (
          <p className="muted">El freezer está vacío. Tocá <strong>+ Guardar en el freezer</strong> y escaneá la etiqueta de cada bolsa.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Producto</th><th style={{ textAlign: "right" }}>Bolsas</th><th style={{ textAlign: "right" }}>Kilos / cantidad</th><th>La más vieja</th><th></th></tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => (
                  <Fragment key={r.productId}>
                    <tr className={`row-clickable${openProduct === r.productId ? " row-selected" : ""}`} onClick={() => setOpenProduct(openProduct === r.productId ? null : r.productId)}>
                      <td>{r.name}</td>
                      <td style={{ textAlign: "right" }}>{r.count}</td>
                      <td style={{ textAlign: "right" }}>{fmtQty(r.quantity, r.unit)}</td>
                      <td>{r.oldestDays >= FREEZER_OLD_DAYS ? <span className="badge warn">{daysText(r.oldestDays)}: venderla primero</span> : daysText(r.oldestDays)}</td>
                      <td><button className="link-button">{openProduct === r.productId ? "Cerrar" : "Ver bolsas"}</button></td>
                    </tr>
                    {openProduct === r.productId && (
                      <tr className="row-editor">
                        <td colSpan={5}>
                          <table className="data-table no-stack">
                            <thead>
                              <tr><th></th><th>Guardada</th><th style={{ textAlign: "right" }}>Peso / cantidad</th><th>Etiqueta</th></tr>
                            </thead>
                            <tbody>
                              {r.packages.map((p) => (
                                <tr key={p.id}>
                                  <td><input type="checkbox" aria-label="Elegir para sacar" checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
                                  <td>{dayOnly(p.storedAt)} <span className="cell-sub">({daysText(daysStored(p.storedAt))})</span></td>
                                  <td style={{ textAlign: "right" }}>{fmtQty(p.quantity, r.unit)}</td>
                                  <td className="cell-sub">{p.code ?? "a mano (se saca a mano)"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selected.size > 0 && (
          <div className="form-actions" style={{ flexWrap: "wrap" }}>
            <span style={{ flex: 1 }}>{selected.size === 1 ? "1 bolsa elegida" : `${selected.size} bolsas elegidas`}. Lo que se vende en Mostrador sale solo; esto es para lo que sale por otro motivo.</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {TAKE_OUT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              <option value="Otro">Otro…</option>
            </select>
            {reason === "Otro" && <input value={otherReason} onChange={(e) => setOtherReason(e.target.value)} placeholder="¿Por qué sale?" maxLength={120} />}
            <button className="secondary" onClick={() => setSelected(new Set())}>Cancelar</button>
            <button disabled={busy} onClick={() => void takeOut()}>Sacar del freezer</button>
          </div>
        )}
      </section>

      {recentOut.length > 0 && (
        <section className="panel">
          <details>
            <summary>Lo último que salió (30 días)</summary>
            <ul>
              {recentOut.map((p) => (
                <li key={p.id}>
                  {when(p.outAt ?? p.storedAt)} · {productName(p.productId)} {fmtQty(p.quantity, unitOf(p.productId))} ·{" "}
                  {p.status === "vendido" ? "vendida en Mostrador" : `sacada: ${p.outReason ?? ""}`}
                  {p.status === "sacado" && <> · <button className="link-button" onClick={() => void putBack(p)}>Volver a guardar</button></>}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </>
  );
}

export default Freezer;
