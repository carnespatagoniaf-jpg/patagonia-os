import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";
import { formatMoney } from "../shifts/format";
import { listProductsForBranch } from "../inventory/inventory-service";
import { useRemitoREnabled } from "../invoicing/RemitoRButton";
import { parseQuantity } from "../sale/quantity";
import { ProductSearch, type PickableProduct } from "./ProductSearch";
import { TransferPrint, TransferRemitoPrint } from "./TransferPaper";
import { STATUS_LABELS, formatQty, prepLinesFrom, qtyTotals, totalsLabel, whenLabel, type PrepLine, type Transfer } from "./transfer-logic";
import { cancelTransfer, dispatchTransfer, prepareTransfer, type PrepareInput } from "./transfers-service";
import type { TransfersContext } from "./Transfers";

// Paso 2: el local que manda (la Planta) ve los pedidos, ajusta lo que manda y lo despacha con su remito.

const NEW = "nuevo";
const addressKey = (branchId: string) => `patagonia-transfer-address-${branchId}`;

function readAddress(branchId: string): string {
  try {
    return window.localStorage.getItem(addressKey(branchId)) ?? "";
  } catch {
    return "";
  }
}

export function PrepareTab({ ctx }: { ctx: TransfersContext }) {
  const { profile } = useAuth();
  const remitoREnabled = useRemitoREnabled(planAllows(profile, "full"));
  const pending = useMemo(
    () =>
      ctx.transfers
        .filter((t) => t.fromBranchId === ctx.activeBranchId && (t.status === "pedido" || t.status === "preparando"))
        .sort((a, b) => (a.neededBy ?? "9999").localeCompare(b.neededBy ?? "9999") || a.number - b.number),
    [ctx.transfers, ctx.activeBranchId]
  );
  const [selectedId, setSelectedId] = useState<string | null>(pending[0]?.id ?? null);
  const selected = selectedId === NEW ? null : pending.find((t) => t.id === selectedId) ?? null;
  // El remito se imprime acá: al despachar, el envío deja de estar en esta lista y el formulario se cierra.
  const [printing, setPrinting] = useState<Transfer | null>(null);
  const [printError, setPrintError] = useState("");

  // Stock y costo del local que manda.
  const [stock, setStock] = useState<Map<string, { stock: number; cost: number }>>(new Map());
  const [catalog, setCatalog] = useState<PickableProduct[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listProductsForBranch(ctx.activeBranchId)
      .then((products) => {
        if (cancelled) return;
        const own = products.filter((p) => (p.active ?? true) && !p.stockSourceId);
        setStock(new Map(own.map((p) => [p.id, { stock: p.stock, cost: p.cost }])));
        setCatalog(own.map((p) => ({ id: p.id, name: p.name, code: p.code, unit: p.unit, stock: p.stock })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ctx.activeBranchId, ctx.transfers]);

  useEffect(() => {
    if (selectedId !== NEW && !pending.some((t) => t.id === selectedId)) setSelectedId(pending[0]?.id ?? null);
  }, [pending, selectedId]);

  return (
    <div className="ws-layout">
      <section className="ws-list panel">
        <div className="panel-title">
          <h2>Para preparar</h2>
        </div>
        <div className="ws-list-items">
          {pending.length === 0 && <p className="muted">No hay pedidos para {ctx.branchName(ctx.activeBranchId)}.</p>}
          {pending.map((t) => {
            const totals = qtyTotals(t.items.map((i) => ({ unit: i.unit, qty: i.requested ?? i.sent ?? 0 })));
            return (
              <button key={t.id} type="button" className={`ws-item${t.id === selectedId ? " active" : ""}`} onClick={() => setSelectedId(t.id)}>
                <span className="ws-item-main">
                  <b>{ctx.branchName(t.toBranchId)}</b>
                  <small>
                    N.º {t.number} · {totals.products} productos · {totalsLabel(totals)}
                  </small>
                  <small>
                    {t.neededBy ? `para el ${t.neededBy.split("-").reverse().slice(0, 2).join("/")} · ` : ""}
                    {t.requestedAt ? `pidió ${whenLabel(t.requestedAt, new Date())}` : "sin pedido"}
                  </small>
                </span>
                <span className="ws-item-side">
                  <span className={`badge${t.status === "pedido" ? " warn" : ""}`}>{STATUS_LABELS[t.status]}</span>
                </span>
              </button>
            );
          })}
        </div>
        <button type="button" className="secondary transfers-new" onClick={() => setSelectedId(NEW)}>
          + Envío sin pedido
        </button>
      </section>

      {selectedId === NEW ? (
        <PrepareForm key={NEW} ctx={ctx} transfer={null} stock={stock} catalog={catalog} remitoREnabled={remitoREnabled} onDone={() => setSelectedId(null)} onDispatched={setPrinting} />
      ) : selected ? (
        <PrepareForm key={selected.id} ctx={ctx} transfer={selected} stock={stock} catalog={catalog} remitoREnabled={remitoREnabled} onDone={() => setSelectedId(null)} onDispatched={setPrinting} />
      ) : (
        <section className="ws-main panel">
          {printError && <div className="message warning">{printError}</div>}
          <p className="muted">Elegí un pedido de la lista, o armá un envío sin pedido.</p>
        </section>
      )}
      {printing && (
        <TransferRemitoPrint
          transfer={printing}
          branchName={ctx.branchName}
          showCost={printing.showCost}
          onDone={() => setPrinting(null)}
          onError={(text) => {
            setPrinting(null);
            setPrintError(`${text} Lo podés reimprimir desde "En viaje".`);
          }}
        />
      )}
    </div>
  );
}

function PrepareForm({
  ctx,
  transfer,
  stock,
  catalog,
  remitoREnabled,
  onDone,
  onDispatched
}: {
  ctx: TransfersContext;
  transfer: Transfer | null;
  stock: Map<string, { stock: number; cost: number }>;
  catalog: PickableProduct[];
  remitoREnabled: boolean;
  onDone: () => void;
  onDispatched: (t: Transfer) => void;
}) {
  const others = ctx.branches.filter((b) => b.id !== ctx.activeBranchId);
  const [toId, setToId] = useState(transfer?.toBranchId ?? "");
  const [lines, setLines] = useState<PrepLine[]>(() => (transfer ? prepLinesFrom(transfer) : []));
  const [carrier, setCarrier] = useState(transfer?.carrier ?? "");
  const [vehicle, setVehicle] = useState(transfer?.vehicle ?? "");
  const [notes, setNotes] = useState("");
  const [useRemitoR, setUseRemitoR] = useState(remitoREnabled);
  const [address, setAddress] = useState(() => readAddress(transfer?.toBranchId ?? ""));
  const [showCost, setShowCost] = useState(ctx.seesCost);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [printList, setPrintList] = useState(false);

  useEffect(() => setUseRemitoR(remitoREnabled), [remitoREnabled]);

  const parsed = lines.map((l) => ({ ...l, n: parseQuantity(l.send) }));
  const totals = qtyTotals(parsed.map((l) => ({ unit: l.unit, qty: Number.isFinite(l.n) ? l.n : 0, unitCost: stock.get(l.productId)?.cost ?? 0 })));
  const inList = useMemo(() => new Set(lines.map((l) => l.productId)), [lines]);
  const short = parsed.filter((l) => Number.isFinite(l.n) && l.n > (stock.get(l.productId)?.stock ?? 0));

  function input(): PrepareInput | null {
    setError("");
    if (!transfer && !toId) {
      setError("Elegí a qué local va.");
      return null;
    }
    const bad = parsed.find((l) => l.send.trim() !== "" && (!Number.isFinite(l.n) || l.n < 0));
    if (bad) {
      setError(`Revisá la cantidad de ${bad.name}.`);
      return null;
    }
    return {
      id: transfer?.id ?? null,
      fromBranchId: transfer ? null : ctx.activeBranchId,
      toBranchId: transfer ? null : toId,
      lines: parsed.map((l) => ({ productId: l.productId, quantity: Number.isFinite(l.n) ? l.n : 0 })),
      carrier,
      vehicle,
      notes
    };
  }

  async function save() {
    const data = input();
    if (!data) return;
    setBusy(true);
    try {
      await prepareTransfer(data);
      ctx.notify("Guardado. Lo podés seguir preparando después.");
      await ctx.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  async function dispatch() {
    const data = input();
    if (!data) return;
    if (totals.products === 0) return setError("No hay nada para mandar: poné la cantidad de al menos un producto.");
    const dest = transfer?.toBranchId ?? toId;
    if (useRemitoR && !address.trim()) return setError(`Para el Remito R poné el domicilio de ${ctx.branchName(dest)}.`);
    if (short.length > 0 && !window.confirm(`En ${ctx.branchName(ctx.activeBranchId)} no alcanza el stock de ${short.map((l) => l.name).join(", ")}: va a quedar en negativo. ¿Despachar igual?`)) return;
    setBusy(true);
    try {
      const r = await dispatchTransfer({ ...data, remitoR: useRemitoR, showCost: ctx.seesCost && showCost, deliveryAddress: address });
      if (useRemitoR) {
        try {
          window.localStorage.setItem(addressKey(dest), address.trim());
        } catch {
          // Recordarlo es solo una comodidad.
        }
      }
      ctx.notify(`Listo: el envío N.º ${r.number} salió para ${ctx.branchName(dest)}. Queda en viaje hasta que lo reciban.`);
      const fresh = await ctx.reload();
      const sent = fresh.find((t) => t.id === r.id);
      if (sent) onDispatched(sent);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo despachar.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!transfer) return onDone();
    const reason = window.prompt(`¿Por qué se cancela el pedido de ${ctx.branchName(transfer.toBranchId)}? (opcional)`);
    if (reason === null) return;
    setBusy(true);
    try {
      await cancelTransfer(transfer.id, reason);
      ctx.notify(`Se canceló el pedido N.º ${transfer.number}.`);
      await ctx.reload();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cancelar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-main panel">
      <div className="ws-head">
        <div>
          <h2>{transfer ? `Pedido de ${ctx.branchName(transfer.toBranchId)} · N.º ${transfer.number}` : "Envío sin pedido"}</h2>
          <p className="muted">
            {transfer?.neededBy && `Para el ${transfer.neededBy.split("-").reverse().join("/")}. `}
            {transfer?.requestNotes && <>Nota: <i>“{transfer.requestNotes}”</i></>}
          </p>
        </div>
        {transfer && (
          <button type="button" className="secondary" onClick={() => setPrintList(true)}>
            Imprimir lista para armar
          </button>
        )}
      </div>

      {!transfer && (
        <div className="ws-form">
          <div className="ws-form-row">
            <label className="ws-field">
              Va a
              <select value={toId} onChange={(e) => { setToId(e.target.value); setAddress(readAddress(e.target.value)); }}>
                <option value="">Elegí el local…</option>
                {others.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <label className="ws-field ws-grow">
              Nota (opcional)
              <input value={notes} maxLength={300} placeholder="Ej. reparto de los lunes" onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
        </div>
      )}

      {error && <div className="message warning">{error}</div>}

      <div className="ws-box">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Hay en {ctx.branchName(ctx.activeBranchId)}</th>
                <th className="num">Pidió</th>
                <th className="num">Mandás</th>
                <th className="hide-sm">Aviso</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {parsed.map((l, idx) => {
                const have = stock.get(l.productId)?.stock ?? 0;
                const n = Number.isFinite(l.n) ? l.n : 0;
                const changed = l.requested !== null && n !== l.requested;
                const warn = n > have ? "no alcanza: queda en negativo" : l.requested !== null && n === 0 ? "no se manda" : l.requested !== null && n < l.requested ? "mandás menos de lo pedido" : l.requested === null ? "agregado" : "";
                return (
                  <tr key={l.productId}>
                    <td>
                      <b>{l.name}</b> {l.code && <span className="muted">({l.code})</span>}
                    </td>
                    <td className={`num${have < n ? " down" : ""}`}>{formatQty(have, l.unit)}</td>
                    <td className="num">{l.requested !== null ? formatQty(l.requested, l.unit) : "—"}</td>
                    <td className="num">
                      <input
                        className={`tr-qty${changed || l.requested === null ? " tr-changed" : ""}`}
                        type="text"
                        inputMode="decimal"
                        value={l.send}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setLines((list) => list.map((x, i) => (i === idx ? { ...x, send: e.target.value } : x)))}
                      />
                    </td>
                    <td className={`hide-sm ${warn.startsWith("no") ? "down" : "muted"}`}>{warn}</td>
                    <td className="num">
                      {l.requested === null && (
                        <button type="button" className="link-button" aria-label={`Sacar ${l.name}`} onClick={() => setLines((list) => list.filter((_, i) => i !== idx))}>✕</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="ws-form">
        <ProductSearch
          products={catalog}
          exclude={inList}
          placeholder="Agregar otro producto…"
          onPick={(p) => setLines((list) => [...list, { productId: p.id, name: p.name, code: p.code, unit: p.unit, requested: null, send: "" }])}
        />
      </div>

      <div className="ws-form">
        <div className="ws-form-row">
          <label className="ws-field">
            Lo lleva
            <input value={carrier} maxLength={80} placeholder="Nombre (opcional)" onChange={(e) => setCarrier(e.target.value)} />
          </label>
          <label className="ws-field">
            Patente
            <input value={vehicle} maxLength={40} placeholder="Opcional" onChange={(e) => setVehicle(e.target.value)} />
          </label>
          <label className="ws-field">
            Comprobante
            <select value={useRemitoR ? "r" : "interno"} onChange={(e) => setUseRemitoR(e.target.value === "r")}>
              <option value="interno">Remito interno de traslado</option>
              {remitoREnabled && <option value="r">Remito R (con CAI)</option>}
            </select>
          </label>
          {useRemitoR && (
            <label className="ws-field ws-grow">
              Domicilio de {ctx.branchName(transfer?.toBranchId ?? toId)}
              <input value={address} maxLength={200} placeholder="Calle y número, localidad" onChange={(e) => setAddress(e.target.value)} />
            </label>
          )}
          {ctx.seesCost && (
            <label className="ws-field transfers-check">
              <span>
                <input type="checkbox" checked={showCost} onChange={(e) => setShowCost(e.target.checked)} /> Costos en el remito
              </span>
            </label>
          )}
        </div>
      </div>

      <div className="ws-form-total">
        <span>
          {totals.products} productos <b>{totalsLabel(totals)}</b>
          {ctx.seesCost && <span className="muted"> · a costo {formatMoney(totals.cost)}</span>}
        </span>
        <button type="button" className="secondary" disabled={busy} onClick={() => void cancel()}>
          {transfer ? "Cancelar pedido" : "Descartar"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void save()}>
          Guardar y seguir después
        </button>
        <button className="charge-button ws-go" disabled={busy} onClick={() => void dispatch()}>
          {busy ? "Despachando…" : "Despachar e imprimir remito"}
        </button>
      </div>
      <p className="muted transfers-help">
        Al despachar, la mercadería sale del stock de {ctx.branchName(ctx.activeBranchId)} y queda <b>en viaje</b> hasta que el otro local la recibe.
      </p>

      {printList && transfer && (
        <TransferPrint transfer={transfer} kind="lista" branchName={ctx.branchName} showCost={false} onDone={() => setPrintList(false)} />
      )}
    </section>
  );
}
