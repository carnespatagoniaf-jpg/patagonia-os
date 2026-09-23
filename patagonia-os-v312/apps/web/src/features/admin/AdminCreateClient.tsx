import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Building2, LockKeyhole, MapPin, Plus, Search } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { PROVINCES, createClient, deleteClient, listCompanies, setCompanyActive, setCompanyLocation, type CompanySummary, type CreateClientResult } from "./admin-service";

/** Mensaje listo para pegar en WhatsApp/mail y mandarle al dueño nuevo --
 * evita tener que copiar el usuario y la contraseña por separado a mano. */
function buildWelcomeMessage(companyName: string, result: CreateClientResult) {
  return `¡Hola! Ya está listo el acceso a Patagonia OS para ${companyName}.

Entrá en: https://app.patagoniasystem.com.ar
Usuario: ${result.email}
Contraseña temporal: ${result.tempPassword}

Te recomendamos cambiarla la primera vez que entres (arriba a la izquierda, "Cambiar contraseña").`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR");
}

interface Draft {
  companyName: string;
  branchName: string;
  ownerFullName: string;
  ownerEmail: string;
  contactPhone: string;
  province: string;
  city: string;
}

function emptyDraft(): Draft {
  return { companyName: "", branchName: "", ownerFullName: "", ownerEmail: "", contactPhone: "", province: "", city: "" };
}

const NO_LOCATION = "Sin ubicación";

function groupByProvince(list: CompanySummary[]) {
  const map = new Map<string, CompanySummary[]>();
  for (const c of list) {
    const key = c.province ?? NO_LOCATION;
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  return Array.from(map).sort(([a], [b]) => (a === NO_LOCATION ? 1 : b === NO_LOCATION ? -1 : a.localeCompare(b, "es")));
}

export function AdminCreateClient() {
  const { signOut } = useAuth();
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateClientResult | null>(null);
  const [resultCompanyName, setResultCompanyName] = useState("");
  const [copied, setCopied] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");

  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [editProvince, setEditProvince] = useState("");
  const [editCity, setEditCity] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);

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

  function startEditLocation(company: CompanySummary) {
    setEditingLocationId(company.id);
    setEditProvince(company.province ?? "");
    setEditCity(company.city ?? "");
  }

  async function saveLocation(company: CompanySummary) {
    setSavingLocation(true);
    try {
      await setCompanyLocation(company.id, editProvince, editCity);
      setEditingLocationId(null);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar la ubicación.");
    } finally {
      setSavingLocation(false);
    }
  }

  /** Borrado real (no desactivar) -- el servidor ya rechaza esto solo si la
   * empresa tiene cualquier actividad real cargada, así que acá solo hace
   * falta la confirmación de "estás seguro" antes de intentarlo. */
  async function handleDeleteClient(company: CompanySummary) {
    if (!window.confirm(`¿Borrar "${company.name}" para siempre? Esto no se puede deshacer. Si ya tiene productos, ventas o cualquier otro dato cargado, el sistema va a rechazar el borrado solo.`)) {
      return;
    }
    setMessage("");
    setDeletingId(company.id);
    try {
      await deleteClient(company.id);
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo borrar el cliente.");
    } finally {
      setDeletingId(null);
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
        ownerEmail: draft.ownerEmail.trim(),
        contactPhone: draft.contactPhone.trim() || undefined
      });
      if (draft.province || draft.city.trim()) {
        try {
          await setCompanyLocation(created.companyId, draft.province, draft.city);
        } catch {
          setMessage("El cliente se creó, pero no se pudo guardar la ubicación. Cargala desde la lista.");
        }
      }
      setResult(created);
      setResultCompanyName(draft.companyName.trim());
      setCopied(false);
      setDraft(emptyDraft());
      await reloadCompanies();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo crear el cliente.");
    } finally {
      setBusy(false);
    }
  }

  const term = search.trim().toLowerCase();
  const matches = (c: CompanySummary) =>
    !term || [c.name, c.ownerFullName, c.ownerEmail, c.city, c.province, c.contactPhone].some((v) => v?.toLowerCase().includes(term));

  const activeCompanies = useMemo(() => companies.filter((c) => c.active), [companies]);
  const inactiveCompanies = companies.filter((c) => !c.active && matches(c));
  const activeGroups = groupByProvince(activeCompanies.filter(matches));
  const provinceCount = new Set(activeCompanies.map((c) => c.province).filter(Boolean)).size;
  const withoutLocation = activeCompanies.filter((c) => !c.province).length;

  function renderCard(company: CompanySummary) {
    const editing = editingLocationId === company.id;
    return (
      <article key={company.id} className={`admin-card${company.active ? "" : " admin-card-off"}`}>
        <header className="admin-card-head">
          <h3>{company.name}</h3>
          {editing ? null : (
            <button className="admin-link" onClick={() => startEditLocation(company)}>
              <MapPin size={13} />
              {[company.city, company.province].filter(Boolean).join(", ") || "Agregar ubicación"}
            </button>
          )}
        </header>

        {editing && (
          <div className="admin-edit-location">
            <select value={editProvince} onChange={(e) => setEditProvince(e.target.value)}>
              <option value="">Provincia…</option>
              {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input placeholder="Ciudad" value={editCity} onChange={(e) => setEditCity(e.target.value)} />
            <div className="admin-actions">
              <button disabled={savingLocation} onClick={() => void saveLocation(company)}>{savingLocation ? "…" : "Guardar"}</button>
              <button className="secondary" onClick={() => setEditingLocationId(null)}>Cancelar</button>
            </div>
          </div>
        )}

        <dl className="admin-card-data">
          <div><dt>Dueño</dt><dd>{company.ownerFullName ?? "-"}</dd></div>
          <div><dt>Email</dt><dd>{company.ownerEmail ?? "-"}</dd></div>
          <div><dt>Teléfono</dt><dd>{company.contactPhone ?? "-"}</dd></div>
        </dl>

        <div className="admin-chips">
          <span>{company.branchCount} {company.branchCount === 1 ? "sucursal" : "sucursales"}</span>
          <span>{company.userCount} {company.userCount === 1 ? "usuario" : "usuarios"}</span>
          <span>Alta {formatDate(company.createdAt)}</span>
        </div>

        <div className="admin-actions">
          <button className="secondary" disabled={togglingId === company.id} onClick={() => void toggleActive(company)}>
            {togglingId === company.id ? "…" : company.active ? "Desactivar" : "Activar"}
          </button>
          <button className="danger" disabled={deletingId === company.id} onClick={() => void handleDeleteClient(company)}>
            {deletingId === company.id ? "…" : "Borrar"}
          </button>
        </div>
      </article>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div className="admin-brand">
          <div className="login-logo" style={{ margin: 0 }}><LockKeyhole /></div>
          <div>
            <p className="eyebrow">PATAGONIA OS · ADMIN</p>
            <h1>Clientes</h1>
          </div>
        </div>
        <div className="admin-actions">
          <button onClick={() => { setShowForm((v) => !v); setResult(null); }}>
            <Plus size={16} style={{ verticalAlign: "-3px" }} /> {showForm ? "Cerrar" : "Nuevo cliente"}
          </button>
          <button className="secondary" onClick={() => void signOut()}>Salir</button>
        </div>
      </header>

      <div className="admin-kpis">
        <div className="kpi-card"><span>Clientes activos</span><strong>{activeCompanies.length}</strong></div>
        <div className="kpi-card"><span>Provincias</span><strong>{provinceCount}</strong></div>
        <div className="kpi-card"><span>Sin ubicación</span><strong>{withoutLocation}</strong></div>
      </div>

      {(showForm || result) && (
        <section className="panel admin-form-panel">
          <div className="panel-title">
            <h2>{result ? "Cliente creado" : "Dar de alta un cliente"}</h2>
          </div>
          {result ? (
            <div className="message" style={{ borderColor: "#2f9e44" }}>
              Login del dueño: <strong>{result.email}</strong>
              <br />
              Contraseña temporal (copiala ahora, no se vuelve a mostrar):{" "}
              <code style={{ fontSize: 16, fontWeight: 700 }}>{result.tempPassword}</code>
              <div className="admin-actions" style={{ marginTop: 10 }}>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(buildWelcomeMessage(resultCompanyName, result));
                    setCopied(true);
                  }}
                >
                  {copied ? "¡Copiado!" : "Copiar mensaje para el cliente"}
                </button>
                <button className="secondary" onClick={() => setResult(null)}>Crear otro cliente</button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="admin-form">
              <label>Nombre del negocio<input value={draft.companyName} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} required /></label>
              <label>Nombre de la primera sucursal<input value={draft.branchName} onChange={(e) => setDraft({ ...draft, branchName: e.target.value })} required /></label>
              <label>Nombre del dueño<input value={draft.ownerFullName} onChange={(e) => setDraft({ ...draft, ownerFullName: e.target.value })} required /></label>
              <label>Email del dueño<input value={draft.ownerEmail} onChange={(e) => setDraft({ ...draft, ownerEmail: e.target.value })} type="email" required /></label>
              <label>
                Provincia (opcional)
                <select value={draft.province} onChange={(e) => setDraft({ ...draft, province: e.target.value })}>
                  <option value="">Sin especificar</option>
                  {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label>Ciudad (opcional)<input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} /></label>
              <label>Teléfono de contacto (opcional, uso interno)<input value={draft.contactPhone} onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} /></label>
              <div className="admin-form-submit">
                <button className="charge-button" disabled={busy}>{busy ? "Creando…" : "Crear cliente"}</button>
              </div>
            </form>
          )}
        </section>
      )}

      {message && <div className="message warning">{message}</div>}

      <div className="admin-search">
        <Search size={16} />
        <input placeholder="Buscar por negocio, dueño, mail, ciudad o provincia" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {companiesLoading && companies.length === 0 && <p className="muted">Cargando…</p>}
      {!companiesLoading && activeCompanies.length === 0 && <p className="muted">Todavía no diste de alta ningún cliente.</p>}
      {!companiesLoading && activeCompanies.length > 0 && activeGroups.length === 0 && <p className="muted">Ningún cliente coincide con la búsqueda.</p>}

      {activeGroups.map(([province, group]) => (
        <Fragment key={province}>
          <h2 className="admin-group-title"><Building2 size={16} /> {province} <span>{group.length}</span></h2>
          <div className="admin-grid">{group.map(renderCard)}</div>
        </Fragment>
      ))}

      {inactiveCompanies.length > 0 && (
        <details className="admin-inactive">
          <summary className="admin-group-title">Clientes desactivados <span>{inactiveCompanies.length}</span></summary>
          <div className="admin-grid" style={{ marginTop: 12 }}>{inactiveCompanies.map(renderCard)}</div>
        </details>
      )}
    </main>
  );
}
