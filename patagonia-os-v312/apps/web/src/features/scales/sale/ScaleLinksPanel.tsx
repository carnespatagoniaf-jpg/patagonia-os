import { useEffect, useMemo, useState } from "react";
import { sameProductName } from "../../inventory/systel/systel-sales";
import { loadSystelLabelTemplates } from "../../sale/systel-label-format";
import { suggestByName } from "./link-suggest";
import { isWeighed, profileReadiness, type ScaleCatalogItem, type ScaleLink, type ScaleSaleType } from "./profile";
import { loadScaleSetup, saveScaleCatalog, setScaleLinks, type ScaleSetup } from "./scale-sale-service";

/**
 * "Productos de la balanza" (Stock → Balanza): qué producto de Patagonia es cada producto de la balanza.
 *
 * Se decide una vez, acá, y no en la caja. Las cajas solo usan lo que quedó guardado.
 * - Coinciden (mismo código, nombre parecido y misma forma de venta): se vinculan todos con un botón,
 *   que la persona toca.
 * - El resto se decide uno por uno: otro producto de Patagonia, "venta libre" (se cobra sin stock) o
 *   "no se vende".
 *
 * Abajo, cerrado: qué productos todavía no imprimen un código que se pueda leer (configuración de la balanza;
 * no se cambia nada desde acá).
 */

interface PanelProduct {
  id: string;
  code: string;
  name: string;
  unit: string;
  active?: boolean;
}

const SCALE_KEY = "systel";
const typeText = (t: ScaleSaleType) => (isWeighed(t) ? "por peso" : "por unidad");
const compatible = (item: ScaleCatalogItem, p: PanelProduct) => isWeighed(item.saleType) === (p.unit === "kg");

/** Productos leídos con el "Diagnóstico completo" en esta computadora (solo lectura de la balanza). */
function catalogFromLastReading(): { formats: { weighed: string | null; unit: string | null; sums: string | null }; items: ScaleCatalogItem[] } | null {
  const t = loadSystelLabelTemplates();
  if (!t?.perPlu) return null;
  const items = Object.entries(t.perPlu)
    .filter(([, e]) => e.name && e.saleType)
    .map(([code, e]): ScaleCatalogItem => ({ code: Number(code), name: e.name!, saleType: e.saleType as ScaleSaleType, prices: [e.p1 ?? 0, e.p2 ?? 0], eanType: e.type, eanConfig: e.config }));
  return items.length ? { formats: { weighed: t.weighed, unit: t.unit, sums: t.sums ?? null }, items } : null;
}

export function ScaleLinksPanel({ branchId, products }: { branchId: string | null; products: PanelProduct[] }) {
  const [setup, setSetup] = useState<ScaleSetup | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState<Record<number, string>>({});
  const active = useMemo(() => products.filter((p) => p.active ?? true), [products]);

  async function refresh() {
    if (!branchId) return;
    setSetup(await loadScaleSetup(branchId));
    setLoaded(true);
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const links = setup?.links ?? [];
  const linkOf = (code: number) => links.find((l) => l.code === code);
  const catalog = setup?.profile.catalog ?? [];
  const undecided = catalog.filter((i) => (linkOf(i.code)?.kind ?? "none") === "none");
  const matches = undecided.flatMap((i) => {
    const p = active.find((x) => x.code === String(i.code));
    return p && sameProductName(i.name, p.name) && compatible(i, p) ? [{ item: i, product: p }] : [];
  });
  const toDecide = undecided.filter((i) => !matches.some((m) => m.item.code === i.code));
  const linked = catalog.filter((i) => linkOf(i.code)?.kind === "product");
  const libre = catalog.filter((i) => linkOf(i.code)?.kind === "libre");
  const readiness = setup ? profileReadiness(setup.profile, links) : null;

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setNote("");
    try {
      setNote(await fn());
      await refresh();
    } catch (err) {
      setNote(`No se pudo: ${err instanceof Error ? err.message : (err as { message?: string })?.message ?? "error"}`);
    } finally {
      setBusy(false);
    }
  }

  const reading = catalogFromLastReading();
  const saveReading = () =>
    run(async () => {
      if (!branchId || !reading) throw new Error("primero hacé el Diagnóstico completo con la balanza conectada");
      const r = await saveScaleCatalog(branchId, { scaleKey: SCALE_KEY, brand: "systel", model: "Cuora", weighedFormat: reading.formats.weighed, unitFormat: reading.formats.unit, totalFormat: reading.formats.sums, amountDecimals: 0, genericCodes: [] }, reading.items);
      return `Se guardaron ${r.items} productos de la balanza${r.removed ? ` (${r.removed} que ya no están se sacaron)` : ""}. Los vínculos ya decididos se mantienen.`;
    });

  const saveLinks = (list: ScaleLink[], text: string) =>
    run(async () => {
      await setScaleLinks(branchId!, setup!.profile.scaleKey, list);
      return text;
    });

  function decide(item: ScaleCatalogItem) {
    const v = choice[item.code];
    if (!v) return;
    const link: ScaleLink = v === "libre" ? { code: item.code, kind: "libre", productId: null } : v === "none" ? { code: item.code, kind: "none", productId: null } : { code: item.code, kind: "product", productId: v };
    void saveLinks([link], `Producto ${item.code} de la balanza: guardado.`);
  }

  if (!branchId) return null;
  return (
    <div className="panel" style={{ padding: 12, display: "grid", gap: 10 }}>
      <strong>Productos de la balanza ↔ Patagonia</strong>
      {!loaded ? (
        <span className="muted">Cargando…</span>
      ) : !setup ? (
        <span className="muted" style={{ fontSize: 13 }}>Todavía no hay productos de la balanza guardados en Patagonia.</span>
      ) : (
        <span style={{ fontSize: 13 }}>
          {catalog.length} productos de la balanza{setup.readAt ? ` (leídos el ${new Date(setup.readAt).toLocaleString("es-AR")})` : ""}: <b>{linked.length}</b> vinculados, <b>{libre.length}</b> venta libre, <b>{undecided.length}</b> por decidir.
        </span>
      )}
      {reading && (
        <div>
          <button className="secondary" disabled={busy} onClick={() => void saveReading()}>Guardar en Patagonia los {reading.items.length} productos leídos de la balanza</button>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>Usa la última lectura del "Diagnóstico completo" de esta computadora. No cambia nada en la balanza.</p>
        </div>
      )}
      {matches.length > 0 && (
        <div>
          <button disabled={busy} onClick={() => void saveLinks(matches.map((m) => ({ code: m.item.code, kind: "product", productId: m.product.id })), `Se vincularon ${matches.length} productos que coinciden.`)}>
            Vincular los {matches.length} que coinciden (mismo código, nombre y forma de venta)
          </button>
          <details style={{ marginTop: 4 }}>
            <summary className="muted" style={{ fontSize: 12 }}>Ver cuáles</summary>
            <div style={{ fontSize: 12 }}>{matches.map((m) => <div key={m.item.code}>{m.item.code} · {m.item.name.trim()} → {m.product.name}</div>)}</div>
          </details>
        </div>
      )}
      {toDecide.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <strong style={{ fontSize: 14 }}>Por decidir ({toDecide.length})</strong>
          {toDecide.map((item) => {
            const same = active.find((p) => p.code === String(item.code));
            const reason = !same ? "no hay un producto con ese código en Patagonia" : !compatible(item, same) ? `en Patagonia "${same.name}" se vende ${same.unit === "kg" ? "por kg" : "por unidad"}` : `en Patagonia el ${item.code} es "${same.name}"`;
            const options = active.filter((p) => compatible(item, p)).sort((a, b) => Number(sameProductName(item.name, b.name)) - Number(sameProductName(item.name, a.name)) || a.name.localeCompare(b.name));
            // Sugerencia: UN solo producto con el mismo nombre y la misma forma de venta (link-suggest.ts: mismo nombre, conservadora).
            // Queda elegida en la lista; se guarda recién cuando la persona toca "Guardar".
            const suggested = suggestByName(item, options);
            if (suggested && choice[item.code] === undefined) queueMicrotask(() => setChoice((c) => (c[item.code] === undefined ? { ...c, [item.code]: suggested.id } : c)));
            return (
              <div key={item.code} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
                <span style={{ minWidth: 260 }}>
                  <b>{item.code}</b> · {item.name.trim()} ({typeText(item.saleType)}, ${item.prices.filter((x) => x > 0).map((x) => x.toLocaleString("es-AR")).join(" / $") || "sin precio"})
                  <br />
                  <span className="muted" style={{ fontSize: 12 }}>{reason}{suggested ? ` · sugerido por el nombre: "${suggested.name}" (confirmá con Guardar)` : ""}</span>
                </span>
                <select value={choice[item.code] ?? ""} onChange={(e) => setChoice({ ...choice, [item.code]: e.target.value })} disabled={busy} aria-label={`Vínculo del producto ${item.code} de la balanza`}>
                  <option value="">— elegir —</option>
                  {options.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                  <option value="libre">Venta libre (se cobra, sin stock)</option>
                  <option value="none">No se vende</option>
                </select>
                <button className="secondary" disabled={busy || !choice[item.code]} onClick={() => decide(item)}>Guardar</button>
              </div>
            );
          })}
        </div>
      )}
      {readiness && (
        <details>
          <summary style={{ fontSize: 13 }}>
            {readiness.problems.length === 0 ? "La balanza imprime un código que se puede leer en todos los productos vinculados" : `${readiness.problems.length} productos vinculados todavía no imprimen un código que se pueda leer`}
          </summary>
          <div style={{ fontSize: 12, display: "grid", gap: 2, marginTop: 4 }}>
            <span className="muted">Es configuración de la balanza: desde acá no se cambia nada. {readiness.totalDetail}.</span>
            {readiness.problems.map((p) => <span key={p.code}>{p.code} · {p.name}: {p.detail}</span>)}
          </div>
        </details>
      )}
      {linked.length + libre.length > 0 && (
        <details>
          <summary style={{ fontSize: 13 }}>Ver los vinculados ({linked.length + libre.length})</summary>
          <div style={{ fontSize: 12, display: "grid", gap: 2, marginTop: 4 }}>
            {[...linked, ...libre].map((i) => {
              const l = linkOf(i.code)!;
              const p = active.find((x) => x.id === l.productId);
              return (
                <span key={i.code}>
                  {i.code} · {i.name.trim()} → {l.kind === "libre" ? "venta libre" : p ? p.name : "producto desactivado"}{" "}
                  <button className="link-button" disabled={busy} onClick={() => void saveLinks([{ code: i.code, kind: "none", productId: null }], `Producto ${i.code}: desvinculado.`)}>desvincular</button>
                </span>
              );
            })}
          </div>
        </details>
      )}
      {note && <span style={{ fontSize: 13 }}>{note}</span>}
    </div>
  );
}
