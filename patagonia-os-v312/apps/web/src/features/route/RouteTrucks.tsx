import { useCallback, useEffect, useMemo, useState } from "react";
import type { Product, TreasuryAccount } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { quantityNumber } from "../sale/quantity";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listTreasuryAccounts } from "../shifts/treasury-service";
import { formatQty, money } from "./route-logic";
import {
  createVehicle,
  getVehicleStatus,
  listBranchesSplit,
  listSettlements,
  loadVehicle,
  settleVehicle,
  type Depot,
  type SettleResult,
  type Settlement,
  type Vehicle,
  type VehicleStatus
} from "./route-service";

/** Camiones (venta en ruta, migración 161): crear, cargar desde el depósito y rendir al volver. Dueño/admin. */
export function RouteTrucks() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [depots, setDepots] = useState<Depot[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [depotId, setDepotId] = useState("");
  const [status, setStatus] = useState<VehicleStatus | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<"none" | "load" | "settle">("none");

  const loadBranches = useCallback(async () => {
    const { vehicles: v, depots: d } = await listBranchesSplit();
    setVehicles(v);
    setDepots(d);
    setVehicleId((cur) => cur || v[0]?.id || "");
    setDepotId((cur) => cur || d[0]?.id || "");
  }, []);

  const loadStatus = useCallback(async (id: string) => {
    if (!id) return;
    const [s, list] = await Promise.all([getVehicleStatus(id), listSettlements(id)]);
    setStatus(s);
    setSettlements(list);
  }, []);

  useEffect(() => {
    void loadBranches().catch((err) => setMessage(err instanceof Error ? err.message : "No se pudieron leer los camiones."));
  }, [loadBranches]);

  useEffect(() => {
    setStatus(null);
    setMode("none");
    void loadStatus(vehicleId).catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
  }, [vehicleId, loadStatus]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const id = await createVehicle(newName.trim());
      setNewName("");
      await loadBranches();
      setVehicleId(id);
      setMessage(`Camión creado, con su cuenta "Efectivo ${newName.trim()}". Para cada vendedor: Usuarios → nuevo usuario Cajero con sucursal "${newName.trim()}".`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el camión.");
    } finally {
      setBusy(false);
    }
  }

  const vehicle = vehicles.find((v) => v.id === vehicleId);
  const stockValue = status?.stock.reduce((sum, s) => sum + s.stock * s.price, 0) ?? 0;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel">
        <div className="panel-title">
          <h2>Camiones</h2>
          <span className="muted" style={{ fontSize: 13 }}>Cada camión tiene su stock y su efectivo. Los vendedores venden desde "Venta en ruta" en el celular.</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {vehicles.map((v) => (
            <button key={v.id} className={v.id === vehicleId ? "" : "secondary"} onClick={() => setVehicleId(v.id)}>{v.name}</button>
          ))}
          <input placeholder="Nombre (ej. Camión 1)" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: 180 }} />
          <button className="secondary" disabled={busy || !newName.trim()} onClick={() => void handleCreate()}>+ Nuevo camión</button>
        </div>
        {message && <p style={{ marginBottom: 0 }}>{message}</p>}
      </section>

      {vehicle && status && (
        <section className="panel">
          <div className="panel-title">
            <h2>{vehicle.name}</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className={mode === "load" ? "" : "secondary"} onClick={() => setMode(mode === "load" ? "none" : "load")}>Cargar camión</button>
              <button className={mode === "settle" ? "" : "secondary"} onClick={() => setMode(mode === "settle" ? "none" : "settle")}>Rendir (vuelve el camión)</button>
            </div>
          </div>
          <div className="totals" style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 10 }}>
            <span>{status.since ? "Ventas desde la última rendición" : "Ventas"}: <b>{status.sales.count}</b> por <b>{money(status.sales.total)}</b></span>
            <span>Cobrado en el momento: <b>{money(status.sales.paid)}</b></span>
            <span>A cuenta corriente: <b>{money(Math.max(status.sales.total - status.sales.paid, 0))}</b></span>
            {status.accounts.map((a) => <span key={a.id}>{a.name}: <b>{money(a.balance)}</b></span>)}
          </div>
          {mode === "load" && (
            <LoadForm vehicleId={vehicle.id} depots={depots} depotId={depotId} setDepotId={setDepotId} onDone={(text) => { setMode("none"); setMessage(text); void loadStatus(vehicle.id); }} />
          )}
          {mode === "settle" && (
            <SettleForm vehicle={vehicle} status={status} depots={depots} depotId={depotId} setDepotId={setDepotId} onDone={() => { void loadStatus(vehicle.id); }} />
          )}
          {mode === "none" && (
            <>
              <h3>En el camión ahora</h3>
              {status.stock.length === 0 ? (
                <p className="muted">Vacío. Usá "Cargar camión" para pasarle mercadería del depósito.</p>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Producto</th><th className="num">Cantidad</th><th className="num">A precio de venta</th></tr></thead>
                  <tbody>
                    {status.stock.map((s) => (
                      <tr key={s.productId}>
                        <td>{s.name}</td>
                        <td className="num" style={s.stock < 0 ? { color: "#b42318" } : undefined}>{formatQty(s.stock, s.unit)}</td>
                        <td className="num">{money(s.stock * s.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={2}><b>Total</b></td><td className="num"><b>{money(stockValue)}</b></td></tr></tfoot>
                </table>
              )}
            </>
          )}
        </section>
      )}

      {vehicle && settlements.length > 0 && (
        <section className="panel">
          <h3 style={{ marginTop: 0 }}>Rendiciones de {vehicle.name}</h3>
          <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Fecha</th><th className="num">Ventas</th><th className="num hide-md">A cuenta</th><th className="num hide-sm">Efectivo esperado</th><th className="num hide-sm">Contado</th><th className="num">Diferencia</th><th className="num">Mercadería faltante (costo)</th></tr>
            </thead>
            <tbody>
              {settlements.map((s) => (
                <tr key={s.id} title={s.notes ?? undefined}>
                  <td>{new Date(s.createdAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false, dateStyle: "short", timeStyle: "short" })}</td>
                  <td className="num">{s.salesCount} · {money(s.salesTotal)}</td>
                  <td className="num hide-md">{money(s.onAccount)}</td>
                  <td className="num hide-sm">{money(s.cashExpected)}</td>
                  <td className="num hide-sm">{money(s.cashCounted)}</td>
                  <td className="num" style={{ color: s.cashDifference < 0 ? "#b42318" : undefined }}>{money(s.cashDifference)}</td>
                  <td className="num" style={{ color: s.missingValue > 0 ? "#b42318" : undefined }}>{money(s.missingValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      )}
    </div>
  );
}

function DepotPicker({ depots, depotId, setDepotId, label }: { depots: Depot[]; depotId: string; setDepotId: (id: string) => void; label: string }) {
  if (depots.length <= 1) return null;
  return (
    <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {label}
      <select value={depotId} onChange={(e) => setDepotId(e.target.value)}>
        {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </label>
  );
}

function LoadForm({ vehicleId, depots, depotId, setDepotId, onDone }: {
  vehicleId: string;
  depots: Depot[];
  depotId: string;
  setDepotId: (id: string) => void;
  onDone: (message: string) => void;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!depotId) return;
    // Presentaciones no: su stock es el del principal (se carga el principal).
    void listProductsForBranch(depotId).then((list) => setProducts(list.filter((p) => !p.stockSourceId))).catch(() => setProducts([]));
  }, [depotId]);

  const chosen = products.filter((p) => quantityNumber(qty[p.id] ?? "") > 0);
  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () => products.filter((p) => quantityNumber(qty[p.id] ?? "") > 0 || !q || p.name.toLowerCase().includes(q) || p.code === search.trim()),
    [products, qty, q, search]
  );

  async function handleLoad() {
    setBusy(true);
    setError("");
    try {
      const count = await loadVehicle(vehicleId, depotId, chosen.map((p) => ({ productId: p.id, quantity: quantityNumber(qty[p.id] ?? "") })));
      onDone(`Camión cargado: ${count} producto(s) pasaron del depósito al camión.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Cargar camión</h3>
      <DepotPicker depots={depots} depotId={depotId} setDepotId={setDepotId} label="Sale del depósito" />
      <input placeholder="Buscar producto…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 360 }} />
      <div style={{ maxHeight: 420, overflow: "auto" }}>
        <table className="data-table">
          <thead><tr><th>Producto</th><th className="num">En depósito</th><th className="num">Carga</th></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num">{formatQty(p.stock, p.unit === "kg" ? "kg" : "unit")}</td>
                <td className="num">
                  <input type="text" inputMode="decimal" value={qty[p.id] ?? ""} onChange={(e) => setQty({ ...qty, [p.id]: e.target.value })} style={{ width: 90, textAlign: "right" }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p style={{ color: "#b42318", margin: 0 }}>{error}</p>}
      <div>
        <button disabled={busy || chosen.length === 0} onClick={() => void handleLoad()}>
          {busy ? "Cargando…" : `Cargar ${chosen.length} producto(s) al camión`}
        </button>
      </div>
    </div>
  );
}

function SettleForm({ vehicle, status, depots, depotId, setDepotId, onDone }: {
  vehicle: Vehicle;
  status: VehicleStatus;
  depots: Depot[];
  depotId: string;
  setDepotId: (id: string) => void;
  onDone: () => void;
}) {
  // Por defecto vuelve todo lo que tiene el camión; se corrige lo que no volvió.
  const [returned, setReturned] = useState<Record<string, string>>(() =>
    Object.fromEntries(status.stock.map((s) => [s.productId, s.stock > 0 ? String(s.stock).replace(".", ",") : "0"]))
  );
  const cash = status.accounts.find((a) => a.cash);
  const [cashText, setCashText] = useState("");
  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const [destId, setDestId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SettleResult | null>(null);

  useEffect(() => {
    void listTreasuryAccounts(depotId).then((list) => {
      const options = list.filter((a) => a.branchId !== vehicle.id && !a.isSafe);
      setAccounts(options);
      setDestId((cur) => cur || options.find((a) => a.paymentMethod === "cash")?.id || options[0]?.id || "");
    }).catch(() => setAccounts([]));
  }, [depotId, vehicle.id]);

  const counted = cashText.trim() === "" ? NaN : parseAmount(cashText);
  const expected = cash?.balance ?? 0;
  const missingValue = status.stock.reduce((sum, s) => sum + Math.max(s.stock - quantityNumber(returned[s.productId] ?? ""), 0) * s.cost, 0);

  async function handleSettle() {
    if (!(counted >= 0)) {
      setError("Poné la plata que contaste (0 si no trajo nada).");
      return;
    }
    if (!window.confirm(`¿Rendir ${vehicle.name}? La mercadería que vuelve pasa al depósito, lo que falta queda como faltante y la plata pasa a la cuenta elegida.`)) return;
    setBusy(true);
    setError("");
    try {
      const r = await settleVehicle({
        vehicleId: vehicle.id,
        depotId,
        returns: status.stock.map((s) => ({ productId: s.productId, quantity: quantityNumber(returned[s.productId] ?? "") })).filter((x) => x.quantity > 0),
        cashCounted: counted,
        destAccountId: counted > 0 ? destId : null,
        notes
      });
      setResult(r);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo rendir.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0 }}>Rendición hecha</h3>
        <span>Ventas: {result.salesCount} por {money(result.salesTotal)}</span>
        <span>Efectivo esperado {money(result.cashExpected)} · contado {money(result.cashCounted)} · diferencia <b style={{ color: result.cashDifference < 0 ? "#b42318" : undefined }}>{money(result.cashDifference)}</b></span>
        <span>Mercadería faltante (a costo): <b style={{ color: result.missingValue > 0 ? "#b42318" : undefined }}>{money(result.missingValue)}</b></span>
        {result.items.filter((i) => Number(i.missing) !== 0).map((i) => (
          <span key={i.productId} className="muted">· {i.name}: faltó {formatQty(Number(i.missing), i.unit === "kg" ? "kg" : "unit")}</span>
        ))}
        <span className="muted">El camión quedó en cero de stock y de efectivo.</span>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Rendir {vehicle.name}</h3>
      <DepotPicker depots={depots} depotId={depotId} setDepotId={setDepotId} label="La mercadería vuelve a" />
      <p className="muted" style={{ margin: 0 }}>Contá lo que volvió en el camión. Si no volvió nada de un producto, poné 0.</p>
      {status.stock.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Producto</th><th className="num">Tendría que haber</th><th className="num">Volvió</th><th className="num">Falta</th></tr></thead>
          <tbody>
            {status.stock.map((s) => {
              const back = quantityNumber(returned[s.productId] ?? "");
              const missing = Math.round((s.stock - back) * 1000) / 1000;
              return (
                <tr key={s.productId}>
                  <td>{s.name}</td>
                  <td className="num">{formatQty(s.stock, s.unit)}</td>
                  <td className="num">
                    <input type="text" inputMode="decimal" value={returned[s.productId] ?? ""} onChange={(e) => setReturned({ ...returned, [s.productId]: e.target.value })} style={{ width: 90, textAlign: "right" }} />
                  </td>
                  <td className="num" style={{ color: missing > 0 ? "#b42318" : undefined }}>{missing !== 0 ? formatQty(missing, s.unit) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {missingValue > 0 && <span style={{ color: "#b42318" }}>Mercadería faltante a costo: {money(missingValue)}</span>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span>El sistema espera <b>{money(expected)}</b> en efectivo.</span>
        <label className="muted">Contaste</label>
        <input type="text" inputMode="decimal" placeholder="$" value={cashText} onChange={(e) => setCashText(e.target.value)} style={{ width: 140 }} />
        {counted >= 0 && counted !== expected && (
          <b style={{ color: counted < expected ? "#b42318" : "#1a7f37" }}>{counted < expected ? "Falta" : "Sobra"} {money(Math.abs(counted - expected))}</b>
        )}
      </div>
      {counted > 0 && (
        <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          La plata pasa a
          <select value={destId} onChange={(e) => setDestId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      <input placeholder="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ maxWidth: 420 }} />
      {error && <p style={{ color: "#b42318", margin: 0 }}>{error}</p>}
      <div><button disabled={busy} onClick={() => void handleSettle()}>{busy ? "Rindiendo…" : "Confirmar rendición"}</button></div>
    </div>
  );
}
