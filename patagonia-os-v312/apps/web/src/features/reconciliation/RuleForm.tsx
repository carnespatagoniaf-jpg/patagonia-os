import { useState } from "react";
import { findRule, normalizeBankText, suggestRuleText, type RuleAction } from "./reconcile-match";
import {
  applyReconRules,
  createCustomerPaymentFromBankLine,
  createMovementFromBankLine,
  createMovementsFromBankLines,
  saveReconRule,
  setBankLineIgnored,
  type StoredBankLine
} from "./reconciliation-service";

/**
 * "¿Qué es esto?" para una línea (o un grupo de líneas iguales) que está en el
 * banco y no en el sistema: gasto, ingreso, cobro de un cliente o ignorar, y
 * opcionalmente recordarlo como regla para los próximos resúmenes (migración 106).
 */

export const EXPENSE_CATEGORIES: { value: string; label: string }[] = [
  { value: "otro", label: "Comisiones y otros" },
  { value: "impuestos", label: "Impuestos" },
  { value: "servicios", label: "Servicios" },
  { value: "mantenimiento", label: "Mantenimiento" },
  { value: "insumos", label: "Insumos" }
];

export const ACTION_LABELS: Record<RuleAction, string> = {
  expense: "Gasto",
  income: "Ingreso (ajuste)",
  customer: "Cobro de un cliente (baja su deuda)",
  ignore: "Ignorar"
};

interface Props {
  reconId: string;
  branchId: string | null;
  /** Las líneas elegidas (una o un grupo), todas del mismo sentido. */
  lines: StoredBankLine[];
  /** Todo lo que está en el banco y no en el sistema: si se guarda la regla, se aplica también a las demás que coincidan. */
  bankOnly: StoredBankLine[];
  customers: { id: string; name: string }[];
  defaultCategory: string;
  onDone: (message: string) => void | Promise<void>;
  onCancel: () => void;
}

export function RuleForm({ reconId, branchId, lines, bankOnly, customers, defaultCategory, onDone, onCancel }: Props) {
  const incoming = lines[0]?.amount > 0;
  const [text, setText] = useState(() => suggestRuleText(lines[0]?.description ?? ""));
  const [action, setAction] = useState<RuleAction>(incoming ? "income" : "expense");
  const [category, setCategory] = useState(defaultCategory);
  const [customerId, setCustomerId] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const normalized = normalizeBankText(text);
  const direction = incoming ? "in" : "out";
  const probe = { id: "probe", matchText: normalized, direction, action, category: null, customerId: null } as const;
  const textFitsAll = normalized.length >= 3 && lines.every((l) => findRule(l, [probe]) !== null);
  const alsoMatching = remember && textFitsAll ? bankOnly.filter((l) => !lines.some((x) => x.id === l.id) && findRule(l, [probe]) !== null) : [];
  const actions: RuleAction[] = incoming ? ["income", "customer", "ignore"] : ["expense", "ignore"];
  const canSubmit = !busy && Boolean(branchId) && (action !== "customer" || customerId !== "") && (!remember || textFitsAll);

  async function submit() {
    if (!branchId) return;
    setBusy(true);
    setError("");
    try {
      if (remember) {
        const ruleId = await saveReconRule(reconId, {
          matchText: normalized,
          direction,
          action,
          category: action === "expense" ? category : null,
          customerId: action === "customer" ? customerId : null
        });
        const targets = [...lines, ...alsoMatching];
        const n = await applyReconRules(targets.map((l) => ({ lineId: l.id, ruleId })), branchId);
        await onDone(`Regla guardada ("${normalized}"): ${n} ${n === 1 ? "línea cargada" : "líneas cargadas"}. Los próximos resúmenes la usan solos.`);
        return;
      }
      if (action === "customer") {
        for (const l of lines) await createCustomerPaymentFromBankLine(l.id, customerId, branchId);
      } else if (action === "ignore") {
        for (const l of lines) await setBankLineIgnored(l.id, true);
      } else if (lines.length > 1 && action === "expense") {
        await createMovementsFromBankLines(lines.map((l) => l.id), branchId, category);
      } else {
        for (const l of lines) await createMovementFromBankLine(l.id, branchId, action === "expense" ? category : "otro", l.description);
      }
      await onDone(`Listo: ${lines.length} ${lines.length === 1 ? "línea cargada" : "líneas cargadas"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "2px solid #d9c9f5", borderRadius: 10, padding: 12, marginTop: 8, background: "#fff" }}>
      <p style={{ margin: "0 0 8px", fontWeight: 600 }}>¿Qué es{lines.length > 1 ? ` (las ${lines.length})` : ""}?</p>
      <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
        <select value={action} onChange={(e) => setAction(e.target.value as RuleAction)}>
          {actions.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
        </select>
        {action === "expense" && (
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        )}
        {action === "customer" && (
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Elegí el cliente…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>
      {action === "customer" && customers.length === 0 && (
        <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>No hay clientes cargados. Crealo primero en Clientes.</p>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Recordar como regla: cuando el banco diga
        <input value={text} onChange={(e) => setText(e.target.value)} disabled={!remember} style={{ minWidth: 200 }} />
      </label>
      {remember && !textFitsAll && (
        <p className="num-negative" style={{ fontSize: 13, margin: "6px 0 0" }}>Ese texto no aparece tal cual en {lines.length > 1 ? "todas las líneas" : "la línea"}. Copialo del detalle del banco.</p>
      )}
      {remember && textFitsAll && (
        <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
          Un CUIT sirve para una persona o empresa en particular; un texto como "IMPUESTO CREDITO" para todos los iguales.
          {alsoMatching.length > 0 && <> Se aplica también a <strong>{alsoMatching.length}</strong> {alsoMatching.length === 1 ? "línea más" : "líneas más"} de este período.</>}
        </p>
      )}
      {error && <p className="num-negative" style={{ margin: "8px 0 0" }}>{error}</p>}
      <div className="cash-banner-form" style={{ marginTop: 10 }}>
        <button disabled={!canSubmit} onClick={() => void submit()}>{busy ? "Cargando…" : remember ? "Guardar regla y cargar" : "Cargar"}</button>
        <button className="secondary" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}
