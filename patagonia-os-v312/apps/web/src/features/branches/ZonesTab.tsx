import { useCallback, useEffect, useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import { listProductsForBranch } from "../inventory/inventory-service";
import { rulePrice, type PriceList } from "../pricing/price-lists";
import { deletePriceList, listPriceLists, listZoneBranches, savePriceZone, setProductListPrices } from "../pricing/price-lists-service";
import { listTransferBranches, type TransferBranch } from "../transfers/transfers-service";

// Sucursales → Precios por zona (plan Empresa, migración 192). Una zona = precio general ± %, con precios a mano
// por producto, para los locales que se le asignan. Mostrador de esos locales cobra el precio de la zona solo;
// a su balanza se le mandan esos precios. El precio general es el de Stock.

const SHOWN = 60;

function plain(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

interface ZoneForm {
  id: string | null;
  name: string;
  pct: string;
  branchIds: string[];
}

export function ZonesTab({ activeBranchId }: { activeBranchId: string }) {
  const [zones, setZones] = useState<PriceList[]>([]);
  const [zoneBranches, setZoneBranches] = useState<Map<string, string[]>>(new Map());
  const [branches, setBranches] = useState<TransferBranch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState<ZoneForm | null>(null);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const reload = useCallback(async () => {
    const [lists, zb, b, p] = await Promise.all([listPriceLists(), listZoneBranches(), listTransferBranches(), listProductsForBranch(activeBranchId)]);
    setZones(lists.filter((l) => l.isZone));
    setZoneBranches(zb);
    setBranches(b);
    setProducts(p.filter((x) => (x.active ?? true) && !x.stockSourceId).sort((a, c) => a.name.localeCompare(c.name)));
    setDrafts({});
  }, [activeBranchId]);

  useEffect(() => {
    void reload().catch((err) => setMessage(err instanceof Error ? err.message : "No se pudieron cargar las zonas."));
  }, [reload]);

  const name = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const inZone = new Set([...zoneBranches.values()].flat());
  const generalBranches = branches.filter((b) => !inZone.has(b.id));
  const shown = useMemo(() => {
    const q = plain(query);
    return products.filter((p) => !q || plain(p.name).includes(q) || plain(p.code) === q).slice(0, SHOWN);
  }, [products, query]);
  const key = (zoneId: string, productId: string) => `${zoneId}|${productId}`;
  const changed = Object.entries(drafts).filter(([k, v]) => {
    const [zoneId, productId] = k.split("|");
    const cur = products.find((p) => p.id === productId)?.listPrices?.[zoneId];
    return v.trim() === "" ? cur?.manual === true : parseAmount(v) !== cur?.price;
  });

  async function saveZone() {
    if (!form) return;
    setMessage("");
    const pct = Number(form.pct.replace(",", "."));
    if (!form.name.trim()) return setMessage("Poné el nombre de la zona.");
    if (!Number.isFinite(pct)) return setMessage("Poné el porcentaje (ej. 6, o −5 para más barato).");
    setBusy(true);
    try {
      await savePriceZone({ id: form.id, name: form.name, pct, branchIds: form.branchIds });
      setMessage(`Listo: ${form.name.trim()} guardada. Mostrador de esos locales ya cobra estos precios. Mandá los precios a la balanza de cada uno (Stock → Balanza).`);
      setForm(null);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar la zona.");
    } finally {
      setBusy(false);
    }
  }

  async function removeZone(z: PriceList) {
    if (!window.confirm(`¿Borrar ${z.name}? Sus locales vuelven al precio general.`)) return;
    setBusy(true);
    try {
      await deletePriceList(z.id);
      setForm(null);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo borrar.");
    } finally {
      setBusy(false);
    }
  }

  async function savePrices() {
    setMessage("");
    const bad = changed.find(([, v]) => v.trim() !== "" && !(parseAmount(v) > 0));
    if (bad) return setMessage("Hay un precio que no es un número.");
    setBusy(true);
    try {
      await setProductListPrices(changed.map(([k, v]) => {
        const [listId, productId] = k.split("|");
        return { productId, listId, price: v.trim() === "" ? null : parseAmount(v) };
      }));
      setMessage(`Listo: se guardaron ${changed.length} precio${changed.length === 1 ? "" : "s"}.`);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron guardar los precios.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-layout">
      <section className="ws-list panel">
        <div className="panel-title">
          <h2>Zonas</h2>
        </div>
        <div className="ws-list-items">
          <div className="ws-item">
            <span className="ws-item-main">
              <b>General</b>
              <small>{generalBranches.map((b) => b.name).join(" · ") || "ningún local"}</small>
            </span>
            <span className="ws-item-side"><span className="badge">precio de Stock</span></span>
          </div>
          {zones.map((z) => (
            <button key={z.id} type="button" className={`ws-item${form?.id === z.id ? " active" : ""}`} onClick={() => setForm({ id: z.id, name: z.name, pct: String(z.pct).replace(".", ","), branchIds: zoneBranches.get(z.id) ?? [] })}>
              <span className="ws-item-main">
                <b>{z.name}</b>
                <small>{(zoneBranches.get(z.id) ?? []).map(name).join(" · ") || "sin locales"}</small>
              </span>
              <span className="ws-item-side"><span className="badge warn">{z.pct > 0 ? "+" : "−"} {String(Math.abs(z.pct)).replace(".", ",")}%</span></span>
            </button>
          ))}
        </div>
        {!form && (
          <button type="button" className="secondary transfers-new" onClick={() => setForm({ id: null, name: "", pct: "", branchIds: [] })}>
            + Nueva zona
          </button>
        )}
        {form && (
          <div className="ws-form">
            <label className="ws-field">
              Nombre
              <input value={form.name} maxLength={60} placeholder="Ej. Zona Norte" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="ws-field" style={{ marginTop: 8 }}>
              Precio general más (o menos) %
              <input value={form.pct} inputMode="decimal" placeholder="Ej. 6 o −5" onChange={(e) => setForm({ ...form, pct: e.target.value })} />
            </label>
            <p className="ws-field-label" style={{ marginTop: 8 }}>Locales de esta zona</p>
            {branches.map((b) => (
              <label key={b.id} className="transfers-check">
                <input
                  type="checkbox"
                  checked={form.branchIds.includes(b.id)}
                  onChange={(e) => setForm({ ...form, branchIds: e.target.checked ? [...form.branchIds, b.id] : form.branchIds.filter((id) => id !== b.id) })}
                />
                {b.name}
                {inZone.has(b.id) && !form.branchIds.includes(b.id) && <span className="muted"> (está en otra zona)</span>}
              </label>
            ))}
            <div className="form-actions">
              <button disabled={busy} onClick={() => void saveZone()}>{busy ? "Guardando…" : "Guardar zona"}</button>
              <button className="secondary" onClick={() => setForm(null)}>Cancelar</button>
              {form.id && <button className="danger" disabled={busy} onClick={() => { const z = zones.find((x) => x.id === form.id); if (z) void removeZone(z); }}>Borrar</button>}
            </div>
          </div>
        )}
      </section>

      <section className="ws-main panel">
        <div className="ws-head">
          <div>
            <h2>Precio de cada producto por zona</h2>
            <p className="muted">Se calcula solo con el %. Escribí un precio para dejarlo a mano (en amarillo); borralo para que vuelva al %.</p>
          </div>
          <button className="charge-button ws-go" disabled={busy || changed.length === 0} onClick={() => void savePrices()}>
            {changed.length > 0 ? `Guardar precios (${changed.length})` : "Guardar precios"}
          </button>
        </div>
        {message && <div className="message">{message}</div>}
        {zones.length === 0 ? (
          <p className="muted">Todavía no hay zonas: todos los locales venden al precio general (el de Stock). Creá una con "+ Nueva zona".</p>
        ) : (
          <>
            <div className="ws-form">
              <input className="ws-grow" placeholder="Buscar producto por nombre o código…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="ws-box">
              <div className="table-scroll ws-scroll">
                <table className="data-table no-stack transfers-min">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th className="num hide-sm">Costo</th>
                      <th className="num">General</th>
                      {zones.map((z) => (
                        <th key={z.id} className="num">{z.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.id}>
                        <td><b>{p.name}</b> <span className="muted">({p.code})</span></td>
                        <td className="num hide-sm muted">{formatMoney(p.cost)}</td>
                        <td className="num">{formatMoney(p.priceRetail)}</td>
                        {zones.map((z) => {
                          const cur = p.listPrices?.[z.id];
                          const k = key(z.id, p.id);
                          const value = drafts[k] ?? (cur?.manual ? String(cur.price) : "");
                          return (
                            <td key={z.id} className="num">
                              <input
                                className={`tr-qty${cur?.manual || drafts[k] ? " tr-changed" : ""}`}
                                type="text"
                                inputMode="decimal"
                                aria-label={`Precio de ${p.name} en ${z.name}`}
                                placeholder={formatMoney(cur?.price ?? rulePrice(z, p.cost, p.priceRetail))}
                                value={value}
                                onChange={(e) => setDrafts((d) => ({ ...d, [k]: e.target.value }))}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {products.length > shown.length && <p className="muted transfers-pad">Se muestran {shown.length} productos: buscá para ver otros.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
