import { useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { SettingSection } from "../../components/SettingSection";
import { quantityNumber } from "./quantity";
import { boxProblem, learnBoxLabelFormat, productForDigits, readAnyBox, readWithFormat, resolveBoxScan, restoreLeadingZero, shiftProductCut, type BoxLabelFormat, type BoxLabelRead } from "./box-label";
import { deleteBoxLabelFormat, notifyBoxFormatsChanged, saveBoxLabelFormat, setBoxLabelProduct, useBoxLabelFormats } from "./box-label-service";

type Draft = Omit<BoxLabelFormat, "id" | "name">;

const kgText = (n: number) => `${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} kg`;

/**
 * Etiquetas de cajas envasadas al vacío (migraciones 198 y 200), en el engranaje de Mostrador.
 * 1. Formato: se aprende con dos cajas de productos distintos (del mismo día) y el peso neto de cada una.
 * 2. Asociar: cada número de caja (07, 15…) a su producto de Patagonia, escaneando una caja de cada producto.
 */
export function BoxLabelSettings({ products, canEdit }: { products: Product[]; canEdit: boolean }) {
  const { formats } = useBoxLabelFormats();
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState(["", ""]);
  const [kgs, setKgs] = useState(["", ""]);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [testCode, setTestCode] = useState("");
  const [testResult, setTestResult] = useState("");
  // Asociar número de caja → producto.
  const [linkCode, setLinkCode] = useState("");
  const [linkRead, setLinkRead] = useState<BoxLabelRead | null>(null);
  const [linkProductId, setLinkProductId] = useState("");
  const [linkMessage, setLinkMessage] = useState("");

  const sortedProducts = useMemo(
    () => products.filter((p) => p.active ?? true).sort((a, b) => a.name.localeCompare(b.name, "es")),
    [products]
  );
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  function reset() {
    setCodes(["", ""]);
    setKgs(["", ""]);
    setName("");
    setDraft(null);
    setError("");
    setTestResult("");
  }

  function learn() {
    const samples = codes.map((code, i) => ({ code: code.trim(), kg: quantityNumber(kgs[i]) }));
    const r = learnBoxLabelFormat(samples);
    if (!r.ok) {
      setDraft(null);
      setError(r.reason);
      return;
    }
    setError("");
    setDraft(r.format);
  }

  async function save() {
    if (!draft) return;
    if (!name.trim()) {
      setError("Poné un nombre (por ejemplo, el del frigorífico).");
      return;
    }
    setBusy(true);
    try {
      await saveBoxLabelFormat({ ...draft, name: name.trim() });
      notifyBoxFormatsChanged();
      reset();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: BoxLabelFormat) {
    if (!window.confirm(`¿Borrar el formato "${f.name}"? Mostrador va a dejar de leer esas cajas.`)) return;
    try {
      await deleteBoxLabelFormat(f.id);
      notifyBoxFormatsChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  function test() {
    const code = testCode.trim();
    setTestCode("");
    if (!code) return;
    const list = draft ? [{ ...draft, id: "nuevo", name: name.trim() || "nuevo" }] : formats;
    const ok = resolveBoxScan(code, list, products);
    if (ok) {
      setTestResult(`Se lee bien: ${ok.detail}.`);
      return;
    }
    setTestResult(boxProblem(code, list, products) ?? `"${code}" no tiene la forma de ninguna caja cargada.`);
  }

  function readLinkCode() {
    const code = linkCode.trim();
    setLinkMessage("");
    const read = code ? readAnyBox(code, formats) : null;
    setLinkRead(read);
    if (!read) {
      setLinkMessage(code ? `"${code}" no tiene la forma de ninguna caja cargada.` : "");
      return;
    }
    const current = productForDigits(read.productDigits, products, read.format.productMap);
    setLinkProductId(current?.id ?? "");
  }

  async function link(productId: string | null, read: BoxLabelRead | null = linkRead) {
    if (!read) return;
    setBusy(true);
    try {
      await setBoxLabelProduct(read.format.id, read.productDigits, productId);
      notifyBoxFormatsChanged();
      const p = productId ? productById.get(productId) : null;
      setLinkMessage(p ? `Listo: la caja N.º ${read.productDigits} es ${p.name}. Escaneá otra caja para seguir.` : `La caja N.º ${read.productDigits} quedó sin producto.`);
      setLinkCode("");
      setLinkRead(null);
      setLinkProductId("");
    } catch (e) {
      setLinkMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function unlink(format: BoxLabelFormat, digits: string) {
    const read: BoxLabelRead = { format, productDigits: digits, weightKg: 0, code: "" };
    await link(null, read);
  }

  const sample = draft ? restoreLeadingZero(codes[0]) : "";
  const parts = draft ? readWithFormat(codes[0], { ...draft, id: "", name: "" }) : null;

  return (
    <SettingSection
      title="Etiquetas de cajas (frigorífico)"
      status={formats.length > 0 ? `${formats.length} formato${formats.length === 1 ? "" : "s"}` : "Ninguno"}
      tone={formats.length > 0 ? "ok" : "neutral"}
      actionLabel={formats.length > 0 ? "Ver" : "Configurar"}
    >
      <p className="setting-help">
        Para las cajas envasadas al vacío que traen una etiqueta con el producto y el peso (la imprime el frigorífico, no tu balanza). Primero se carga el formato, después a qué producto va cada número de caja; en Mostrador escaneás la caja y entra el producto con los kilos de la caja.
      </p>

      {formats.map((f) => {
        const entries = Object.entries(f.productMap ?? {}).sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10));
        return (
          <div key={f.id} className="form-box" style={{ display: "grid", gap: 6, maxWidth: 560 }}>
            <div>
              <b>{f.name}</b>
              <span className="setting-help"> · número de caja = números {f.productStart + 1} a {f.productStart + f.productLength}, kilos = números {f.weightStart + 1} a {f.weightStart + f.weightLength}</span>
              {canEdit && (
                <button className="secondary" style={{ marginLeft: 8 }} onClick={() => void remove(f)}>Borrar formato</button>
              )}
            </div>
            {entries.length === 0 ? (
              <span className="setting-help">Todavía no hay cajas asociadas a productos.</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {entries.map(([digits, productId]) => (
                  <li key={digits}>
                    Caja N.º <b>{digits}</b> → {productById.get(productId)?.name ?? "(producto borrado o desactivado)"}
                    {canEdit && (
                      <button className="secondary" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void unlink(f, digits)}>Soltar</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {canEdit && formats.length > 0 && (
        <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
          <b>Asociar una caja a un producto</b>
          <form
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              readLinkCode();
            }}
          >
            <input name="box-link" autoComplete="off" placeholder="Escaneá una caja de ese producto…" value={linkCode} onChange={(e) => setLinkCode(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <button className="secondary" type="submit">Leer</button>
          </form>
          {linkRead && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>Caja N.º <b>{linkRead.productDigits}</b> ({kgText(linkRead.weightKg)}) es:</span>
              <select name="box-link-product" value={linkProductId} onChange={(e) => setLinkProductId(e.target.value)} style={{ minWidth: 220 }}>
                <option value="">Elegí el producto…</option>
                {sortedProducts.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
                ))}
              </select>
              <button disabled={busy || !linkProductId} onClick={() => void link(linkProductId)}>Asociar</button>
            </div>
          )}
          {linkMessage && <p style={{ margin: 0, fontWeight: 700 }}>{linkMessage}</p>}
        </div>
      )}

      <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
        <form
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
          onSubmit={(e) => {
            e.preventDefault();
            test();
          }}
        >
          <input name="box-test" autoComplete="off" placeholder="Probar: escaneá una caja acá…" value={testCode} onChange={(e) => setTestCode(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button className="secondary" type="submit">Probar</button>
        </form>
        {testResult && <p style={{ margin: 0, fontWeight: 700 }}>{testResult}</p>}
      </div>

      {canEdit && !open && (
        <button className={formats.length > 0 ? "secondary" : undefined} onClick={() => { reset(); setOpen(true); }}>+ Agregar formato de cajas</button>
      )}

      {canEdit && open && (
        <div className="form-box" style={{ display: "grid", gap: 10, maxWidth: 560 }}>
          <p className="setting-help" style={{ margin: 0 }}>
            Agarrá <b>dos cajas de productos distintos y del mismo día</b> (misma fecha de producción). Escaneá el código de cada una y escribí el <b>peso neto</b> que dice su etiqueta.
          </p>
          {[0, 1].map((i) => (
            <div key={i} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                name={`box-code-${i}`}
                autoComplete="off"
                placeholder={`Código de la caja ${i + 1}`}
                value={codes[i]}
                onChange={(e) => setCodes((c) => c.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  // El lector manda Enter: que no envíe nada, que pase al peso.
                  if (e.key === "Enter") e.preventDefault();
                }}
                style={{ flex: 2, minWidth: 180 }}
              />
              <input
                name={`box-kg-${i}`}
                autoComplete="off"
                type="text"
                inputMode="decimal"
                placeholder="Peso neto (ej. 17,320)"
                value={kgs[i]}
                onChange={(e) => setKgs((k) => k.map((x, j) => (j === i ? e.target.value : x)))}
                style={{ flex: 1, minWidth: 120 }}
              />
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={learn}>Detectar formato</button>
            <button className="secondary" onClick={() => { reset(); setOpen(false); }}>Cancelar</button>
          </div>

          {draft && parts && (
            <div style={{ display: "grid", gap: 8 }}>
              <p style={{ margin: 0, fontFamily: "monospace", fontSize: 18 }}>
                <span style={{ background: "#dbeafe", padding: "0 2px" }}>{sample.slice(0, draft.productLength)}</span>
                <span style={{ color: "#6b7280" }}>{sample.slice(draft.productLength, draft.weightStart)}</span>
                <span style={{ background: "#dcfce7", padding: "0 2px" }}>{sample.slice(draft.weightStart, draft.weightStart + draft.weightLength)}</span>
                <span style={{ color: "#6b7280" }}>{sample.slice(draft.weightStart + draft.weightLength)}</span>
              </p>
              <p style={{ margin: 0 }}>
                <span style={{ background: "#dbeafe", padding: "0 4px" }}>N.º de caja: {parts.productDigits}</span>{" "}
                <span style={{ background: "#dcfce7", padding: "0 4px" }}>Kilos: {parts.weightKg.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</span>
              </p>
              <span className="setting-help">Los números en gris (fecha, lote) no se usan.</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="setting-help">¿El número de caja tiene más o menos números?</span>
                <button className="secondary" onClick={() => setDraft((d) => (d && shiftProductCut(d, -1)) ?? d)}>Uno menos</button>
                <button className="secondary" onClick={() => setDraft((d) => (d && shiftProductCut(d, +1)) ?? d)}>Uno más</button>
              </div>
              <input name="box-format-name" autoComplete="off" placeholder="Nombre (ej. el frigorífico)" value={name} onChange={(e) => setName(e.target.value)} />
              <button disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar formato"}</button>
              <span className="setting-help">Después de guardar, asociá cada número de caja a su producto (abajo de este formato).</span>
            </div>
          )}
          {error && <p style={{ margin: 0, color: "#b42318", fontWeight: 700 }}>{error}</p>}
        </div>
      )}
    </SettingSection>
  );
}
