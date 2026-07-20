import { useCallback, useEffect, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { createClient, listCompanies, setCompanyActive, type CompanySummary, type CreateClientResult } from "./admin-service";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR");
}

interface Draft {
  companyName: string;
  branchName: string;
  ownerFullName: string;
  ownerEmail: string;
}

function emptyDraft(): Draft {
  return { companyName: "", branchName: "", ownerFullName: "", ownerEmail: "" };
}

export function AdminCreateClient() {
  const { signOut } = useAuth();
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateClientResult | null>(null);

  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const reloadCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    try {
      setCompanies(await listCompanies());
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadCompanies();
  }, [reloadCompanies]);

  async function toggleActive(company: CompanySummary) {
    setTogglingId(company.id);
    try {
      await setCompanyActive(company.id, !company.active);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar el cliente.");
    } finally {
      setTogglingId(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    if (!draft.companyName.trim()) { setMessage("Ingresá el nombre del negocio."); return; }
    if (!draft.branchName.trim()) { setMessage("Ingresá el nombre de la primera sucursal."); return; }
    if (!draft.ownerFullName.trim()) { setMessage("Ingresá el nombre del dueño."); return; }
    if (!draft.ownerEmail.trim()) { setMessage("Ingresá el email del dueño."); return; }

    setBusy(true);
    try {
      const created = await createClient({
        companyName: draft.companyName.trim(),
        branchName: draft.branchName.trim(),
        ownerFullName: draft.ownerFullName.trim(),
        ownerEmail: draft.ownerEmail.trim()
      });
      setResult(created);
      setDraft(emptyDraft());
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo crear el cliente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page" style={{ alignItems: "flex-start", paddingTop: 48, paddingBottom: 48 }}>
      <div style={{ display: "grid", gap: 24, width: "min(880px, 100%)" }}>
      <section className="login-card" style={{ width: "min(430px, 100%)", margin: "0 auto" }}>
        <div className="login-logo"><LockKeyhole /></div>
        <p className="eyebrow">PATAGONIA OS · ADMIN</p>
        <h1>Dar de alta un cliente</h1>
        <p className="muted">Crea la empresa, su primera sucursal y el login del dueño.</p>

        {result ? (
          <div className="message" style={{ borderColor: "#2f9e44" }}>
            Cliente creado. Login del dueño: <strong>{result.email}</strong>
            <br />
            Contraseña temporal (copiala ahora, no se vuelve a mostrar):{" "}
            <code style={{ fontSize: 16, fontWeight: 700 }}>{result.tempPassword}</code>
            <br />
            <button className="secondary" style={{ marginTop: 10 }} onClick={() => setResult(null)}>Crear otro cliente</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label>
              Nombre del negocio
              <input value={draft.companyName} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} required />
            </label>
            <label>
              Nombre de la primera sucursal
              <input value={draft.branchName} onChange={(e) => setDraft({ ...draft, branchName: e.target.value })} required />
            </label>
            <label>
              Nombre del dueño
              <input value={draft.ownerFullName} onChange={(e) => setDraft({ ...draft, ownerFullName: e.target.value })} required />
            </label>
            <label>
              Email del dueño
              <input value={draft.ownerEmail} onChange={(e) => setDraft({ ...draft, ownerEmail: e.target.value })} type="email" required />
            </label>
            <button className="charge-button" disabled={busy}>
              {busy ? "Creando…" : "Crear cliente"}
            </button>
          </form>
        )}

        {message && <div className="message warning">{message}</div>}

        <button className="login-link-button" onClick={() => void signOut()}>Salir</button>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>Clientes</h2>
          <span>{companiesLoading ? "Cargando…" : `${companies.length} clientes`}</span>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Negocio</th>
              <th className="num">Sucursales</th>
              <th className="num">Usuarios</th>
              <th>Alta</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {companies.map((company) => (
              <tr key={company.id}>
                <td>{company.name}</td>
                <td className="num">{company.branchCount}</td>
                <td className="num">{company.userCount}</td>
                <td>{formatDate(company.createdAt)}</td>
                <td>{company.active ? "Activo" : "Inactivo"}</td>
                <td>
                  <button
                    className="secondary"
                    disabled={togglingId === company.id}
                    onClick={() => toggleActive(company)}
                  >
                    {togglingId === company.id ? "…" : company.active ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {companies.length === 0 && !companiesLoading && <p className="muted">Todavía no diste de alta ningún cliente.</p>}
      </section>
      </div>
    </main>
  );
}
