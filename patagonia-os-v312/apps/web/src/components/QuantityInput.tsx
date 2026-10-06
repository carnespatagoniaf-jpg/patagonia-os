import { useState, type CSSProperties } from "react";
import { parseQuantity } from "../features/sale/quantity";

/**
 * Cantidad (kilos o unidades) de un renglón: acepta coma o punto ("0,750"), al
 * borrarla queda vacía (antes volvía a mostrar "0" y se escribía detrás del cero)
 * y al tocarla se selecciona entera. Solo avisa cuando hay un número mayor que 0;
 * si se sale del campo sin un número válido, vuelve a mostrar la cantidad anterior.
 */
export function QuantityInput({ value, onChange, className, style, ariaLabel }: {
  value: number;
  onChange: (quantity: number) => void;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      style={style}
      aria-label={ariaLabel}
      value={draft ?? String(value).replace(".", ",")}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        setDraft(e.target.value);
        const q = parseQuantity(e.target.value);
        if (q > 0) onChange(q);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
