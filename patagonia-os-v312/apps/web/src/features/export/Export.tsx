import { useState } from "react";
import { Download } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { can } from "../auth/permissions";
import { useActiveBranch } from "../branches/BranchProvider";
import { useShifts } from "../shifts/useShifts";
import { useTreasury } from "../shifts/useTreasury";
import { addDaysIso, todayIso } from "../shifts/format";
import { listPosSalesInRange } from "../sale/pos-shift-service";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listCustomersWithBalance } from "../customers/customers-service";
import { downloadCsv, toCsv } from "../../lib/csv";

export function Export() {
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();
  const { accounts } = useTreasury();
  const { loadRange } = useShifts();

  const [from, setFrom] = useState(addDaysIso(todayIso(), -29));
  const [to, setTo] = useState(todayIso());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function exportSales() {
    if (!branchId) return;
    setBusy("sales");
    setMessage("");
    try {
      const [shiftRows, mostrador] = await Promise.all([loadRange(from, to), listPosSalesInRange(branchId, from, to)]);
      const rows: (string | number)[][] = [];
      for (const row of shiftRows) {
        for (const sale of row.sales) {
          const accountName = accounts.find((a) => a.id === sale.accountId)?.name ?? "-";
          rows.push([row.shift.shiftDate, "Turnos", accountName, sale.amount]);
        }
      }
      for (const sale of mostrador) {
        const accountName = accounts.find((a) => a.id === sale.accountId)?.name ?? "-";
        rows.push([sale.date, "Mostrador", accountName, sale.amount]);
      }
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      const csv = toCsv(["Fecha", "Origen", "Cuenta", "Monto"], rows);
      downloadCsv(`ventas_${from}_a_${to}.csv`, csv);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo exportar las ventas.");
    } finally {
      setBusy(null);
    }
  }

  async function exportProducts() {
    if (!branchId) return;
    setBusy("products");
    setMessage("");
    try {
      const products = await listProductsForBranch(branchId);
      const rows = products.map((p) => [p.code, p.name, p.unit, p.priceRetail, p.cost, p.stock, p.minStock]);
      const csv = toCsv(["Código", "Nombre", "Unidad", "Precio venta", "Costo", "Stock actual", "Stock mínimo"], rows);
      downloadCsv(`productos_y_stock_${todayIso()}.csv`, csv);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo exportar productos.");
    } finally {
      setBusy(null);
    }
  }

  async function exportCustomers() {
    setBusy("customers");
    setMessage("");
    try {
      const customers = await listCustomersWithBalance();
      const rows = customers.map((c) => [c.name, c.phone ?? "-", c.balance]);
      const csv = toCsv(["Nombre", "Teléfono", "Saldo"], rows);
      downloadCsv(`clientes_${todayIso()}.csv`, csv);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo exportar clientes.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">EXPORTAR</p>
          <h1>Exportar datos</h1>
          <p className="muted">Descargá tu información en Excel/CSV — para respaldo, o para llevártela si alguna vez lo necesitás.</p>
        </div>
      </header>

      {message && <div className="message warning">{message}</div>}

      <section className="panel">
        <div className="panel-title">
          <h2>Ventas</h2>
        </div>
        <p className="muted" style={{ marginBottom: 14 }}>Turnos + Mostrador combinados, una fila por venta y cuenta.</p>
        <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button disabled={busy === "sales"} onClick={exportSales}>
            <Download size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
            {busy === "sales" ? "Generando…" : "Descargar CSV"}
          </button>
        </div>
      </section>

      {can(profile, "inventory.view") && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Productos y stock</h2>
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>Catálogo completo con precio, costo y stock actual de esta sucursal.</p>
          <div className="cash-banner-form">
            <button disabled={busy === "products"} onClick={exportProducts}>
              <Download size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
              {busy === "products" ? "Generando…" : "Descargar CSV"}
            </button>
          </div>
        </section>
      )}

      {can(profile, "customers.manage") && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Clientes</h2>
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>Cuenta corriente de todos los clientes, con el saldo actual.</p>
          <div className="cash-banner-form">
            <button disabled={busy === "customers"} onClick={exportCustomers}>
              <Download size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
              {busy === "customers" ? "Generando…" : "Descargar CSV"}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
