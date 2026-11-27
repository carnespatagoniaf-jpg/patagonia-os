import type { LabelChoiceOption } from "./scale-label-choice";

/**
 * Etiqueta de balanza AMBIGUA (regla de oro, 26/11): el código se puede leer de dos maneras válidas distintas, así que
 * no se agregó nada. La persona mira el nombre impreso en el papel y elige una lectura, o la carga a mano.
 * No hay opción por defecto: ningún botón toma el foco, así que Enter no elige nada. Lo usan Mostrador y Clientes.
 */
export function ScaleLabelChoice({ options, note, onPick, onManual }: {
  options: LabelChoiceOption[];
  note?: string;
  onPick: (index: number) => void;
  onManual: () => void;
}) {
  return (
    <div className="pos-manual-card" role="group" aria-label="Elegí qué es la etiqueta" style={{ display: "grid", gap: 8, border: "2px solid #b45309" }}>
      <strong>
        {options.length > 1
          ? "Esta etiqueta se puede leer de dos maneras. Mirá el nombre impreso en el papel y elegí:"
          : "Esta etiqueta no es segura. Mirá el papel: ¿es esto?"}
      </strong>
      {options.map((o, i) => (
        <button key={i} type="button" className="secondary" style={{ textAlign: "left" }} onClick={() => onPick(i)}>
          <b>{o.title}</b>
          {o.detail && (
            <>
              <br />
              <span className="muted">{o.detail}</span>
            </>
          )}
        </button>
      ))}
      {note && <span className="muted" style={{ fontSize: 13 }}>{note}</span>}
      <button type="button" className="secondary" onClick={onManual}>
        Ninguna: lo cargo a mano
      </button>
    </div>
  );
}
