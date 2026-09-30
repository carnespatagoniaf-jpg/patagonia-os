import { useEffect, useMemo, useState } from "react";
import type { TreasuryAccount } from "@patagonia/domain";
import { useActiveBranch } from "../branches/BranchProvider";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listAllTreasuryAccounts } from "../shifts/treasury-service";
import { addDaysIso, todayIso } from "../shifts/format";
import type { Table } from "../import/import-parse";
import { BANK_FIELD_LABELS, guessBankMapping, parseBankStatement, type BankField, type BankMapping } from "./bank-statement";
import {
  CHANNEL_LABELS,
  MAX_DAYS_AFTER,
  summarizeByChannel,
  type Channel,
  type MatchSuggestion,
  daysWaiting,
  groupSimilarLines,
  isCardDeposit,
  isTaxLine,
  suggestMatches,
  summarizeCards,
  type SystemItem
} from "./reconcile-match";
import { readStatementFile } from "./read-statement-file";
import {
  confirmBankMatch,
  confirmBankMatches,
  createMovementFromBankLine,
  createMovementsFromBankLines,
  getReconciliationItems,
  importBankStatement,
  listBankLines,
  listReconAccounts,
  markCardDeposits,
  saveReconAccount,
  setBankLineIgnored,
  undoBankMatch,
  type ReconAccount,
  type ReconMovement,
  type ReconPayment,
  type StoredBankLine
} from "./reconciliation-service";

/**
 * Finanzas → Conciliación: subir el resumen del banco (de cualquier banco) y
 * cruzarlo con lo que registró el sistema. Ver migración 103,
 * bank-statement.ts (lector) y reconcile-match.ts (sugerencias).
 */

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => money.format(n);
const fmtDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

const MOVEMENT_LABELS: Record<string, string> = {
  venta: "Venta (turno)",
  cobro_cliente: "Cobro a cliente",
  pago_proveedor: "Pago a proveedor",
  pago_acreedor: "Pago de deuda",
  gasto: "Gasto",
  ajuste: "Ajuste",
  transferencia: "Transferencia entre cuentas",
  vale_adelanto: "Vale",
  vale_mercaderia: "Vale mercadería",
  sueldo: "Sueldo"
};

const EXPENSE_CATEGORIES: { value: string; label: string }[] = [
  { value: "otro", label: "Comisiones y otros" },
  { value: "impuestos", label: "Impuestos" },
  { value: "servicios", label: "Servicios" },
  { value: "mantenimiento", label: "Mantenimiento" },
  { value: "insumos", label: "Insumos" }
];

const FIELDS_ORDER: BankField[] = ["date", "description", "amount", "debit", "credit", "reference", "balance"];

function columnLetter(index: number) {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const box = { border: "1px solid #eef0f3", borderRadius: 10, padding: 16, marginTop: 16 } as const;
const row = { background: "#f8f9fb", borderRadius: 8, padding: 10 } as const;

interface ConfigDraft {
  id: string | null;
  name: string;
  accountIds: string[];
  cardIds: string[];
  mainId: string;
}

export function Reconciliation() {
  const { branchId } = useActiveBranch();
  const [treasuryAccounts, setTreasuryAccounts] = useState<TreasuryAccount[]>([]);
  const [reconAccounts, setReconAccounts] = useState<ReconAccount[]>([]);
  const [reconId, setReconId] = useState("");
  const [config, setConfig] = useState<ConfigDraft | null>(null);
  const [from, setFrom] = useState(addDaysIso(todayIso(), -30));
  const [to, setTo] = useState(todayIso());
  const [lines, setLines] = useState<StoredBankLine[]>([]);
  const [payments, setPayments] = useState<ReconPayment[]>([]);
  const [movements, setMovements] = useState<ReconMovement[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const [table, setTable] = useState<Table | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<BankMapping | null>(null);
  const [mappingNote, setMappingNote] = useState("");

  const [linkingLineId, setLinkingLineId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [categoryByLine, setCategoryByLine] = useState<Record<string, string>>({});

  async function loadAccounts(selectId?: string) {
    const [treasury, recon] = await Promise.all([listAllTreasuryAccounts(), listReconAccounts()]);
    setTreasuryAccounts(treasury.filter((a) => a.active));
    setReconAccounts(recon);
    const next = selectId ?? (recon.some((r) => r.id === reconId) ? reconId : recon[0]?.id ?? "");
    setReconId(next);
    if (recon.length === 0) {
      setConfig({ id: null, name: "", accountIds: [], cardIds: [], mainId: "" });
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) {
      // Modo demostración: se puede probar la lectura del resumen, sin guardar nada.
      setReconAccounts([{ id: "demo", name: "Banco (demostración)", treasuryAccountIds: [], cardAccountIds: [], mainTreasuryAccountId: "", mapping: null }]);
      setReconId("demo");
      return;
    }
    void loadAccounts().catch((err) => setMessage(err instanceof Error ? err.message : "No se pudieron cargar las cuentas."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recon = reconAccounts.find((r) => r.id === reconId) ?? null;
  const accountName = (id: string) => treasuryAccounts.find((a) => a.id === id)?.name ?? "Cuenta";

  async function reload() {
    if (!recon || !isSupabaseConfigured) return;
    setLoading(true);
    try {
      const [l, items] = await Promise.all([
        listBankLines(recon.id, from, to),
        getReconciliationItems(recon.id, addDaysIso(from, -MAX_DAYS_AFTER), to)
      ]);
      setLines(l);
      setPayments(items.payments);
      setMovements(items.movements);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar la conciliación.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconId, from, to, reconAccounts]);

  const cardIds = useMemo(() => new Set(recon?.cardAccountIds ?? []), [recon]);

  const items: SystemItem[] = useMemo(
    () => [
      ...payments
        .filter((p) => !p.reconciled)
        .map((p) => ({
          id: `p:${p.id}`,
          source: "payment" as const,
          date: p.date,
          amount: p.amount,
          isCard: cardIds.has(p.accountId),
          label: `Cobro en Mostrador · ${accountName(p.accountId)}${p.reference ? ` · op. ${p.reference}` : ""}`
        })),
      ...movements
        .filter((m) => !m.reconciled)
        .map((m) => ({
          id: `m:${m.id}`,
          source: "movement" as const,
          date: m.date,
          amount: m.direction === "in" ? m.amount : -m.amount,
          isCard: false,
          label: `${MOVEMENT_LABELS[m.type] ?? m.type} · ${accountName(m.accountId)}${m.notes ? ` · ${m.notes}` : ""}`
        }))
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payments, movements, cardIds, treasuryAccounts]
  );
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const pendingLines = useMemo(() => lines.filter((l) => l.status === "pending"), [lines]);
  const matchedLines = lines.filter((l) => l.status === "matched");
  const ignoredLines = lines.filter((l) => l.status === "ignored");
  const suggestions = useMemo(() => suggestMatches(pendingLines, items), [pendingLines, items]);
  const suggestedLineIds = new Set(suggestions.map((s) => s.lineId));
  const suggestedItemIds = new Set(suggestions.flatMap((s) => s.itemIds));
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const hasCards = (recon?.cardAccountIds.length ?? 0) > 0;
  const cardDepositsPending = hasCards ? pendingLines.filter(isCardDeposit) : [];
  const cardDepositsAll = hasCards ? lines.filter((l) => isCardDeposit(l) && (l.status === "pending" || l.matchKind === "card_deposit")) : [];
  const cardSales = useMemo(
    () => payments.filter((p) => cardIds.has(p.accountId) && p.date >= from && p.date <= to).map((p) => ({ id: p.id, source: "payment" as const, date: p.date, amount: p.amount, isCard: true, label: "" })),
    [payments, cardIds, from, to]
  );
  const cardSummary = summarizeCards(cardSales, cardDepositsAll);

  const bankOnly = pendingLines.filter((l) => !suggestedLineIds.has(l.id) && !(hasCards && isCardDeposit(l)));
  const groups = groupSimilarLines(bankOnly);
  const groupedIds = new Set(groups.flatMap((g) => g.lines.map((l) => l.id)));
  const singles = bankOnly.filter((l) => !groupedIds.has(l.id));
  const systemOnly = items.filter((i) => !i.isCard && i.date >= from && !suggestedItemIds.has(i.id));

  const parsed = useMemo(() => {
    if (!table || !mapping) return null;
    const hasMoney = mapping.columns.amount !== undefined || mapping.columns.debit !== undefined || mapping.columns.credit !== undefined;
    if (mapping.columns.date === undefined || !hasMoney) return null;
    return parseBankStatement(table, mapping);
  }, [table, mapping]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo completar.");
    } finally {
      setBusy(false);
    }
  }

  function splitIds(ids: string[]) {
    return {
      paymentIds: ids.filter((id) => id.startsWith("p:")).map((id) => id.slice(2)),
      movementIds: ids.filter((id) => id.startsWith("m:")).map((id) => id.slice(2))
    };
  }

  async function confirm(lineId: string, ids: string[], fee: number, adjustment = 0) {
    const { paymentIds, movementIds } = splitIds(ids);
    await confirmBankMatch(lineId, movementIds, paymentIds, fee, adjustment);
  }

  // Informe "banco vs sistema" de lo que entró en el período, por vía.
  const createdByRecon = new Set(lines.map((l) => l.createdMovementId).filter((x): x is string => Boolean(x)));
  const accountChannel = (accountId: string): Channel =>
    cardIds.has(accountId) ? "tarjetas" : treasuryAccounts.find((a) => a.id === accountId)?.paymentMethod === "qr" ? "billeteras" : "transferencias";
  const systemInflows = [
    ...payments.filter((p) => p.date >= from && p.date <= to).map((p) => ({ amount: p.amount, channel: accountChannel(p.accountId) })),
    ...movements
      .filter((m) => m.direction === "in" && m.date >= from && m.date <= to && !createdByRecon.has(m.id))
      .map((m) => ({ amount: m.amount, channel: m.type === "venta" ? accountChannel(m.accountId) : ("otros" as Channel) }))
  ];
  const channelRows = summarizeByChannel(lines, systemInflows);
  const exactSuggestions = suggestions.filter((s) => s.kind === "exact");
  const nearSuggestions = suggestions.filter((s) => s.kind === "near");

  function renderSuggestionGroup(title: string, help: string, list: MatchSuggestion[], near: boolean) {
    if (list.length === 0) return null;
    const totalDiff = Math.round(list.reduce((sum, s) => sum + s.difference, 0) * 100) / 100;
    return (
      <div style={box}>
        <p style={{ margin: "0 0 8px", fontWeight: 700 }}>{title} ({list.length})</p>
        <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>{help}</p>
        <button
          disabled={busy}
          style={{ marginBottom: 10 }}
          onClick={() =>
            run(async () => {
              const n = await confirmBankMatches(list.map((s) => ({ lineId: s.lineId, ...splitIds(s.itemIds), adjustment: s.difference })));
              setMessage(`Listo: ${n} movimientos conciliados${near ? `; diferencia registrada como ajuste: ${fmt(totalDiff)}` : ""}.`);
              await reload();
            })
          }
        >
          {busy ? "Confirmando…" : near ? `Confirmar las ${list.length} (diferencia total ${fmt(totalDiff)})` : `Confirmar las ${list.length}`}
        </button>
        <details open={near && list.length <= 20}>
          <summary style={{ cursor: "pointer" }}>Ver el detalle</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8, maxHeight: 500, overflowY: "auto" }}>
            {list.map((s) => {
              const line = lineById.get(s.lineId);
              const item = itemById.get(s.itemIds[0]);
              if (!line || !item) return null;
              return (
                <div key={s.lineId} style={{ ...row, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 14 }}>
                  <span><strong>Banco {fmtDate(line.date)}</strong> {line.description.slice(0, 60)} · <strong>{fmt(line.amount)}</strong></span>
                  <span className="muted">↔ {fmtDate(item.date)} · {fmt(item.amount)} · {item.label.slice(0, 60)}</span>
                  {near && <strong style={{ color: "#8a4b00" }}>diferencia {fmt(s.difference)}</strong>}
                  <button className="secondary" disabled={busy} onClick={() => run(async () => { await confirm(s.lineId, s.itemIds, 0, s.difference); await reload(); })}>Confirmar</button>
                  <button className="secondary" onClick={() => { setLinkingLineId(line.id); setSelectedIds(new Set()); }}>Otro</button>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    );
  }

  async function handleFile(file: File) {
    setMessage("");
    setMappingNote("");
    try {
      const data = await readStatementFile(file);
      setTable(data);
      setFileName(file.name);
      const saved = recon?.mapping ?? null;
      if (saved && parseBankStatement(data, saved).lines.length > 0) {
        setMapping(saved);
        setMappingNote("Usé el formato que guardaste para esta cuenta. Revisá la vista previa.");
        return;
      }
      const guessed = guessBankMapping(data);
      if (guessed) {
        setMapping(guessed);
        setMappingNote("Así entendí el resumen. Si alguna columna está mal, corregila abajo; queda guardado para la próxima.");
      } else {
        setMapping({ headerRow: 0, columns: {}, dateOrder: "dmy" });
        setMappingNote("No reconocí las columnas de este banco. Elegí abajo cuál es la fecha y cuál el importe (o débito y crédito).");
      }
    } catch (err) {
      setTable(null);
      setMapping(null);
      setMessage(err instanceof Error ? err.message : "No se pudo leer el archivo.");
    }
  }

  function setColumn(field: BankField, value: string) {
    if (!mapping) return;
    const columns = { ...mapping.columns };
    if (value === "") delete columns[field];
    else columns[field] = Number(value);
    setMapping({ ...mapping, columns });
  }

  const headerCells = table && mapping ? (table[mapping.headerRow] ?? []) : [];
  const columnCount = table ? Math.max(0, ...table.slice(0, 50).map((r) => r.length)) : 0;

  /* ------------------------------ configuración ------------------------------ */

  function renderConfig() {
    if (!config) return null;
    const toggle = (list: string[], id: string, on: boolean) => (on ? Array.from(new Set([...list, id])) : list.filter((x) => x !== id));
    return (
      <div style={box}>
        <p style={{ margin: "0 0 6px", fontWeight: 700 }}>{config.id ? "Editar cuenta del banco" : "Configurar una cuenta del banco"}</p>
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
          Una cuenta del banco puede recibir plata de varias cuentas de Tesorería (por ejemplo "Transferencia" y el posnet caen en la misma cuenta del banco). Se configura una sola vez.
        </p>
        <label style={{ display: "block", marginBottom: 10 }}>
          Nombre (ej.: Banco Provincia cuenta corriente)
          <input value={config.name} onChange={(e) => setConfig({ ...config, name: e.target.value })} style={{ width: "100%", boxSizing: "border-box" }} />
        </label>
        <table className="data-table">
          <thead>
            <tr><th>Cuenta de Tesorería</th><th>¿Cae en esta cuenta del banco?</th><th>¿Es posnet / tarjetas?</th><th>Comisiones y gastos van acá</th></tr>
          </thead>
          <tbody>
            {treasuryAccounts.map((a) => {
              const on = config.accountIds.includes(a.id);
              return (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td><input type="checkbox" checked={on} onChange={(e) => {
                    const accountIds = toggle(config.accountIds, a.id, e.target.checked);
                    setConfig({
                      ...config,
                      accountIds,
                      cardIds: config.cardIds.filter((id) => accountIds.includes(id)),
                      mainId: accountIds.includes(config.mainId) ? config.mainId : accountIds.find((id) => !config.cardIds.includes(id)) ?? accountIds[0] ?? ""
                    });
                  }} /></td>
                  <td><input type="checkbox" disabled={!on} checked={config.cardIds.includes(a.id)} onChange={(e) => setConfig({ ...config, cardIds: toggle(config.cardIds, a.id, e.target.checked) })} /></td>
                  <td><input type="radio" name="main-account" disabled={!on} checked={config.mainId === a.id} onChange={() => setConfig({ ...config, mainId: a.id })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="cash-banner-form" style={{ marginTop: 12 }}>
          <button
            disabled={busy || !config.name.trim() || config.accountIds.length === 0 || !config.mainId}
            onClick={() =>
              run(async () => {
                const id = await saveReconAccount({ id: config.id, name: config.name, treasuryAccountIds: config.accountIds, cardAccountIds: config.cardIds, mainTreasuryAccountId: config.mainId });
                setConfig(null);
                await loadAccounts(id);
              })
            }
          >
            Guardar
          </button>
          {reconAccounts.length > 0 && <button className="secondary" onClick={() => setConfig(null)}>Cancelar</button>}
        </div>
      </div>
    );
  }

  /* ------------------------------ vincular a mano ------------------------------ */

  function renderLinking() {
    const line = linkingLineId ? lineById.get(linkingLineId) : null;
    if (!line) return null;
    const candidates = items
      .filter((i) => !i.isCard && (line.amount > 0 ? i.amount > 0 : i.amount < 0))
      .sort((a, b) => daysWaiting(a.date, line.date) - daysWaiting(b.date, line.date))
      .slice(0, 400);
    const total = Array.from(selectedIds).reduce((sum, id) => sum + (itemById.get(id)?.amount ?? 0), 0);
    const diff = Math.round((total - line.amount) * 100) / 100;
    const canConfirm = selectedIds.size > 0 && (line.amount > 0 ? diff >= 0 : diff === 0);
    return (
      <div style={{ ...box, border: "2px solid #d9c9f5" }}>
        <p style={{ margin: "0 0 6px", fontWeight: 700 }}>Vincular a mano: {fmtDate(line.date)} · {line.description} · {fmt(line.amount)}</p>
        <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
          Tildá lo del sistema que corresponde a esta línea del banco.
          {line.amount > 0 && " Si el banco acreditó menos, la diferencia se carga como comisión."}
        </p>
        <div style={{ maxHeight: 300, overflowY: "auto", display: "grid", gap: 4 }}>
          {candidates.map((i) => (
            <label key={i.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
              <input
                type="checkbox"
                checked={selectedIds.has(i.id)}
                onChange={(e) => {
                  const next = new Set(selectedIds);
                  if (e.target.checked) next.add(i.id);
                  else next.delete(i.id);
                  setSelectedIds(next);
                }}
              />
              {fmtDate(i.date)} · {fmt(i.amount)} · <span className="muted">{i.label.slice(0, 80)}</span>
            </label>
          ))}
          {candidates.length === 0 && <p className="muted">No hay nada del sistema sin conciliar para vincular.</p>}
        </div>
        <p style={{ margin: "10px 0" }}>
          Elegido: <strong>{fmt(total)}</strong> · Banco: <strong>{fmt(line.amount)}</strong>
          {selectedIds.size > 0 && diff !== 0 && <> · {diff > 0 && line.amount > 0 ? <span style={{ color: "#8a4b00" }}>comisión {fmt(diff)}</span> : <span className="num-negative">no cierra por {fmt(Math.abs(diff))}</span>}</>}
        </p>
        <div className="cash-banner-form">
          <button
            disabled={busy || !canConfirm}
            onClick={() => run(async () => { await confirm(line.id, Array.from(selectedIds), line.amount > 0 ? Math.max(0, diff) : 0); setLinkingLineId(null); await reload(); })}
          >
            Confirmar
          </button>
          <button className="secondary" onClick={() => setLinkingLineId(null)}>Cancelar</button>
        </div>
      </div>
    );
  }

  /* ------------------------------ pantalla ------------------------------ */

  return (
    <div className="card">
      <h2>Conciliación bancaria</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        Subí el resumen de tu banco o billetera (Excel o CSV, de cualquier banco) y el sistema lo cruza con lo que se cobró y se pagó.
      </p>

      {isSupabaseConfigured && !config && (
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 12 }}>
          <label>
            Cuenta del banco{" "}
            <select value={reconId} onChange={(e) => setReconId(e.target.value)}>
              {reconAccounts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          {recon && (
            <button className="secondary" onClick={() => setConfig({ id: recon.id, name: recon.name, accountIds: recon.treasuryAccountIds, cardIds: recon.cardAccountIds, mainId: recon.mainTreasuryAccountId })}>
              Editar
            </button>
          )}
          <button className="secondary" onClick={() => setConfig({ id: null, name: "", accountIds: [], cardIds: [], mainId: "" })}>+ Otra cuenta del banco</button>
          <label>Desde <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Hasta <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      {recon && !config && isSupabaseConfigured && (
        <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
          Incluye: {recon.treasuryAccountIds.map((id) => `${accountName(id)}${cardIds.has(id) ? " (tarjetas)" : ""}`).join(", ")}.
        </p>
      )}

      {renderConfig()}

      {recon && !config && (
        <>
          {/* 1. Subir resumen */}
          <div style={box}>
            <p style={{ margin: "0 0 8px", fontWeight: 700 }}>1. Subir el resumen del banco</p>
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.txt"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
            {mappingNote && <p className="message" style={{ marginTop: 10 }}>{mappingNote}</p>}

            {table && mapping && (
              <div style={{ marginTop: 12 }}>
                <details open={!parsed || parsed.lines.length === 0}>
                  <summary style={{ cursor: "pointer", fontWeight: 600 }}>Columnas del resumen</summary>
                  <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", marginTop: 10 }}>
                    <label>
                      Fila de títulos
                      <select value={mapping.headerRow} onChange={(e) => setMapping({ ...mapping, headerRow: Number(e.target.value) })}>
                        {table.slice(0, 30).map((r, i) => (
                          <option key={i} value={i}>
                            Fila {i + 1}: {r.filter((c) => String(c ?? "").trim()).slice(0, 3).map((c) => String(c)).join(" · ").slice(0, 50)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {FIELDS_ORDER.map((field) => (
                      <label key={field}>
                        {BANK_FIELD_LABELS[field]}
                        <select value={mapping.columns[field] ?? ""} onChange={(e) => setColumn(field, e.target.value)}>
                          <option value="">— no tiene —</option>
                          {Array.from({ length: columnCount }, (_, i) => (
                            <option key={i} value={i}>{columnLetter(i)}: {String(headerCells[i] ?? "").slice(0, 30)}</option>
                          ))}
                        </select>
                      </label>
                    ))}
                    <label>
                      Formato de fecha
                      <select value={mapping.dateOrder} onChange={(e) => setMapping({ ...mapping, dateOrder: e.target.value as BankMapping["dateOrder"] })}>
                        <option value="dmy">día/mes/año</option>
                        <option value="mdy">mes/día/año</option>
                        <option value="ymd">año-mes-día</option>
                      </select>
                    </label>
                  </div>
                  <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                    Si el banco pone débitos y créditos en columnas separadas, elegí esas dos y dejá "Importe" en "no tiene".
                  </p>
                </details>

                {parsed && (
                  <>
                    <p style={{ margin: "12px 0 6px" }}>
                      <strong>{parsed.lines.length}</strong> movimientos leídos de <em>{fileName}</em>
                      {parsed.lines.length > 0 && <> · del {fmtDate(parsed.lines.reduce((m, l) => (l.date < m ? l.date : m), parsed.lines[0].date))} al {fmtDate(parsed.lines.reduce((m, l) => (l.date > m ? l.date : m), parsed.lines[0].date))}</>}
                      {parsed.skipped.length > 0 && <span className="muted"> · {parsed.skipped.length} filas salteadas (saldos, totales, textos)</span>}
                    </p>
                    <div style={{ overflowX: "auto" }}>
                      <table className="data-table">
                        <thead><tr><th>Fecha</th><th>Detalle</th><th>Operación</th><th className="num">Importe</th></tr></thead>
                        <tbody>
                          {parsed.lines.slice(0, 8).map((l) => (
                            <tr key={l.key}>
                              <td>{fmtDate(l.date)}</td>
                              <td>{l.description}</td>
                              <td>{l.reference ?? ""}</td>
                              <td className={`num ${l.amount < 0 ? "num-negative" : "num-positive"}`}>{fmt(l.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {parsed.lines.length > 8 && <p className="muted" style={{ fontSize: 12 }}>Mostrando 8 de {parsed.lines.length}.</p>}
                    <p className="muted" style={{ fontSize: 13 }}>¿Las fechas y los importes coinciden con el banco? Lo que entra tiene que ser positivo y lo que sale, negativo.</p>
                    <div className="cash-banner-form">
                      <button
                        disabled={busy || parsed.lines.length === 0 || !isSupabaseConfigured}
                        title={isSupabaseConfigured ? undefined : "En modo demostración no se guarda nada"}
                        onClick={() =>
                          run(async () => {
                            const result = await importBankStatement(recon.id, fileName, mapping, parsed.lines);
                            setTable(null);
                            setMapping(null);
                            setMappingNote("");
                            setMessage(`Listo: ${result.new} movimientos nuevos${result.repeated > 0 ? `, ${result.repeated} ya estaban cargados de antes (no se repiten)` : ""}.`);
                            await loadAccounts(recon.id);
                          })
                        }
                      >
                        {busy ? "Importando…" : `Importar ${parsed.lines.length} movimientos`}
                      </button>
                      <button className="secondary" onClick={() => { setTable(null); setMapping(null); setMappingNote(""); }}>Cancelar</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {message && <p className="message" style={{ marginTop: 12 }}>{message}</p>}
          {loading && <p className="muted">Cargando…</p>}

          {isSupabaseConfigured && lines.length > 0 && (
            <p style={{ marginTop: 16 }}>
              En el período: <strong>{lines.length}</strong> movimientos del banco · <strong>{matchedLines.length}</strong> conciliados · <strong>{pendingLines.length}</strong> pendientes
              {ignoredLines.length > 0 && <> · {ignoredLines.length} ignorados</>}
            </p>
          )}

          {/* Informe: lo que entró según el banco vs según el sistema */}
          {isSupabaseConfigured && channelRows.length > 0 && (
            <div style={box}>
              <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Lo que entró en el período: banco vs sistema</p>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead><tr><th>Vía</th><th className="num">Según el banco</th><th className="num">Según el sistema</th><th className="num">Diferencia</th></tr></thead>
                  <tbody>
                    {channelRows.map((r) => (
                      <tr key={r.channel}>
                        <td>{CHANNEL_LABELS[r.channel]}</td>
                        <td className="num">{fmt(r.bank)} <span className="muted">({r.bankCount})</span></td>
                        <td className="num">{fmt(r.system)} <span className="muted">({r.systemCount})</span></td>
                        <td className={`num ${Math.abs(r.difference) < 1 ? "" : r.difference > 0 ? "num-positive" : "num-negative"}`}>{fmt(r.difference)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td><strong>Total</strong></td>
                      <td className="num"><strong>{fmt(channelRows.reduce((t, r) => t + r.bank, 0))}</strong></td>
                      <td className="num"><strong>{fmt(channelRows.reduce((t, r) => t + r.system, 0))}</strong></td>
                      <td className="num"><strong>{fmt(channelRows.reduce((t, r) => t + r.difference, 0))}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
                Diferencia positiva: entró al banco más de lo que registró el sistema (cobros que no pasaron por Mostrador o se cargaron en otra vía). Negativa: el sistema tiene más (en tarjetas es normal: comisiones y lo que todavía no se acreditó). El detalle, abajo.
              </p>
            </div>
          )}

          {renderSuggestionGroup("2. Coincidencias exactas", "Mismo importe al centavo y fecha cercana. Nada queda conciliado hasta que confirmás.", exactSuggestions, false)}
          {renderSuggestionGroup(
            "2b. Casi iguales (revisalas)",
            "Parece el mismo cobro con unos pesos de diferencia (por ejemplo, se cargó redondeado). Al confirmar, la diferencia queda registrada en Tesorería como ajuste \"Diferencia de cobro\", a la vista.",
            nearSuggestions,
            true
          )}

          {/* 3. Tarjetas */}
          {hasCards && (cardSummary.soldCount > 0 || cardSummary.depositCount > 0) && (
            <div style={box}>
              <p style={{ margin: "0 0 8px", fontWeight: 700 }}>3. Tarjetas del período</p>
              <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                El banco acredita las tarjetas por lote, por marca, días hábiles después y con la comisión ya descontada, así que no se cruzan venta por venta sino por período.
              </p>
              <p style={{ margin: "0 0 4px" }}>Vendido con tarjeta en Mostrador: <strong>{fmt(cardSummary.sold)}</strong> ({cardSummary.soldCount} cobros)</p>
              <p style={{ margin: "0 0 4px" }}>Acreditado por el banco: <strong>{fmt(cardSummary.deposited)}</strong> ({cardSummary.depositCount} depósitos)</p>
              <p style={{ margin: "0 0 10px" }}>
                Diferencia: <strong>{fmt(cardSummary.difference)}</strong>{cardSummary.differencePct !== null && ` (${cardSummary.differencePct}%)`} — comisiones y retenciones de las tarjetas, más lo vendido en los últimos días que todavía no se acreditó.
              </p>
              {cardDepositsPending.length > 0 && (
                <button
                  disabled={busy}
                  onClick={() => run(async () => { const n = await markCardDeposits(cardDepositsPending.map((l) => l.id)); setMessage(`Listo: ${n} acreditaciones de tarjeta conciliadas.`); await reload(); })}
                >
                  Marcar las {cardDepositsPending.length} acreditaciones de tarjeta como conciliadas
                </button>
              )}
            </div>
          )}

          {/* 4. En el banco y no en el sistema */}
          <div style={box}>
            <p style={{ margin: "0 0 8px", fontWeight: 700 }}>4. Están en el banco y no en el sistema ({bankOnly.length})</p>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
              Impuestos, comisiones, débitos automáticos, pagos o cobros que no se cargaron. Cargalos en Tesorería, vinculalos a mano o ignoralos si no corresponden.
            </p>
            {bankOnly.length === 0 && <p className="muted">Nada pendiente.</p>}
            {groups.map((g) => {
              const category = g.lines.every(isTaxLine) ? "impuestos" : "otro";
              return (
                <div key={g.label} style={{ ...row, marginBottom: 8 }}>
                  <div><strong>{g.lines.length} × {g.label}</strong> · total <strong className={g.total < 0 ? "num-negative" : "num-positive"}>{fmt(g.total)}</strong></div>
                  <div className="cash-banner-form" style={{ marginTop: 6, flexWrap: "wrap" }}>
                    {g.total < 0 && (
                      <button
                        disabled={busy || !branchId}
                        onClick={() => run(async () => { const n = await createMovementsFromBankLines(g.lines.map((l) => l.id), branchId!, category); setMessage(`Listo: ${n} gastos cargados en Tesorería (${category === "impuestos" ? "Impuestos" : "Comisiones y otros"}).`); await reload(); })}
                      >
                        Cargar los {g.lines.length} como gasto ({category === "impuestos" ? "Impuestos" : "Comisiones y otros"})
                      </button>
                    )}
                    <details>
                      <summary style={{ cursor: "pointer" }}>Ver uno por uno</summary>
                      {g.lines.map((l) => (
                        <div key={l.id} className="muted" style={{ fontSize: 13 }}>{fmtDate(l.date)} · {l.description} · {fmt(l.amount)}</div>
                      ))}
                    </details>
                  </div>
                </div>
              );
            })}
            <div style={{ display: "grid", gap: 8 }}>
              {singles.map((line) => {
                const category = categoryByLine[line.id] ?? (isTaxLine(line) ? "impuestos" : "otro");
                return (
                  <div key={line.id} style={row}>
                    <div>
                      <strong>{fmtDate(line.date)}</strong> · {line.description} {line.reference && <span className="muted">(op. {line.reference})</span>} ·{" "}
                      <strong className={line.amount < 0 ? "num-negative" : "num-positive"}>{fmt(line.amount)}</strong>
                    </div>
                    <div className="cash-banner-form" style={{ marginTop: 6, flexWrap: "wrap" }}>
                      {line.amount < 0 && (
                        <select value={category} onChange={(e) => setCategoryByLine({ ...categoryByLine, [line.id]: e.target.value })}>
                          {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                      )}
                      <button disabled={busy || !branchId} onClick={() => run(async () => { await createMovementFromBankLine(line.id, branchId!, category, line.description); await reload(); })}>
                        {line.amount < 0 ? "Cargar como gasto" : "Cargar como ingreso"}
                      </button>
                      <button className="secondary" onClick={() => { setLinkingLineId(line.id); setSelectedIds(new Set()); }}>Vincular a mano</button>
                      <button className="secondary" disabled={busy} onClick={() => run(async () => { await setBankLineIgnored(line.id, true); await reload(); })}>Ignorar</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {renderLinking()}

          {/* 5. En el sistema y no en el banco */}
          <div style={box}>
            <p style={{ margin: "0 0 8px", fontWeight: 700 }}>5. Están en el sistema y no en el banco ({systemOnly.length})</p>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
              Cobros o pagos que el sistema tiene y el banco todavía no muestra: puede faltar subir el resumen de esos días, puede que se hayan cobrado en otra cuenta (ej. Mercado Pago) o con otro importe. Las tarjetas no aparecen acá (van en el punto 3).
            </p>
            {systemOnly.length === 0 && <p className="muted">Nada pendiente.</p>}
            {systemOnly.length > 0 && (
              <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
                <table className="data-table">
                  <thead><tr><th>Fecha</th><th>Qué es</th><th className="num">Importe</th><th className="num">Días</th></tr></thead>
                  <tbody>
                    {systemOnly.map((i) => {
                      const waiting = daysWaiting(i.date, todayIso());
                      return (
                        <tr key={i.id}>
                          <td>{fmtDate(i.date)}</td>
                          <td className="muted">{i.label}</td>
                          <td className={`num ${i.amount < 0 ? "num-negative" : "num-positive"}`}>{fmt(i.amount)}</td>
                          <td className="num" style={{ color: waiting > 7 ? "#8a1f11" : undefined }}>{waiting}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Conciliadas e ignoradas */}
          {matchedLines.length > 0 && (
            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Conciliadas ({matchedLines.length})</summary>
              <div style={{ display: "grid", gap: 4, marginTop: 8, maxHeight: 400, overflowY: "auto" }}>
                {matchedLines.map((line) => (
                  <div key={line.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
                    <span>✓ {fmtDate(line.date)} · {line.description} · {fmt(line.amount)}</span>
                    <span className="muted">
                      ({line.matchKind === "card_deposit" ? "acreditación de tarjetas" : `${line.paymentIds.length + line.movementIds.length} del sistema`}{line.createdMovementId ? ", cargado desde el banco" : ""})
                    </span>
                    <button className="secondary" disabled={busy} onClick={() => run(async () => { await undoBankMatch(line.id); await reload(); })}>Deshacer</button>
                  </div>
                ))}
              </div>
            </details>
          )}
          {ignoredLines.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Ignoradas ({ignoredLines.length})</summary>
              <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
                {ignoredLines.map((line) => (
                  <div key={line.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
                    <span>{fmtDate(line.date)} · {line.description} · {fmt(line.amount)}</span>
                    <button className="secondary" disabled={busy} onClick={() => run(async () => { await setBankLineIgnored(line.id, false); await reload(); })}>Volver a pendiente</button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
