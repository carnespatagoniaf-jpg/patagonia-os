import { useState } from "react";
import { supabase } from "../../lib/supabase";
import type { TransferBranch } from "../transfers/transfers-service";

// Sucursales → Abrir un local (plan Empresa, migración 192): crea el local copiando la configuración de otro.
// El stock arranca en cero (se llena con un envío); los cajeros y el punto de venta se cargan aparte.

const OPTIONS: Array<[key: string, label: string, detail: string]> = [
  ["accounts", "Cuentas de caja", "las del local de origen, nuevas y en $0, con el nombre del local nuevo"],
  ["mins", "Mínimos de stock", "los mínimos de cada producto"],
  ["zone", "Zona de precios", "la misma zona que el local de origen"],
  ["scale", "Etiquetas de la balanza", "el formato del código de barras"],
  ["managers", "Encargados", "los encargados del local de origen también quedan a cargo de este"]
];

export function NewBranchCopy({ branches, onCreated }: { branches: TransferBranch[]; onCreated: (id: string, text: string) => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState(branches[0]?.id ?? "");
  const [copy, setCopy] = useState<Record<string, boolean>>({ accounts: true, mins: true, zone: true, scale: true, managers: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setError("");
    if (!name.trim()) return setError("Poné el nombre del local.");
    if (!source) return setError("Elegí de qué local copiar.");
    if (!supabase) return;
    setBusy(true);
    const { data, error: rpcError } = await supabase.rpc("create_branch_copy", { p_name: name, p_source_branch_id: source, p_copy: copy });
    setBusy(false);
    if (rpcError) return setError(rpcError.message);
    const r = data as { id: string; accounts: number; mins: number; managers: number };
    const parts = [r.accounts > 0 && `${r.accounts} cuentas de caja`, r.mins > 0 && `${r.mins} mínimos`, r.managers > 0 && `${r.managers} encargados`].filter(Boolean);
    onCreated(r.id, `Listo: se abrió ${name.trim()}${parts.length ? ` con ${parts.join(", ")}` : ""}. El stock arranca en cero: llenalo con un envío desde la Planta. Los cajeros se crean en Usuarios y el punto de venta en Facturas.`);
    setName("");
  }

  return (
    <section className="panel" style={{ maxWidth: 720 }}>
      <div className="panel-title">
        <h2>Abrir un local nuevo</h2>
      </div>
      {error && <div className="message warning">{error}</div>}
      <div className="form-grid">
        <label>
          Nombre
          <input value={name} maxLength={60} placeholder="Ej. Godoy Cruz" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Copiar la configuración de
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
        {OPTIONS.map(([key, label, detail]) => (
          <label key={key} className="transfers-check" style={{ whiteSpace: "normal" }}>
            <input type="checkbox" checked={copy[key] ?? false} onChange={(e) => setCopy((c) => ({ ...c, [key]: e.target.checked }))} />
            <span>
              {label} <span className="muted">({detail})</span>
            </span>
          </label>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>No se copian: el stock (arranca en cero), los cajeros (cada local tiene los suyos) ni el punto de venta para facturar (se da de alta en ARCA).</p>
      <div className="form-actions">
        <button className="charge-button" disabled={busy} onClick={() => void create()}>{busy ? "Creando…" : "Crear local"}</button>
      </div>
    </section>
  );
}
