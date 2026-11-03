import { useMemo, useState } from "react";
import { formatQty, type TransferUnit } from "./transfer-logic";

export interface PickableProduct {
  id: string;
  name: string;
  code: string | null;
  unit: TransferUnit;
  /** Stock en el local que se muestra al lado (null = no se muestra). */
  stock: number | null;
}

function plain(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Buscador de productos por nombre o código (mismo estilo que Mostrador). */
export function ProductSearch({ products, placeholder, exclude, onPick }: { products: PickableProduct[]; placeholder: string; exclude: Set<string>; onPick: (p: PickableProduct) => void }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = plain(query);
    if (!q) return [];
    return products.filter((p) => !exclude.has(p.id) && (plain(p.name).includes(q) || plain(p.code ?? "") === q || plain(p.code ?? "").startsWith(q))).slice(0, 8);
  }, [products, query, exclude]);

  return (
    <div className="pos-search-wrap">
      <input className="pos-search" placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
      {matches.length > 0 && (
        <div className="pos-dropdown">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              className="pos-dropdown-item"
              onClick={() => {
                onPick(p);
                setQuery("");
              }}
            >
              <span>
                {p.name} {p.code && <span className="muted">({p.code})</span>}
              </span>
              {p.stock !== null && <strong>{formatQty(p.stock, p.unit)}</strong>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
