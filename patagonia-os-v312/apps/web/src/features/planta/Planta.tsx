import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { CarcassBatch, Product } from "@patagonia/domain";
import { useActiveBranch } from "../branches/BranchProvider";
import { listCarcassBatches } from "../carcass/carcass-service";
import { listProductsForBranch } from "../inventory/inventory-service";
import { todayIso } from "../shifts/format";
import { ProductSearch, type PickableProduct } from "../transfers/ProductSearch";
import { formatQty } from "../transfers/transfer-logic";
import { listTransferBranches, type TransferBranch } from "../transfers/transfers-service";
import { PackageLabels, type LabelData } from "./PackageLabels";
import {
  STATUS_LABELS,
  addDays,
  daysToExpire,
  isPackageCode,
  normalizePackageCode,
  parseQuantities,
  shipScanProblem,
  totalsByProduct,
  type PackageStatus,
  type PlantaPackage
} from "./planta-logic";
import { findPackage, listBranchPackages, packProduct, shipPackages, voidPackage } from "./planta-service";

// Planta (migración 194, plan Planta). Se trabaja desde el local activo (el selector de arriba), normalmente la
// planta: envasar con etiqueta, ver los paquetes y despacharlos a un local escaneándolos. El local los recibe en
// "Entre locales" (o Sucursales → Mercadería entre locales) como cualquier envío, y la caja los cobra escaneando.

type Tab = "envasar" | "paquetes" | "mandar";

const EXPIRY_KEY = "patagonia-planta-expiry-days";

function readExpiryDays(productId: string): string {
  try {
    const all = JSON.parse(localStorage.getItem(EXPIRY_KEY) ?? "{}") as Record<string, string>;
    return all[productId] ?? "";
  } catch {
    return "";
  }
}

function saveExpiryDays(productId: string, days: string) {
  try {
    const all = JSON.parse(localStorage.getItem(EXPIRY_KEY) ?? "{}") as Record<string, string>;
    all[productId] = days;
    localStorage.setItem(EXPIRY_KEY, JSON.stringify(all));
  } catch {
    // sin almacenamiento: no se recuerda
  }
}

const day = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : (err as { message?: string })?.message ?? fallback);

export function Planta() {
  const { branchId } = useActiveBranch();
  const [tab, setTab] = useState<Tab>("envasar");
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<CarcassBatch[]>([]);
  const [branches, setBranches] = useState<TransferBranch[]>([]);
  const [packages, setPackages] = useState<PlantaPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [labels, setLabels] = useState<{ list: LabelData[]; autoPrint: boolean } | null>(null);

  const reloadPackages = useCallback(async () => {
    if (!branchId) return;
    setPackages(await listBranchPackages(branchId));
  }, [branchId]);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([listProductsForBranch(branchId), listCarcassBatches(branchId), listTransferBranches(), listBranchPackages(branchId)])
      .then(([p, b, br, pk]) => {
        if (cancelled) return;
        setProducts(p.filter((x) => x.active !== false));
        setBatches(b.slice(0, 30));
        setBranches(br);
        setPackages(pk);
        setError("");
      })
      .catch((err) => !cancelled && setError(errorText(err, "No se pudo cargar la planta.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const batchLabel = useCallback((id: string | null) => {
    const b = id ? batches.find((x) => x.id === id) : undefined;
    return b ? `${b.animalType} ${day(b.batchDate)}` : null;
  }, [batches]);

  const toLabel = useCallback((p: Pick<PlantaPackage, "code" | "productId" | "quantity" | "packedOn" | "expiresOn" | "carcassBatchId">): LabelData => {
    const product = productById.get(p.productId);
    return {
      code: p.code,
      productName: product?.name ?? "Producto",
      unit: product?.unit ?? "kg",
      quantity: p.quantity,
      unitPrice: product?.priceRetail ?? 0,
      packedOn: p.packedOn,
      expiresOn: p.expiresOn,
      lot: batchLabel(p.carcassBatchId)
    };
  }, [productById, batchLabel]);

  const inPlant = packages.filter((p) => p.status === "en_planta").length;

  return (
    <div className="planta">
      <div className="transfers-top">
        <div className="ws-seg">
          {([["envasar", "Envasar"], ["paquetes", "Paquetes"], ["mandar", "Mandar a un local"]] as Array<[Tab, string]>).map(([key, label]) => (
            <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => { setTab(key); setMessage(""); setLabels(null); }}>
              {label}
              {key === "mandar" && inPlant > 0 && <span className="nav-count">{inPlant}</span>}
            </button>
          ))}
        </div>
      </div>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}
      {loading && <p className="muted">Cargando…</p>}

      {!loading && branchId && (
        <>
          {tab === "envasar" && (
            <PackTab
              branchId={branchId}
              products={products}
              batches={batches}
              batchLabel={batchLabel}
              onPacked={async (created, product, batchId, expiresOn) => {
                setMessage(`Listo: ${created.length === 1 ? "1 paquete" : `${created.length} paquetes`} de ${product.name}.`);
                setLabels({ list: created.map((c) => toLabel({ ...c, productId: product.id, packedOn: todayIso(), expiresOn, carcassBatchId: batchId })), autoPrint: true });
                await reloadPackages();
              }}
            />
          )}
          {tab === "paquetes" && (
            <PackagesTab
              packages={packages}
              productById={productById}
              onReprint={(list) => setLabels({ list: list.map(toLabel), autoPrint: false })}
              onVoid={async (p) => {
                const reason = window.prompt(`¿Por qué se anula el paquete ${p.code}? (ej. etiqueta mal impresa, se rompió el vacío)`);
                if (reason === null) return;
                try {
                  await voidPackage(p.id, reason);
                  setMessage(`Paquete ${p.code} anulado. Si la carne se tira, cargala como decomiso.`);
                  await reloadPackages();
                } catch (err) {
                  setMessage(errorText(err, "No se pudo anular."));
                }
              }}
            />
          )}
          {tab === "mandar" && (
            <ShipTab
              branchId={branchId}
              branches={branches}
              packages={packages}
              productById={productById}
              onShipped={async (text) => {
                setMessage(text);
                await reloadPackages();
              }}
            />
          )}
        </>
      )}

      {labels && <PackageLabels labels={labels.list} autoPrint={labels.autoPrint} onClose={() => setLabels(null)} />}
    </div>
  );
}

function PackTab({ branchId, products, batches, batchLabel, onPacked }: {
  branchId: string;
  products: Product[];
  batches: CarcassBatch[];
  batchLabel: (id: string | null) => string | null;
  onPacked: (created: Array<{ code: string; quantity: number }>, product: Product, batchId: string | null, expiresOn: string | null) => Promise<void>;
}) {
  const [product, setProduct] = useState<Product | null>(null);
  const [weights, setWeights] = useState("");
  const [batchId, setBatchId] = useState("");
  const [expiryDays, setExpiryDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const pickable: PickableProduct[] = useMemo(() => products.map((p) => ({ id: p.id, name: p.name, code: p.code, unit: p.unit, stock: p.stock })), [products]);
  const parsed = parseQuantities(weights);
  const total = parsed.quantities.reduce((s, q) => s + q, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!product) return;
    setProblem("");
    if (parsed.invalid.length > 0) {
      setProblem(`No se entiende: ${parsed.invalid.join(", ")}. Escribí un peso por paquete, por ejemplo 1,250.`);
      return;
    }
    if (parsed.quantities.length === 0) {
      setProblem(product.unit === "kg" ? "Escribí el peso de cada paquete." : "Escribí cuántas unidades lleva cada paquete.");
      return;
    }
    const days = expiryDays.trim() ? Number(expiryDays) : null;
    if (days !== null && !(Number.isInteger(days) && days >= 0 && days <= 365)) {
      setProblem("Los días para vencer van de 0 a 365.");
      return;
    }
    const expiresOn = days === null ? null : addDays(todayIso(), days);
    setBusy(true);
    try {
      const created = await packProduct({ branchId, productId: product.id, quantities: parsed.quantities, carcassBatchId: batchId || null, expiresOn });
      saveExpiryDays(product.id, expiryDays.trim());
      setWeights("");
      await onPacked(created, product, batchId || null, expiresOn);
    } catch (err) {
      setProblem(errorText(err, "No se pudo envasar."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-box" onSubmit={submit}>
      <p className="muted">
        Elegí el corte, escribí el peso de cada paquete (uno por renglón) y se imprime una etiqueta con código por paquete.
        Envasar no cambia el stock: los kilos ya entraron con el despiece o la compra.
      </p>
      {product ? (
        <p>
          <b>{product.name}</b> · hay {formatQty(product.stock, product.unit)} en este local{" "}
          <button type="button" className="secondary" onClick={() => { setProduct(null); setWeights(""); }}>Cambiar</button>
        </p>
      ) : (
        <ProductSearch
          products={pickable}
          placeholder="¿Qué envasás? Buscá por nombre o código"
          exclude={new Set()}
          onPick={(p) => {
            const found = products.find((x) => x.id === p.id) ?? null;
            setProduct(found);
            if (found) setExpiryDays(readExpiryDays(found.id));
          }}
        />
      )}
      {product && (
        <>
          <div className="form-grid">
            <label>
              {product.unit === "kg" ? "Peso de cada paquete (kg)" : "Unidades de cada paquete"}
              <textarea
                rows={5}
                value={weights}
                inputMode="decimal"
                placeholder={product.unit === "kg" ? "1,250\n0,980\n1,105" : "6\n6\n12"}
                onChange={(e) => setWeights(e.target.value)}
                autoFocus
              />
            </label>
            <label>
              Lote (media res de Despiece)
              <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
                <option value="">Sin lote</option>
                {batches.map((b) => <option key={b.id} value={b.id}>{batchLabel(b.id)} · {formatQty(b.totalWeight, "kg")}</option>)}
              </select>
            </label>
            <label>
              Vence en (días)
              <input type="text" inputMode="numeric" value={expiryDays} placeholder="Sin vencimiento" onChange={(e) => setExpiryDays(e.target.value)} />
            </label>
          </div>
          {parsed.quantities.length > 0 && (
            <p className="muted">
              {parsed.quantities.length === 1 ? "1 paquete" : `${parsed.quantities.length} paquetes`} · {formatQty(total, product.unit)}
            </p>
          )}
          {problem && <div className="message warning">{problem}</div>}
          <div className="form-actions">
            <button type="submit" disabled={busy || parsed.quantities.length === 0}>
              {busy ? "Envasando…" : `Envasar e imprimir ${parsed.quantities.length || ""} etiqueta${parsed.quantities.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

const STATUS_FILTERS: Array<[PackageStatus | "todos", string]> = [
  ["en_planta", "En la planta"],
  ["en_viaje", "En viaje"],
  ["en_local", "En el local"],
  ["vendido", "Vendidos"],
  ["anulado", "Anulados"],
  ["todos", "Todos"]
];

function PackagesTab({ packages, productById, onReprint, onVoid }: {
  packages: PlantaPackage[];
  productById: Map<string, Product>;
  onReprint: (list: PlantaPackage[]) => void;
  onVoid: (p: PlantaPackage) => Promise<void>;
}) {
  const [filter, setFilter] = useState<PackageStatus | "todos">("en_planta");
  const today = todayIso();
  const shown = packages.filter((p) => filter === "todos" || p.status === filter);
  const totals = totalsByProduct(shown);

  return (
    <div className="panel">
      <div className="form-grid no-stack" style={{ marginBottom: 12 }}>
        <label>
          Mostrar
          <select value={filter} onChange={(e) => setFilter(e.target.value as PackageStatus | "todos")}>
            {STATUS_FILTERS.map(([key, label]) => <option key={key} value={key}>{label} ({key === "todos" ? packages.length : packages.filter((p) => p.status === key).length})</option>)}
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="muted">No hay paquetes así en este local.</p>
      ) : (
        <>
          <p className="muted">
            {[...totals.entries()].map(([id, t]) => `${productById.get(id)?.name ?? "Producto"}: ${t.count} (${formatQty(t.quantity, productById.get(id)?.unit)})`).join(" · ")}
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Código</th><th>Producto</th><th>Cantidad</th><th>Envasado</th><th>Vence</th><th>Estado</th><th></th></tr>
              </thead>
              <tbody>
                {shown.slice(0, 500).map((p) => {
                  const left = daysToExpire(p.expiresOn, today);
                  const product = productById.get(p.productId);
                  return (
                    <tr key={p.id}>
                      <td>{p.code}</td>
                      <td>{product?.name ?? "Producto"}</td>
                      <td>{formatQty(p.quantity, product?.unit)}</td>
                      <td>{day(p.packedOn)}</td>
                      <td>
                        {p.expiresOn ? day(p.expiresOn) : "—"}
                        {left !== null && left <= 1 && p.status !== "vendido" && p.status !== "anulado" && (
                          <span className="badge" style={{ marginLeft: 6 }}>{left < 0 ? "Vencido" : left === 0 ? "Vence hoy" : "Vence mañana"}</span>
                        )}
                      </td>
                      <td>{STATUS_LABELS[p.status]}{p.voidReason ? <span className="cell-sub">{p.voidReason}</span> : null}</td>
                      <td>
                        <span className="row-actions">
                          {p.status !== "anulado" && p.status !== "vendido" && <button type="button" className="secondary" onClick={() => onReprint([p])}>Etiqueta</button>}
                          {(p.status === "en_planta" || p.status === "en_local") && <button type="button" className="secondary" onClick={() => void onVoid(p)}>Anular</button>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {shown.length > 500 && <p className="muted">Se muestran los 500 más nuevos de {shown.length}.</p>}
        </>
      )}
    </div>
  );
}

function ShipTab({ branchId, branches, packages, productById, onShipped }: {
  branchId: string;
  branches: TransferBranch[];
  packages: PlantaPackage[];
  productById: Map<string, Product>;
  onShipped: (text: string) => Promise<void>;
}) {
  const [toBranchId, setToBranchId] = useState("");
  const [scan, setScan] = useState("");
  const [scanned, setScanned] = useState<PlantaPackage[]>([]);
  const [carrier, setCarrier] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const byCode = useMemo(() => new Map(packages.map((p) => [p.code, p])), [packages]);
  const destinations = branches.filter((b) => b.id !== branchId);
  const totals = totalsByProduct(scanned);

  async function addScan(event: FormEvent) {
    event.preventDefault();
    const code = normalizePackageCode(scan);
    setScan("");
    if (!code) return;
    if (!isPackageCode(code)) {
      setProblem(`"${code}" no es el código de un paquete (empiezan con PQ).`);
      return;
    }
    let pkg = byCode.get(code);
    if (!pkg) {
      try {
        pkg = await findPackage(code);
      } catch (err) {
        setProblem(errorText(err, "No se pudo buscar el paquete."));
        return;
      }
    }
    const why = shipScanProblem(code, scanned.map((p) => p.code), pkg, branchId);
    if (why || !pkg) {
      setProblem(why ?? "");
      return;
    }
    const found = pkg;
    setProblem("");
    setScanned((list) => [found, ...list]);
  }

  async function dispatch() {
    if (!toBranchId || scanned.length === 0) return;
    const destination = branches.find((b) => b.id === toBranchId)?.name ?? "el local";
    if (!window.confirm(`¿Despachar ${scanned.length} paquetes a ${destination}? Salen del stock de este local ahora.`)) return;
    setBusy(true);
    setProblem("");
    try {
      const r = await shipPackages({ fromBranchId: branchId, toBranchId, codes: scanned.map((p) => p.code), carrier, vehicle, notes });
      setScanned([]);
      setNotes("");
      await onShipped(`Envío N.º ${r.number} despachado a ${destination} con ${r.packages} paquetes. El remito está en Sucursales → Mercadería entre locales → En viaje; ${destination} lo recibe en "Entre locales".`);
    } catch (err) {
      setProblem(errorText(err, "No se pudo despachar."));
    } finally {
      setBusy(false);
    }
  }

  if (destinations.length === 0) return <p className="muted">Para mandar paquetes hace falta otro local.</p>;

  return (
    <div className="form-box">
      <div className="form-grid">
        <label>
          ¿A qué local?
          <select value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
            <option value="">Elegí el local</option>
            {destinations.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label>
          Quién lo lleva
          <input value={carrier} maxLength={80} onChange={(e) => setCarrier(e.target.value)} />
        </label>
        <label>
          Patente
          <input value={vehicle} maxLength={40} onChange={(e) => setVehicle(e.target.value)} />
        </label>
      </div>
      <form onSubmit={addScan} style={{ marginTop: 12 }}>
        <input
          ref={scanRef}
          className="pos-search"
          placeholder="Escaneá cada paquete con la pistola"
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          autoFocus
        />
      </form>
      {problem && <div className="message warning">{problem}</div>}
      {scanned.length > 0 && (
        <>
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="data-table">
              <thead><tr><th>Producto</th><th>Paquetes</th><th>Total</th></tr></thead>
              <tbody>
                {[...totals.entries()].map(([id, t]) => (
                  <tr key={id}><td>{productById.get(id)?.name ?? "Producto"}</td><td>{t.count}</td><td>{formatQty(t.quantity, productById.get(id)?.unit)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <details style={{ marginTop: 8 }}>
            <summary>Ver los {scanned.length} paquetes escaneados</summary>
            <ul>
              {scanned.map((p) => (
                <li key={p.code}>
                  {p.code} · {productById.get(p.productId)?.name ?? "Producto"} · {formatQty(p.quantity, productById.get(p.productId)?.unit)}{" "}
                  <button type="button" className="secondary" onClick={() => { setScanned((list) => list.filter((x) => x.code !== p.code)); scanRef.current?.focus(); }}>Sacar</button>
                </li>
              ))}
            </ul>
          </details>
          <label style={{ display: "block", marginTop: 8 }}>
            Nota para el local
            <input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="form-actions">
            <button type="button" disabled={busy || !toBranchId} onClick={() => void dispatch()}>
              {busy ? "Despachando…" : `Despachar ${scanned.length} paquete${scanned.length === 1 ? "" : "s"}`}
            </button>
            {!toBranchId && <span className="muted">Elegí a qué local va.</span>}
          </div>
        </>
      )}
    </div>
  );
}
