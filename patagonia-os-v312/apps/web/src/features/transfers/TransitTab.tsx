import { Fragment, useState } from "react";
import { formatMoney } from "../shifts/format";
import { TransferRemitoPrint } from "./TransferPaper";
import { STATUS_LABELS, formatQty, isLate, qtyTotals, receiveDiffs, totalsLabel, transferDiffRows, whenLabel, type Transfer } from "./transfer-logic";
import { voidTransfer } from "./transfers-service";
import type { TransfersContext } from "./Transfers";

// "En viaje": lo que salió y nadie recibió todavía (el dueño ve toda la cadena y las diferencias al recibir).
// "Historial": pedidos y envíos de los últimos 60 días, con el detalle de cada uno.

const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit" }) : "");

export function TransitTab({ ctx, mode }: { ctx: TransfersContext; mode: "viaje" | "historial" }) {
  const now = new Date();
  const mine = (t: Transfer) => ctx.admin || t.fromBranchId === ctx.activeBranchId || t.toBranchId === ctx.activeBranchId;
  const list = ctx.transfers.filter((t) => mine(t) && (mode === "viaje" ? t.status === "en_viaje" : true));
  const [openId, setOpenId] = useState<string | null>(null);
  const [printing, setPrinting] = useState<Transfer | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const value = (t: Transfer) => qtyTotals(t.items.map((i) => ({ unit: i.unit, qty: i.sent ?? 0, unitCost: i.unitCost })));
  const transitCost = list.filter((t) => t.status === "en_viaje").reduce((acc, t) => acc + value(t).cost, 0);
  const diffRows = mode === "viaje" && ctx.admin ? transferDiffRows(ctx.transfers) : [];

  async function annul(t: Transfer) {
    const reason = window.prompt(`Anular el envío N.º ${t.number} (${ctx.branchName(t.fromBranchId)} → ${ctx.branchName(t.toBranchId)}): la mercadería vuelve a ${ctx.branchName(t.fromBranchId)}. ¿Por qué?`);
    if (reason === null) return;
    if (!reason.trim()) return setError("Para anular un envío escribí el motivo.");
    setBusy(true);
    setError("");
    try {
      await voidTransfer(t.id, reason);
      ctx.notify(`Se anuló el envío N.º ${t.number}: la mercadería volvió a ${ctx.branchName(t.fromBranchId)}.`);
      await ctx.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo anular.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-main panel">
      <div className="ws-head">
        <div>
          <h2>{mode === "viaje" ? "En viaje ahora" : "Historial"}</h2>
          <p className="muted">{mode === "viaje" ? "Salió de un local y todavía no lo recibieron." : "Pedidos y envíos de los últimos 60 días. Tocá uno para ver el detalle."}</p>
        </div>
        {mode === "viaje" && ctx.seesCost && list.length > 0 && <b>{formatMoney(transitCost)} a costo</b>}
      </div>
      {error && <div className="message warning">{error}</div>}
      {list.length === 0 ? (
        <p className="muted">{mode === "viaje" ? "No hay nada en viaje." : "Todavía no hay pedidos ni envíos."}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>N.º</th>
                <th>De → a</th>
                {mode === "historial" && <th>Estado</th>}
                <th className="num">Cantidad</th>
                {ctx.seesCost && <th className="num hide-sm">A costo</th>}
                <th>{mode === "viaje" ? "Salió" : "Fecha"}</th>
                {mode === "historial" && <th className="hide-sm">Diferencias</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => {
                const v = value(t);
                const late = isLate(t, now);
                const diffs = t.status === "recibido" ? receiveDiffs(t.items, new Map()) : [];
                const open = openId === t.id;
                return (
                  <Fragment key={t.id}>
                    <tr className={`row-clickable${open ? " row-selected" : ""}`} onClick={() => setOpenId(open ? null : t.id)}>
                      <td>{t.number}</td>
                      <td>
                        <b>{ctx.branchName(t.fromBranchId)} → {ctx.branchName(t.toBranchId)}</b>
                      </td>
                      {mode === "historial" && (
                        <td>
                          <span className={`badge${t.status === "recibido" ? " ok" : t.status === "cancelado" ? "" : " warn"}`}>{STATUS_LABELS[t.status]}</span>
                        </td>
                      )}
                      <td className="num">{!t.dispatchedAt ? totalsLabel(qtyTotals(t.items.map((i) => ({ unit: i.unit, qty: i.requested ?? 0 })))) : totalsLabel(v)}</td>
                      {ctx.seesCost && <td className="num hide-sm">{v.cost > 0 ? formatMoney(v.cost) : "—"}</td>}
                      <td className={late ? "down" : undefined}>
                        {mode === "viaje" ? `${whenLabel(t.dispatchedAt, now)}${late ? " · sin recibir" : ""}` : shortDate(t.createdAt)}
                      </td>
                      {mode === "historial" && (
                        <td className="hide-sm">
                          {diffs.length === 0 ? (t.status === "recibido" ? <span className="muted">llegó bien</span> : "") : <span className="down">{diffs.length} con diferencia</span>}
                        </td>
                      )}
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          {(t.status === "en_viaje" || t.status === "recibido") && (
                            <button type="button" className="secondary" onClick={() => setPrinting(t)}>
                              Remito
                            </button>
                          )}
                          {ctx.admin && t.status === "en_viaje" && (
                            <button type="button" className="secondary" disabled={busy} onClick={() => void annul(t)}>
                              Anular
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="row-editor">
                        <td colSpan={8}>
                          <TransferDetail t={t} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {mode === "viaje" && ctx.admin && (
        <div className="ws-box">
          <h3>
            Diferencias al recibir <span className="muted">últimos 60 días</span>
          </h3>
          {diffRows.length === 0 ? (
            <p className="muted transfers-pad">Todo llegó como salió.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>De → a</th>
                    <th>Producto</th>
                    <th className="num">Diferencia</th>
                    {ctx.seesCost && <th className="num">A costo</th>}
                    <th>Recibió</th>
                  </tr>
                </thead>
                <tbody>
                  {diffRows.map(({ transfer: t, diff: d }) => (
                    <tr key={`${t.id}-${d.itemId}`}>
                      <td>{shortDate(t.receivedAt)}</td>
                      <td>{ctx.branchName(t.fromBranchId)} → {ctx.branchName(t.toBranchId)}</td>
                      <td>{d.name}</td>
                      <td className={`num ${d.diff < 0 ? "down" : "up"}`}>{`${d.diff > 0 ? "+ " : "− "}${formatQty(Math.abs(d.diff), d.unit)}`}</td>
                      {ctx.seesCost && <td className="num">{formatMoney(Math.abs(d.cost))}</td>}
                      <td>{t.receivedByName ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {printing && (
        <TransferRemitoPrint
          transfer={printing}
          branchName={ctx.branchName}
          showCost={printing.showCost && ctx.seesCost}
          onDone={() => setPrinting(null)}
          onError={(text) => {
            setPrinting(null);
            setError(text);
          }}
        />
      )}
    </section>
  );
}

function TransferDetail({ t }: { t: Transfer }) {
  const now = new Date();
  return (
    <div className="transfers-detail">
      <p className="muted">
        {t.requestedAt && `Pedido ${whenLabel(t.requestedAt, now)}. `}
        {t.dispatchedAt && `Salió ${whenLabel(t.dispatchedAt, now)}${t.carrier ? ` (lo llevó ${t.carrier}${t.vehicle ? `, ${t.vehicle}` : ""})` : ""}. `}
        {t.receivedAt && `Recibió ${t.receivedByName ?? "—"} ${whenLabel(t.receivedAt, now)}. `}
        {t.cancelledAt && `Cancelado ${whenLabel(t.cancelledAt, now)}${t.cancelReason ? `: ${t.cancelReason}` : ""}. `}
      </p>
      {t.requestNotes && <p className="muted">Nota del pedido: “{t.requestNotes}”</p>}
      {t.receiveNotes && <p className="muted">Al recibir: “{t.receiveNotes}”</p>}
      <table className="data-table no-stack">
        <thead>
          <tr>
            <th>Producto</th>
            <th className="num">Pidió</th>
            <th className="num">Mandó</th>
            <th className="num">Llegó</th>
          </tr>
        </thead>
        <tbody>
          {t.items.map((i) => (
            <tr key={i.id}>
              <td>{i.name}</td>
              <td className="num">{i.requested !== null ? formatQty(i.requested, i.unit) : "—"}</td>
              <td className="num">{i.sent !== null && t.status !== "pedido" ? formatQty(i.sent, i.unit) : "—"}</td>
              <td className={`num${i.received !== null && i.sent !== null && i.received !== i.sent ? " down" : ""}`}>{i.received !== null ? formatQty(i.received, i.unit) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
