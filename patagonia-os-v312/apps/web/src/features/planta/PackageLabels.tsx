import { useEffect, useState } from "react";
import { formatMoney } from "../shifts/format";
import { code39Bars, packagePrice } from "./planta-logic";

// Etiquetas de los paquetes (migración 194). Code 39: lo lee cualquier pistola sin configurar nada, igual que las
// del Frigorífico. Dos formas de imprimir: una etiqueta por hoja (impresora de etiquetas, 60 × 40 mm) u hoja A4.

export interface LabelData {
  code: string;
  productName: string;
  unit: "kg" | "unit" | "box";
  quantity: number;
  unitPrice: number;
  packedOn: string;
  expiresOn: string | null;
  lot: string | null;
}

const FOOTER_KEY = "patagonia-planta-label-footer";
const MODE_KEY = "patagonia-planta-label-mode";

function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // sin almacenamiento (ventana privada): se usa solo esta vez
  }
}

const day = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const qty = (n: number) => n.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

function Barcode({ code }: { code: string }) {
  const { bars, width } = code39Bars(code);
  return (
    <svg viewBox={`0 0 ${width} 40`} preserveAspectRatio="none" className="planta-label-bars" aria-hidden="true">
      {bars.map((b, i) => <rect key={i} x={b.x} y={0} width={b.w} height={40} fill="#000" />)}
    </svg>
  );
}

export function PackageLabels({ labels, autoPrint = false, onClose }: { labels: LabelData[]; autoPrint?: boolean; onClose: () => void }) {
  const [printing, setPrinting] = useState(autoPrint);
  const [mode, setMode] = useState(() => readStored(MODE_KEY, "etiquetadora"));
  const [footer, setFooter] = useState(() => readStored(FOOTER_KEY, "Mantener refrigerado entre 0 y 4 °C"));

  useEffect(() => {
    if (!printing) return;
    window.print();
    setPrinting(false);
  }, [printing]);

  const onePerPage = mode === "etiquetadora";
  return (
    <section className={`panel ${printing ? "print-area" : ""}`} style={{ marginTop: 18 }}>
      {printing && onePerPage && <style>{"@page { size: 60mm 40mm; margin: 0; }"}</style>}
      <div className="panel-title no-print" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>{labels.length === 1 ? "1 etiqueta" : `${labels.length} etiquetas`}</h2>
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => setPrinting(true)}>Imprimir</button>
          <button className="secondary" onClick={onClose}>Cerrar</button>
        </span>
      </div>
      <div className="form-grid no-print" style={{ marginBottom: 12 }}>
        <label>
          Impresora
          <select value={mode} onChange={(e) => { setMode(e.target.value); store(MODE_KEY, e.target.value); }}>
            <option value="etiquetadora">De etiquetas (60 × 40 mm, una por etiqueta)</option>
            <option value="a4">Hoja A4 (varias por hoja)</option>
          </select>
        </label>
        <label>
          Texto al pie (SENASA, conservación)
          <input value={footer} maxLength={90} onChange={(e) => { setFooter(e.target.value); store(FOOTER_KEY, e.target.value); }} />
        </label>
      </div>
      <div className={`planta-labels ${onePerPage ? "one-per-page" : ""}`}>
        {labels.map((l) => (
          <div key={l.code} className="planta-label">
            <div className="planta-label-name">{l.productName}</div>
            <div className="planta-label-row">
              <span className="planta-label-qty">{l.unit === "kg" ? `${qty(l.quantity)} kg` : `${l.quantity} u.`}</span>
              <span className="planta-label-price">
                {formatMoney(packagePrice(l.quantity, l.unitPrice))}
                {l.unit === "kg" && <small>{formatMoney(l.unitPrice)}/kg</small>}
              </span>
            </div>
            <div className="planta-label-meta">
              Envasado {day(l.packedOn)}{l.expiresOn && <> · <b>Vence {day(l.expiresOn)}</b></>}
              {l.lot && <><br />Lote {l.lot}</>}
            </div>
            <Barcode code={l.code} />
            <div className="planta-label-code">{l.code}</div>
            {footer && <div className="planta-label-foot">{footer}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
