import { useEffect, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { getEmployeeDiscount, setEmployeeDiscount } from "./employees-service";

// Descuento para empleados en los vales de mercadería de Mostrador (migración 215). Dueño o administrador.
export function EmployeeDiscount({ companyId, onMessage }: { companyId: string; onMessage: (text: string) => void }) {
  const [saved, setSaved] = useState<number | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void getEmployeeDiscount(companyId).then((pct) => {
      setSaved(pct);
      setValue(String(pct).replace(".", ","));
    });
  }, [companyId]);

  async function save() {
    const pct = Number(value.replace(",", ".") || "0");
    if (!(pct >= 0 && pct <= 50)) {
      onMessage("El descuento para empleados tiene que ser de 0 a 50 %.");
      return;
    }
    setBusy(true);
    try {
      const r = await setEmployeeDiscount(pct);
      setSaved(r);
      onMessage(r > 0 ? `Listo: los vales de mercadería se cobran con ${r.toLocaleString("es-AR")} % de descuento.` : "Listo: los vales de mercadería se cobran a precio normal.");
    } catch (err) {
      onMessage(err instanceof Error ? err.message : "No se pudo guardar el descuento.");
    } finally {
      setBusy(false);
    }
  }

  if (saved === null) return null;
  const changed = Number(value.replace(",", ".") || "0") !== saved;
  return (
    <div className="form-box" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: 0 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        Descuento en vales de mercadería
        <input type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 64 }} aria-label="Descuento para empleados (%)" /> %
      </label>
      {changed && <button disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar"}</button>}
    </div>
  );
}
