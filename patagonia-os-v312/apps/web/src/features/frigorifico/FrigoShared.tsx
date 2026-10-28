import { formatKg, stockByCamara, type FrigoCamara, type FrigoDt, type FrigoMedia, type FrigoSalida } from "./frigo-logic";

// Lo que comparten las pestañas del Frigorífico.

export interface FrigoData {
  camaras: FrigoCamara[];
  dts: FrigoDt[];
  medias: FrigoMedia[];
  salidas: FrigoSalida[];
}

/** Los errores de Supabase no son Error: traen el texto en .message. */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function CamaraCards({ data, selected, onSelect }: { data: FrigoData; selected?: string | null; onSelect?: (id: string | null) => void }) {
  const rows = stockByCamara(data.camaras.filter((c) => c.active), data.medias);
  if (rows.length === 0) return <p className="muted">Todavía no hay cámaras.</p>;
  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
      {rows.map(({ camara, count, kg }) => {
        const pct = camara.capacity ? Math.min(100, (count / camara.capacity) * 100) : 0;
        const active = selected === camara.id;
        return (
          <button
            key={camara.id}
            type="button"
            className="panel"
            onClick={onSelect ? () => onSelect(active ? null : camara.id) : undefined}
            style={{ textAlign: "left", padding: "12px 14px", cursor: onSelect ? "pointer" : "default", border: active ? "2px solid #8b1e1e" : undefined, color: "inherit" }}
          >
            <strong>{camara.name}</strong>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
              <span>{count} medias</span>
              <span>{formatKg(kg)} kg</span>
            </div>
            {camara.capacity && (
              <>
                <div style={{ height: 6, background: "#eef0f3", borderRadius: 3, marginTop: 8, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: pct >= 90 ? "#b45309" : "#8b1e1e" }} />
                </div>
                <small className="muted">{count} de {camara.capacity} lugares</small>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
