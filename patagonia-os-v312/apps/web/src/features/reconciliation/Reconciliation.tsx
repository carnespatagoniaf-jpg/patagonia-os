import { useEffect, useMemo, useState } from "react";
import type { TreasuryAccount } from "@patagonia/domain";
import { useActiveBranch } from "../branches/BranchProvider";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listAllTreasuryAccounts } from "../shifts/treasury-service";
import { addDaysIso, todayIso } from "../shifts/format";
import type { Table } from "../import/import-parse";
import { BANK_FIELD_LABELS, guessBankMapping, parseBankStatement, type BankField, type BankMapping } from "./bank-statement";
import { CARD_SETTLEMENT_MAX_DAYS, daysWaiting, suggestMatches } from "./reconcile-match";
import { readStatementFile } from "./read-statement-file";
import {
  confirmBankMatch,
  createMovementFromBankLine,
  getSavedBankFormat,
  importBankStatement,
  listAccountMovements,
  listBankLines,
  setBankLineIgnored,
  undoBankMatch,
  type AccountMovement,
  type StoredBankLine
} from "./reconciliation-service";

/**
 * Tesorería → Conciliación: subir el resumen del banco (de cualquier banco)
 * y cruzarlo con los movimientos de la cuenta. Ver migración 103 y
 * bank-statement.ts / reconcile-match.ts.
 */

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => money.format(n);
const fmtDate = (iso: string) => iso.split("-").reverse().join("/");

const MOVEMENT_LABELS: Record<string, string> = {
  venta: "Venta",
  cobro_cliente: "Cobro a cliente",
  pago_proveedor: "Pago a proveedor",
  pago_acreedor: "Pago de deuda",
  gasto: "Gasto",
  ajuste: "Ajuste",
  transferencia: "Transferencia",
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

function guessCategory(description: string): string {
  return /imp|ley|iibb|ingresos brutos|sellos|percep|retenc|iva|ganancias|afip|arca/i.test(description) ? "impuestos" : "otro";
}

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

export function Reconciliation() {
  const { branchId } = useActiveBranch();
  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [from, setFrom] = useState(addDaysIso(todayIso(), -60));
  const [to, setTo] = useState(todayIso());
  const [lines, setLines] = useState<StoredBankLine[]>([]);
  const [movements, setMovements] = useState<AccountMovement[]>([]);
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

  useEffect(() => {
    if (!isSupabaseConfigured) {
      // Modo demostración: se puede probar la lectura del resumen, sin guardar nada.
      setAccounts([{ id: "demo", name: "Banco (demostración)", initialBalance: 0, active: true }]);
      setAccountId("demo");
      return;
    }
    void listAllTreasuryAccounts().then((list) => {
      const active = list.filter((a) => a.active);
      setAccounts(active);
      const firstNonCash = active.find((a) => a.paymentMethod !== "cash") ?? active[0];
      if (firstNonCash) setAccountId(firstNonCash.id);
    });
  }, []);

  async function reload() {
    if (!accountId || !isSupabaseConfigured) return;
    setLoading(true);
    try {
      const [l, m] = await Promise.all([
        listBankLines(accountId, from, to),
        listAccountMovements(accountId, addDaysIso(from, -CARD_SETTLEMENT_MAX_DAYS), to)
      ]);
      setLines(l);
      setMovements(m);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar la conciliación.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, from, to]);

  const pendingLines = useMemo(() => lines.filter((l) => l.status === "pending"), [lines]);
  const matchedLines = useMemo(() => lines.filter((l) => l.status === "matched"), [lines]);
  const ignoredLines = useMemo(() => lines.filter((l) => l.status === "ignored"), [lines]);
  const freeMovements = useMemo(() => movements.filter((m) => !m.reconciled), [movements]);
  const movementById = useMemo(() => new Map(movements.map((m) => [m.id, m])), [movements]);

  const suggestions = useMemo(
    () =>
      suggestMatches(
        pendingLines.map((l) => ({ id: l.id, date: l.date, amount: l.amount, description: l.description })),
        freeMovements.map((m) => ({ id: m.id, date: m.date, direction: m.direction, amount: m.amount, movementType: m.movementType }))
      ),
    [pendingLines, freeMovements]
  );
  const suggestedLineIds = new Set(suggestions.map((s) => s.lineId));
  const suggestedMovementIds = new Set(suggestions.flatMap((s) => s.movementIds));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const bankOnly = pendingLines.filter((l) => !suggestedLineIds.has(l.id));
  const systemOnly = freeMovements.filter((m) => m.date >= from && !suggestedMovementIds.has(m.id));

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

  async function handleFile(file: File) {
    setMessage("");
    setMappingNote("");
    try {
      const data = await readStatementFile(file);
      setTable(data);
      setFileName(file.name);
      const saved = accountId && isSupabaseConfigured ? await getSavedBankFormat(accountId).catch(() => null) : null;
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

  function startLinking(line: StoredBankLine) {
    setLinkingLineId(line.id);
    setSelectedIds(new Set());
  }

  const headerCells = table && mapping ? (table[mapping.headerRow] ?? []) : [];
  const columnCount = table ? Math.max(0, ...table.slice(0, 50).map((r) => r.length)) : 0;

  return (
    <div className="card">
      <h2>Conciliación bancaria</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        Subí el resumen de tu banco o billetera (Excel o CSV, de cualquier banco) y el sistema lo cruza con los movimientos de esa cuenta en Tesorería.
      </p>

      <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 12 }}>
        <label>
          Cuenta{" "}
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <label>
          Desde <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Hasta <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {/* 1. Subir resumen */}
      <div style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 16, marginTop: 16 }}>
        <p style={{ margin: "0 0 8px", fontWeight: 700 }}>1. Subir el resumen del banco</p>
        <input
          type="file"
          accept=".xlsx,.xls,.csv,.txt"
          disabled={!accountId}
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
                    {table.slice(0, 30).map((row, i) => (
                      <option key={i} value={i}>
                        Fila {i + 1}: {row.filter((c) => String(c ?? "").trim()).slice(0, 3).map((c) => String(c)).join(" · ").slice(0, 50)}
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
                        <option key={i} value={i}>
                          {columnLetter(i)}: {String(headerCells[i] ?? "").slice(0, 30)}
                        </option>
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
                  {parsed.skipped.length > 0 && <span className="muted"> · {parsed.skipped.length} filas salteadas (saldos, totales, vacías)</span>}
                </p>
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table">
                    <thead>
                      <tr><th>Fecha</th><th>Detalle</th><th>Operación</th><th className="num">Importe</th></tr>
                    </thead>
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
                <p className="muted" style={{ fontSize: 13 }}>¿Las fechas y los importes coinciden con el resumen del banco? Los que entran plata tienen que ser positivos y los que salen, negativos.</p>
                <div className="cash-banner-form">
                  <button
                    disabled={busy || parsed.lines.length === 0 || !isSupabaseConfigured}
                    title={isSupabaseConfigured ? undefined : "En modo demostración no se guarda nada"}
                    onClick={() =>
                      run(async () => {
                        const result = await importBankStatement(accountId, fileName, mapping, parsed.lines);
                        setTable(null);
                        setMapping(null);
                        setMappingNote("");
                        setMessage(`Listo: ${result.new} movimientos nuevos${result.repeated > 0 ? `, ${result.repeated} ya estaban cargados de antes (no se repiten)` : ""}.`);
                        await reload();
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

      {/* 2. Sugerencias */}
      {suggestions.length > 0 && (
        <div style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 16, marginTop: 16 }}>
          <p style={{ margin: "0 0 8px", fontWeight: 700 }}>2. Coincidencias encontradas ({suggestions.length})</p>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>Revisalas y confirmá. Nada queda conciliado hasta que tocás "Confirmar".</p>
          {suggestions.filter((s) => s.kind !== "day_total_fee").length > 1 && (
            <button
              className="secondary"
              disabled={busy}
              style={{ marginBottom: 10 }}
              onClick={() =>
                run(async () => {
                  for (const s of suggestions.filter((x) => x.kind !== "day_total_fee")) await confirmBankMatch(s.lineId, s.movementIds, 0);
                  setMessage("Listo: confirmadas las que coincidían exacto.");
                  await reload();
                })
              }
            >
              Confirmar todas las exactas
            </button>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            {suggestions.map((s) => {
              const line = lineById.get(s.lineId);
              if (!line) return null;
              const movs = s.movementIds.map((id) => movementById.get(id)).filter((m): m is AccountMovement => Boolean(m));
              const days = Array.from(new Set(movs.map((m) => fmtDate(m.date))));
              return (
                <div key={s.lineId} style={{ background: "#f8f9fb", borderRadius: 8, padding: 10 }}>
                  <div><strong>Banco {fmtDate(line.date)}</strong> · {line.description} · <strong>{fmt(line.amount)}</strong></div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {movs.length === 1
                      ? `↔ ${MOVEMENT_LABELS[movs[0].movementType] ?? movs[0].movementType} del ${fmtDate(movs[0].date)} por ${fmt(movs[0].amount)}${movs[0].notes ? ` (${movs[0].notes})` : ""}`
                      : `↔ ${movs.length} ventas del ${days.join(", ")} que suman ${fmt(s.movementsTotal)}`}
                    {s.fee > 0 && <> · <strong style={{ color: "#8a4b00" }}>diferencia {fmt(s.fee)}: se carga como comisión y retenciones del banco</strong></>}
                  </div>
                  <div className="cash-banner-form" style={{ marginTop: 6 }}>
                    <button disabled={busy} onClick={() => run(async () => { await confirmBankMatch(s.lineId, s.movementIds, s.fee); await reload(); })}>Confirmar</button>
                    <button className="secondary" onClick={() => startLinking(line)}>Elegir otros</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. En el banco y no en el sistema */}
      <div style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 16, marginTop: 16 }}>
        <p style={{ margin: "0 0 8px", fontWeight: 700 }}>3. Están en el banco y no en el sistema ({bankOnly.length})</p>
        <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
          Comisiones, impuestos, débitos automáticos o plata que entró y no se cargó. Cargalos en Tesorería con un botón, vinculalos a mano o ignoralos si no corresponden.
        </p>
        {bankOnly.length === 0 && <p className="muted">Nada pendiente.</p>}
        <div style={{ display: "grid", gap: 8 }}>
          {bankOnly.map((line) => {
            const category = categoryByLine[line.id] ?? guessCategory(line.description);
            return (
              <div key={line.id} style={{ background: "#f8f9fb", borderRadius: 8, padding: 10 }}>
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
                  <button
                    disabled={busy || !branchId}
                    onClick={() => run(async () => { await createMovementFromBankLine(line.id, branchId!, category, line.description); await reload(); })}
                  >
                    {line.amount < 0 ? "Cargar como gasto" : "Cargar como ingreso"}
                  </button>
                  <button className="secondary" onClick={() => startLinking(line)}>Vincular a mano</button>
                  <button className="secondary" disabled={busy} onClick={() => run(async () => { await setBankLineIgnored(line.id, true); await reload(); })}>Ignorar</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Vincular a mano */}
      {linkingLineId && lineById.get(linkingLineId) && (() => {
        const line = lineById.get(linkingLineId)!;
        const candidates = freeMovements
          .filter((m) => (line.amount > 0 ? m.direction === "in" : m.direction === "out"))
          .sort((a, b) => Math.abs(daysWaiting(a.date, line.date)) - Math.abs(daysWaiting(b.date, line.date)));
        const total = Array.from(selectedIds).reduce((sum, id) => sum + (movementById.get(id)?.amount ?? 0), 0);
        const target = Math.abs(line.amount);
        const diff = Math.round((total - target) * 100) / 100;
        const canConfirm = selectedIds.size > 0 && (line.amount > 0 ? diff >= 0 : diff === 0);
        return (
          <div style={{ border: "2px solid #d9c9f5", borderRadius: 10, padding: 16, marginTop: 16 }}>
            <p style={{ margin: "0 0 6px", fontWeight: 700 }}>Vincular a mano: {fmtDate(line.date)} · {line.description} · {fmt(line.amount)}</p>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
              Tildá los movimientos de Tesorería que corresponden a esta línea del banco.
              {line.amount > 0 && " Si el banco depositó menos (comisión de la tarjeta), la diferencia se carga como comisión y retenciones."}
            </p>
            <div style={{ maxHeight: 280, overflowY: "auto", display: "grid", gap: 4 }}>
              {candidates.slice(0, 300).map((m) => (
                <label key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(m.id)}
                    onChange={(e) => {
                      const next = new Set(selectedIds);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      setSelectedIds(next);
                    }}
                  />
                  {fmtDate(m.date)} · {MOVEMENT_LABELS[m.movementType] ?? m.movementType} · {fmt(m.amount)} {m.notes && <span className="muted">({m.notes.slice(0, 60)})</span>}
                </label>
              ))}
              {candidates.length === 0 && <p className="muted">No hay movimientos sin conciliar para vincular.</p>}
            </div>
            <p style={{ margin: "10px 0" }}>
              Elegidos: <strong>{fmt(total)}</strong> · Banco: <strong>{fmt(target)}</strong>
              {selectedIds.size > 0 && diff !== 0 && (
                <> · {diff > 0 && line.amount > 0 ? <span style={{ color: "#8a4b00" }}>comisión {fmt(diff)}</span> : <span className="num-negative">no cierra por {fmt(Math.abs(diff))}</span>}</>
              )}
            </p>
            <div className="cash-banner-form">
              <button
                disabled={busy || !canConfirm}
                onClick={() =>
                  run(async () => {
                    await confirmBankMatch(line.id, Array.from(selectedIds), line.amount > 0 ? Math.max(0, diff) : 0);
                    setLinkingLineId(null);
                    await reload();
                  })
                }
              >
                Confirmar
              </button>
              <button className="secondary" onClick={() => setLinkingLineId(null)}>Cancelar</button>
            </div>
          </div>
        );
      })()}

      {/* 4. En el sistema y no en el banco */}
      <div style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 16, marginTop: 16 }}>
        <p style={{ margin: "0 0 8px", fontWeight: 700 }}>4. Están en el sistema y todavía no en el banco ({systemOnly.length})</p>
        <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
          Normalmente son ventas con tarjeta que el banco todavía no acreditó (pueden tardar hasta unos 18 días hábiles), o algo que se cargó en la cuenta equivocada.
        </p>
        {systemOnly.length === 0 && <p className="muted">Nada pendiente.</p>}
        {systemOnly.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th className="num">Importe</th><th className="num">Días esperando</th></tr>
              </thead>
              <tbody>
                {systemOnly.map((m) => {
                  const waiting = daysWaiting(m.date, todayIso());
                  return (
                    <tr key={m.id}>
                      <td>{fmtDate(m.date)}</td>
                      <td>{MOVEMENT_LABELS[m.movementType] ?? m.movementType}</td>
                      <td className="muted">{m.notes ?? ""}</td>
                      <td className={`num ${m.direction === "out" ? "num-negative" : "num-positive"}`}>{fmt(m.direction === "out" ? -m.amount : m.amount)}</td>
                      <td className="num" style={{ color: waiting > 30 ? "#8a1f11" : undefined }}>{waiting}</td>
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
          <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
            {matchedLines.map((line) => (
              <div key={line.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
                <span>✓ {fmtDate(line.date)} · {line.description} · {fmt(line.amount)}</span>
                <span className="muted">({line.movementIds.length} mov.{line.createdMovementId ? ", con movimiento creado desde el banco" : ""})</span>
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
    </div>
  );
}
