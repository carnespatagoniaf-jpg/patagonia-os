import { Fragment, useEffect, useState } from "react";
import { addDaysIso, todayIso } from "../shifts/format";
import { listCompanyUsers, type CompanyUser } from "../users/users-service";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuditLog } from "./useAuditLog";
import type { AuditLogEntry } from "./audit-service";

const ACTION_LABELS: Record<string, string> = {
  "cash_session.close": "Cierre de caja",
  "cash_session.open": "Apertura de caja",
  "client.create": "Alta de cliente",
  "creditor_payment.create": "Pago a deuda",
  "employee.create": "Alta de empleado",
  "employee.update": "Edición de empleado",
  "payroll_adjustment.create": "Alta de ajuste de sueldo",
  "payroll_adjustment.delete": "Baja de ajuste de sueldo",
  "payroll_liquidation.close": "Cierre de liquidación",
  "product.create": "Alta de producto",
  "product.update": "Edición de producto",
  "profitability_period.close": "Cierre de período de rentabilidad",
  "purchase.create": "Alta de compra",
  "purchase_item.update": "Edición de ítem de compra",
  "sale.create": "Venta",
  "shift.save": "Carga de turno",
  "shift_outflow.delete": "Baja de salida de turno",
  "shift_outflow.save": "Carga de salida de turno",
  "shift_sale.delete": "Baja de venta de turno",
  "shift_sale.save": "Carga de venta de turno",
  "stock.adjust": "Ajuste de stock",
  "supplier.create": "Alta de proveedor",
  "supplier_payment.create": "Pago a proveedor",
  "treasury.transfer": "Transferencia entre cuentas",
  "treasury_account.adjust": "Ajuste de cuenta",
  "treasury_account.create": "Alta de cuenta",
  "user.create": "Alta de usuario",
  "user.update": "Edición de usuario"
};

function actionLabel(action: string) {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("es-AR");
}

export function AuditLog() {
  const { branches } = useActiveBranch();
  const { rows, loading, error, load } = useAuditLog();

  const [from, setFrom] = useState(addDaysIso(todayIso(), -6));
  const [to, setTo] = useState(todayIso());
  const [userId, setUserId] = useState("");
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    void listCompanyUsers().then(setUsers);
  }, []);

  useEffect(() => {
    void load({ from, to, userId: userId || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function runSearch(nextFrom: string, nextTo: string, nextUserId: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    setUserId(nextUserId);
    void load({ from: nextFrom, to: nextTo, userId: nextUserId || undefined });
  }

  function userName(id: string | null) {
    if (!id) return "—";
    return users.find((u) => u.id === id)?.fullName ?? "Usuario eliminado";
  }

  function branchName(id: string | null) {
    if (!id) return "—";
    return branches.find((b) => b.id === id)?.name ?? "—";
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">AUDITORÍA</p>
          <h1>Historial de acciones</h1>
          <p className="muted">Quién hizo qué y cuándo — ventas, ajustes de stock, pagos, altas de usuario, etc.</p>
        </div>
      </header>

      <section className="panel">
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Todos los usuarios</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.fullName}</option>
            ))}
          </select>
          <button onClick={() => runSearch(from, to, userId)}>Buscar</button>
          <button className="secondary" onClick={() => runSearch(todayIso(), todayIso(), userId)}>Hoy</button>
          <button className="secondary" onClick={() => runSearch(addDaysIso(todayIso(), -6), todayIso(), userId)}>Esta semana</button>
          <button className="secondary" onClick={() => runSearch(addDaysIso(todayIso(), -29), todayIso(), userId)}>Este mes</button>
        </div>

        {error && <div className="message warning">{error}</div>}

        <table className="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Usuario</th>
              <th>Acción</th>
              <th>Sucursal</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry: AuditLogEntry) => (
              <Fragment key={entry.id}>
                <tr>
                  <td>{formatDateTime(entry.createdAt)}</td>
                  <td>{userName(entry.userId)}</td>
                  <td>{actionLabel(entry.action)}</td>
                  <td>{branchName(entry.branchId)}</td>
                  <td>
                    <button className="secondary" onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}>
                      {expandedId === entry.id ? "Ocultar" : "Detalle"}
                    </button>
                  </td>
                </tr>
                {expandedId === entry.id && (
                  <tr>
                    <td colSpan={5}>
                      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
                        {JSON.stringify({ entity_type: entry.entityType, entity_id: entry.entityId, old_data: entry.oldData, new_data: entry.newData }, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !loading && <p className="muted">No hay actividad registrada en ese rango.</p>}
        {loading && <p className="muted">Cargando…</p>}
      </section>
    </>
  );
}
