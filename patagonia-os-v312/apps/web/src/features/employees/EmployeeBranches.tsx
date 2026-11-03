import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { formatMoney, startOfMonthIso, todayIso } from "../shifts/format";

// Empleados que rotan entre locales (plan Empresa, migración 191): en qué otros locales puede abrir caja con su
// PIN, y dónde trabajó este mes. El sueldo y los vales siguen en su local principal.

interface Activity {
  branchId: string;
  shifts: number;
  salesTotal: number;
}

export function EmployeeBranches({ employee }: { employee: { id: string; branchId: string; fullName: string } }) {
  const { branches } = useActiveBranch();
  const [extra, setExtra] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void supabase
      .from("employee_branches")
      .select("branch_id")
      .eq("employee_id", employee.id)
      .then(({ data }) => {
        if (cancelled) return;
        const ids = ((data ?? []) as Array<{ branch_id: string }>).map((r) => r.branch_id);
        setExtra(ids);
        setSaved(ids);
      });
    void supabase
      .rpc("employee_branch_activity", { p_employee_id: employee.id, p_from: startOfMonthIso(todayIso()), p_to: todayIso() })
      .then(({ data }) => {
        if (cancelled) return;
        setActivity(((data ?? []) as Array<{ branch_id: string; shifts: number; sales_total: number | string }>).map((r) => ({ branchId: r.branch_id, shifts: r.shifts, salesTotal: Number(r.sales_total) })));
      });
    return () => {
      cancelled = true;
    };
  }, [employee.id]);

  async function save() {
    if (!supabase) return;
    setBusy(true);
    setMessage("");
    const { error } = await supabase.rpc("set_employee_branches", { p_employee_id: employee.id, p_branch_ids: extra });
    setBusy(false);
    if (error) return setMessage(error.message);
    setSaved(extra);
    setMessage(extra.length > 0 ? "Listo: su PIN vale también en esos locales." : "Listo: abre caja solo en su local.");
  }

  const name = (id: string) => branches.find((b) => b.id === id)?.name ?? "Local";
  const others = branches.filter((b) => b.id !== employee.branchId);
  const changed = extra.slice().sort().join(",") !== saved.slice().sort().join(",");
  const total = activity.reduce((acc, a) => ({ shifts: acc.shifts + a.shifts, sales: acc.sales + a.salesTotal }), { shifts: 0, sales: 0 });

  if (others.length === 0) return null;
  return (
    <div className="emp-branches">
      <p className="muted" style={{ margin: "12px 0 6px", fontSize: 13 }}>
        Local principal: <b>{name(employee.branchId)}</b> (ahí cobra el sueldo y los vales). También puede abrir caja en:
      </p>
      <div className="row-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        {others.map((b) => (
          <label key={b.id} className="transfers-check">
            <input type="checkbox" checked={extra.includes(b.id)} onChange={(e) => setExtra((list) => (e.target.checked ? [...list, b.id] : list.filter((id) => id !== b.id)))} /> {b.name}
          </label>
        ))}
        <button className="secondary" disabled={busy || !changed} onClick={() => void save()}>
          {busy ? "Guardando…" : "Guardar locales"}
        </button>
      </div>
      {message && <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{message}</p>}
      {activity.length > 0 && (
        <table className="data-table no-stack" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Dónde trabajó este mes</th>
              <th className="num">Turnos</th>
              <th className="num">Vendió</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((a) => (
              <tr key={a.branchId}>
                <td>{name(a.branchId)}</td>
                <td className="num">{a.shifts}</td>
                <td className="num">{formatMoney(a.salesTotal)}</td>
              </tr>
            ))}
            {activity.length > 1 && (
              <tr>
                <td><b>Total</b></td>
                <td className="num"><b>{total.shifts}</b></td>
                <td className="num"><b>{formatMoney(total.sales)}</b></td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
