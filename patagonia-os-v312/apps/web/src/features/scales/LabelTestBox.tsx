import { useEffect, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { SYSTEL_PILOT_COMPANIES } from "../inventory/systel/systel-pilot";
import { DEFAULT_SCALE_CONFIG, type ScaleConfig } from "../sale/scale-barcode";
import { cachedScaleConfig, scaleConfigLoaded } from "../sale/scale-config-cache";
import { getBranchScaleConfig } from "../sale/scale-config-service";
import { loadSystelLabelTemplates, templatesFromSetups, type SystelLabelTemplates } from "../sale/systel-label-format";
import { noteLabelRead } from "./label-read";
import { labelTestResult, type LabelTestResult } from "./label-test";
import { loadScaleSetups, type ScaleSetup } from "./sale/scale-sale-service";

interface Formats {
  config: ScaleConfig;
  setups: ScaleSetup[];
  systelTemplates: SystelLabelTemplates[];
}

/**
 * Último paso de la instalación, en la misma pantalla de la balanza (antes decía "escaneala en Mostrador" y los
 * clientes no sabían dónde). Lee el código como Mostrador, no cobra ni toca stock, y si se lee bien marca el paso 5.
 */
export function LabelTestBox({ products, branchId, onDone }: { products: Product[]; branchId: string; onDone: () => void }) {
  const { profile } = useAuth();
  const pilot = SYSTEL_PILOT_COMPANIES.has(profile?.company_id ?? "");
  const [formats, setFormats] = useState<Formats | null>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<LabelTestResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const cached = cachedScaleConfig(branchId);
    void Promise.all([
      getBranchScaleConfig(branchId)
        .then((c) => scaleConfigLoaded(branchId, c).config)
        .catch(() => cached?.config ?? DEFAULT_SCALE_CONFIG),
      loadScaleSetups(branchId).catch(() => [] as ScaleSetup[])
    ]).then(([config, setups]) => {
      if (!alive) return;
      const fromDb = pilot ? templatesFromSetups(setups) : [];
      const local = pilot && fromDb.length === 0 ? loadSystelLabelTemplates() : null;
      setFormats({ config, setups, systelTemplates: fromDb.length > 0 ? fromDb : local ? [local] : [] });
    });
    return () => {
      alive = false;
    };
  }, [branchId, pilot]);

  function test() {
    if (!formats) return;
    const r = labelTestResult(code, { products, ...formats });
    setResult(r);
    setCode("");
    if (r?.ok) {
      noteLabelRead(branchId, r.detail.split(". ")[0]);
      onDone();
    }
    inputRef.current?.focus();
  }

  return (
    <div className="my-scale-label-test">
      <strong>Último paso: probá una etiqueta acá</strong>
      <ol className="muted">
        <li>Pesá algo en la balanza y que imprima la etiqueta (como en una venta).</li>
        <li>Hacé clic en el cuadro de abajo.</li>
        <li>Pasá el lector por el código de barras de la etiqueta. Sin lector: escribí los números de abajo de las barras y apretá Enter.</li>
      </ol>
      <p className="muted">Es solo una prueba: no se cobra nada ni se toca el stock.</p>
      <form
        className="my-scale-actions"
        onSubmit={(e) => {
          e.preventDefault();
          test();
        }}
      >
        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder={formats ? "Código de la etiqueta" : "Cargando…"}
          disabled={!formats}
          aria-label="Código de barras de la etiqueta"
        />
        <button type="submit" className="secondary" disabled={!formats || !code.trim()}>Probar</button>
      </form>
      {result && (
        <div className={`my-scale-label-result ${result.ok ? "ok" : "bad"}`}>
          {result.ok ? <CheckCircle2 size={18} /> : <TriangleAlert size={18} />}
          <div>
            <strong>{result.title}</strong>
            <span>{result.detail}</span>
          </div>
        </div>
      )}
    </div>
  );
}
