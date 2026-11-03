import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { formatMoney } from "../shifts/format";
import { parseQuantity } from "../sale/quantity";
import { diffSummary, formatQty, qtyTotals, receiveDiffs, totalsLabel, whenLabel, type Transfer } from "./transfer-logic";
import { receiveTransfer } from "./transfers-service";
import type { TransfersContext } from "./Transfers";

// Paso 4: el local que recibe pesa o cuenta y anota lo que llegó. Entra eso; lo que falta queda registrado
// como faltante del traslado (no vuelve al local que mandó), con quién recibió.

export function ReceiveTab({ ctx }: { ctx: TransfersContext }) {
  const incoming = useMemo(
    () => ctx.transfers.filter((t) => t.toBranchId === ctx.activeBranchId && t.status === "en_viaje").sort((a, b) => (a.dispatchedAt ?? "").localeCompare(b.dispatchedAt ?? "")),
    [ctx.transfers, ctx.activeBranchId]
  );
  const [selectedId, setSelectedId] = useState<string | null>(incoming[0]?.id ?? null);
  const selected = incoming.find((t) => t.id === selectedId) ?? null;

  useEffect(() => {
    if (!incoming.some((t) => t.id === selectedId)) setSelectedId(incoming[0]?.id ?? null);
  }, [incoming, selectedId]);

  return (
    <div className="ws-layout">
      <section className="ws-list panel">
        <div className="panel-title">
          <h2>Para recibir</h2>
        </div>
        <div className="ws-list-items">
          {incoming.length === 0 && <p className="muted">No viene nada para {ctx.branchName(ctx.activeBranchId)}.</p>}
          {incoming.map((t) => {
            const totals = qtyTotals(t.items.map((i) => ({ unit: i.unit, qty: i.sent ?? 0 })));
            return (
              <button key={t.id} type="button" className={`ws-item${t.id === selectedId ? " active" : ""}`} onClick={() => setSelectedId(t.id)}>
                <span className="ws-item-main">
                  <b>De {ctx.branchName(t.fromBranchId)}</b>
                  <small>N.º {t.number} · {totals.products} productos · {totalsLabel(totals)}</small>
                  <small>salió {whenLabel(t.dispatchedAt, new Date())}</small>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {selected ? (
        <ReceiveForm key={selected.id} ctx={ctx} transfer={selected} />
      ) : (
        <section className="ws-main panel">
          <p className="muted">Cuando otro local te mande mercadería, aparece acá para que la controles.</p>
        </section>
      )}
    </div>
  );
}

function ReceiveForm({ ctx, transfer }: { ctx: TransfersContext; transfer: Transfer }) {
  const { profile } = useAuth();
  const items = transfer.items.filter((i) => (i.sent ?? 0) > 0);
  const [got, setGot] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.id, String(i.sent).replace(".", ",")])));
  const [who, setWho] = useState(profile?.full_name ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const values = new Map(items.map((i) => [i.id, parseQuantity(got[i.id] ?? "")]));
  const diffs = receiveDiffs(items, new Map([...values].filter(([, v]) => Number.isFinite(v))));
  const summary = diffSummary(diffs);

  async function confirm(all: boolean) {
    setError("");
    const received = items.map((i) => ({ itemId: i.id, received: all ? i.sent ?? 0 : values.get(i.id) ?? NaN }));
    const bad = received.find((r) => !Number.isFinite(r.received) || r.received < 0);
    if (bad) return setError(`Anotá cuánto llegó de ${items.find((i) => i.id === bad.itemId)?.name ?? "cada producto"} (0 si no llegó).`);
    if (all && diffs.length > 0 && !window.confirm("Anotaste diferencias. ¿Confirmás que llegó todo lo que mandaron?")) return;
    if (all) setGot(Object.fromEntries(items.map((i) => [i.id, String(i.sent).replace(".", ",")])));
    setBusy(true);
    try {
      const r = await receiveTransfer({ id: transfer.id, received, receivedByName: who, notes });
      const extra = r.missing > 0 ? ` Faltó mercadería: quedó registrado como faltante del traslado.` : r.extra > 0 ? " Llegó de más: entró lo que anotaste." : "";
      ctx.notify(`Listo: entró a ${ctx.branchName(ctx.activeBranchId)} el envío N.º ${transfer.number}.${extra}`);
      await ctx.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo confirmar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-main panel">
      <div className="ws-head">
        <div>
          <h2>Llegó de {ctx.branchName(transfer.fromBranchId)} · envío N.º {transfer.number}</h2>
          <p className="muted">
            Salió {whenLabel(transfer.dispatchedAt, new Date())}
            {transfer.carrier && ` · lo trajo ${transfer.carrier}`}. Pesá o contá cada cosa y anotá lo que llegó.
          </p>
        </div>
      </div>
      {error && <div className="message warning">{error}</div>}
      <div className="ws-box">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Mandaron</th>
                <th className="num">Llegó</th>
                <th className="num">Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const d = diffs.find((x) => x.itemId === i.id);
                return (
                  <tr key={i.id}>
                    <td>
                      <b>{i.name}</b> {i.code && <span className="muted">({i.code})</span>}
                    </td>
                    <td className="num">{formatQty(i.sent ?? 0, i.unit)}</td>
                    <td className="num">
                      <input
                        className={`tr-qty${d ? " tr-changed" : ""}`}
                        type="text"
                        inputMode="decimal"
                        value={got[i.id] ?? ""}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setGot((g) => ({ ...g, [i.id]: e.target.value }))}
                      />
                    </td>
                    <td className={`num${d ? (d.diff < 0 ? " down" : " up") : " muted"}`}>{d ? `${d.diff > 0 ? "+ " : "− "}${formatQty(Math.abs(d.diff), i.unit)}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="ws-form">
        <div className="ws-form-row">
          <label className="ws-field">
            ¿Quién recibe?
            <input value={who} maxLength={60} onChange={(e) => setWho(e.target.value)} />
          </label>
          <label className="ws-field ws-grow">
            Comentario {diffs.length > 0 ? "de las diferencias" : "(opcional)"}
            <input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
      </div>
      {summary.missing.products > 0 && (
        <div className="message warning">
          <b>
            Faltan {totalsLabel(summary.missing)}
            {ctx.seesCost && ` (${formatMoney(summary.missing.cost)} a costo)`}.
          </b>{" "}
          Entra a {ctx.branchName(ctx.activeBranchId)} lo que llegó. Lo que falta queda registrado como faltante del traslado, con tu nombre, y lo ve el dueño.
        </div>
      )}
      {summary.extra.products > 0 && <div className="message">Llegó de más: {totalsLabel(summary.extra)}. Entra lo que anotaste.</div>}
      <div className="ws-form-total">
        <button type="button" className="secondary" disabled={busy} onClick={() => void confirm(true)}>
          Llegó todo bien
        </button>
        <button className="charge-button ws-go" disabled={busy} onClick={() => void confirm(false)}>
          {busy ? "Guardando…" : "Confirmar lo que llegó"}
        </button>
      </div>
    </section>
  );
}
