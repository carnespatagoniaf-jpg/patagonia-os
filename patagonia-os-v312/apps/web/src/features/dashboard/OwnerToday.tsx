import { useEffect, useState } from "react";
import { Store } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { formatMoney } from "../shifts/format";
import { ownerTodayLines, ownerTodayTotal, visibleBranches, type OwnerTodayRow } from "./owner-today";

/**
 * "Hoy en tus locales" arriba de Inicio, solo dueño/administrador (migración 186): cada sucursal con lo vendido hoy,
 * la caja, los cierres y las anuladas, para mirarlo desde el celular. Si la consulta falla (por ejemplo, antes de la
 * migración) no muestra nada.
 */
export function OwnerToday() {
  const [rows, setRows] = useState<OwnerTodayRow[] | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    const load = () =>
      void supabase!.rpc("owner_today").then(({ data, error }) => {
        if (cancelled || error || !Array.isArray(data)) return;
        setRows(
          (data as Record<string, unknown>[]).map((r) => ({
            branchId: String(r.branch_id),
            branchName: String(r.branch_name ?? ""),
            isVehicle: r.is_vehicle === true,
            salesTotal: Number(r.sales_total ?? 0),
            salesCount: Number(r.sales_count ?? 0),
            lastSaleAt: (r.last_sale_at as string | null) ?? null,
            voidedCount: Number(r.voided_count ?? 0),
            voidedTotal: Number(r.voided_total ?? 0),
            openSince: (r.open_since as string | null) ?? null,
            openCashier: (r.open_cashier as string | null) ?? null,
            closesToday: Number(r.closes_today ?? 0),
            closeDifference: r.close_difference === null || r.close_difference === undefined ? null : Number(r.close_difference)
          }))
        );
      });
    load();
    // Se actualiza sola cada 2 minutos mientras Inicio está abierto.
    const timer = window.setInterval(load, 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!rows) return null;
  const shown = visibleBranches(rows);
  if (shown.length === 0) return null;
  const total = ownerTodayTotal(shown);

  return (
    <section className="panel owner-today">
      <div className="panel-title">
        <h2><Store size={18} /> Hoy en tus locales</h2>
        {shown.length > 1 && <strong>{formatMoney(total.total)}</strong>}
      </div>
      <ul>
        {shown.map((r) => (
          <li key={r.branchId}>
            <div className="owner-today-head">
              <strong>{r.branchName}</strong>
              <span>
                {formatMoney(r.salesTotal)}
                <span className="muted"> · {r.salesCount === 1 ? "1 venta" : `${r.salesCount} ventas`}</span>
              </span>
            </div>
            {ownerTodayLines(r).map((l) => (
              <p key={l.text} className={`owner-today-line ${l.tone}`}>{l.text}</p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
