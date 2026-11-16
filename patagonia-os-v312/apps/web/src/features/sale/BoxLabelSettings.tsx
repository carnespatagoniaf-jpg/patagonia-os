import { useState } from "react";
import type { Product } from "@patagonia/domain";
import { SettingSection } from "../../components/SettingSection";
import { quantityNumber } from "./quantity";
import { learnBoxLabelFormat, readWithFormat, resolveBoxScan, restoreLeadingZero, shiftProductCut, type BoxLabelFormat } from "./box-label";
import { deleteBoxLabelFormat, notifyBoxFormatsChanged, saveBoxLabelFormat, useBoxLabelFormats } from "./box-label-service";

type Draft = Omit<BoxLabelFormat, "id" | "name">;

/**
 * Etiquetas de cajas envasadas al vacío (migración 198), en el engranaje de Mostrador. Se aprende el formato con dos
 * cajas de productos distintos: el código y los kilos que dice cada una. Después se muestra qué es cada parte del
 * código y se puede probar otra caja antes de guardar.
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
    const r = resolveBoxScan(code, list, products);
    if (!r) setTestResult(`"${code}" no tiene la forma de ninguna caja cargada.`);
    else setTestResult(r.type === "error" ? r.message : `Se lee bien: ${r.detail}.`);
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
        Para las cajas envasadas al vacío que traen una etiqueta con el producto y el peso (la imprime el frigorífico, no tu balanza). Una vez cargado el formato, escaneás la caja en Mostrador y entra el producto con los kilos de la caja.
      </p>

      {formats.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {formats.map((f) => (
            <li key={f.id}>
              <b>{f.name}</b>: producto = números {f.productStart + 1} a {f.productStart + f.productLength}, kilos = números {f.weightStart + 1} a {f.weightStart + f.weightLength}
              {f.fixedText ? `, fijo ${f.fixedText}` : ""}
              {canEdit && (
                <button className="secondary" style={{ marginLeft: 8 }} onClick={() => void remove(f)}>Borrar</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
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
        <button onClick={() => { reset(); setOpen(true); }}>+ Agregar formato de cajas</button>
      )}

      {canEdit && open && (
        <div className="form-box" style={{ display: "grid", gap: 10, maxWidth: 520 }}>
          <p className="setting-help" style={{ margin: 0 }}>
            Agarrá <b>dos cajas de productos distintos</b>. Escaneá el código de cada una y escribí el <b>peso neto</b> que dice su etiqueta.
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
                <span style={{ background: "#dbeafe", padding: "0 4px" }}>Producto: {parts.productDigits}</span>{" "}
                <span style={{ background: "#dcfce7", padding: "0 4px" }}>Kilos: {parts.weightKg.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</span>
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="setting-help">¿El producto tiene más o menos números?</span>
                <button className="secondary" onClick={() => setDraft((d) => (d && shiftProductCut(d, codes[0], -1)) ?? d)}>Uno menos</button>
                <button className="secondary" onClick={() => setDraft((d) => (d && shiftProductCut(d, codes[0], +1)) ?? d)}>Uno más</button>
              </div>
              <p className="setting-help" style={{ margin: 0 }}>
                En Stock, cada producto tiene que tener como código el número de producto de la caja ({parts.productDigits} o {String(parseInt(parts.productDigits, 10))}). Un producto por kg entra con los kilos de la caja; uno por unidad o por caja entra como 1.
              </p>
              <input name="box-format-name" autoComplete="off" placeholder="Nombre (ej. el frigorífico)" value={name} onChange={(e) => setName(e.target.value)} />
              <button disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar formato"}</button>
            </div>
          )}
          {error && <p style={{ margin: 0, color: "#b42318", fontWeight: 700 }}>{error}</p>}
        </div>
      )}
    </SettingSection>
  );
}
