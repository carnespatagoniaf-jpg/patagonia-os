import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, MessageCircle, Search } from "lucide-react";
import { listLeads, scheduleLeads } from "./admin-service";
import { CONTACT_FILTERS, contactName, contactStatus, daysSinceTouch, matchesContact, type ContactFilter } from "./contacts";
import { formatDayMonth } from "./company-billing";
import { whatsappLink, type Lead } from "./sales-pipeline";
import { LeadImport } from "./LeadImport";
import { downloadCsv, toCsv } from "../../lib/csv";
import { todayIso } from "../shifts/format";

const TONE: Record<string, string> = { ok: "admin-trial-ok", soon: "admin-trial-soon", none: "admin-trial-none", expired: "admin-trial-expired" };

function touchLabel(days: number) {
  return days <= 0 ? "hoy" : days === 1 ? "ayer" : `hace ${days} días`;
}

/** Pestaña "Contactos": la agenda de todos los que alguna vez escribieron. Se
 * busca, se filtra y se elige a quiénes volver a escribirles (aparecen en
 * Ventas → "Para escribir hoy", de a pocos por día). */
export function AdminContacts({ onScheduled }: { onScheduled: () => void }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ContactFilter>("todos");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [perDay, setPerDay] = useState(20);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showImport, setShowImport] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setLeads(await listLeads());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los contactos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(
    () => leads.filter((l) => matchesContact(l, filter, query)).sort((a, b) => daysSinceTouch(a) - daysSinceTouch(b) || a.createdAt.localeCompare(b.createdAt)),
    [leads, filter, query]
  );
  const counts = useMemo(() => Object.fromEntries(CONTACT_FILTERS.map((f) => [f.id, leads.filter((l) => matchesContact(l, f.id, "")).length])), [leads]);
  const selectedVisible = visible.filter((l) => selected.has(l.id) && l.stage !== "alta");
  const allSelected = visible.length > 0 && visible.every((l) => selected.has(l.id) || l.stage === "alta");

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    const next = new Set(selected);
    if (allSelected) visible.forEach((l) => next.delete(l.id));
    else visible.forEach((l) => l.stage !== "alta" && next.add(l.id));
    setSelected(next);
  }

  async function schedule() {
    const ids = selectedVisible.map((l) => l.id);
    if (ids.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const n = await scheduleLeads(ids, perDay);
      const days = Math.ceil(n / perDay);
      setMessage(`Listo: ${n} ${n === 1 ? "contacto" : "contactos"} en Ventas → "Para escribir hoy"${days > 1 ? `, de a ${perDay} por día durante ${days} días` : ""}.`);
      setSelected(new Set());
      await reload();
      onScheduled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo agendar.");
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    downloadCsv(
      `contactos-patagonia-${todayIso()}.csv`,
      toCsv(
        ["Nombre", "Teléfono", "Estado", "De dónde", "Cargado", "Último contacto", "Nota"],
        visible.map((l) => [
          contactName(l), l.phone ?? "", contactStatus(l).label, l.source ?? "", formatDayMonth(l.createdAt),
          l.lastContactedAt ? formatDayMonth(l.lastContactedAt) : "", l.note ?? ""
        ])
      )
    );
  }

  return (
    <div className="contacts">
      <div className="admin-header">
        <h2 className="admin-group-title" style={{ margin: 0 }}>Contactos <span>{leads.length}</span></h2>
        <div className="admin-actions">
          <button className="secondary" onClick={exportCsv}><Download size={14} style={{ verticalAlign: "-2px" }} /> Bajar a Excel</button>
          <button onClick={() => setShowImport((v) => !v)}>{showImport ? "Cerrar" : "Cargar contactos"}</button>
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Todos los que alguna vez te escribieron quedan acá para siempre, contesten o no. Elegí a quiénes volver a escribirles y te aparecen en Ventas → "Para escribir hoy".
      </p>

      {showImport && (
        <LeadImport
          onClose={() => setShowImport(false)}
          onDone={(text) => {
            setShowImport(false);
            setMessage(text);
            void reload();
            onScheduled();
          }}
        />
      )}

      {message && <p className="admin-mp-ok">{message}</p>}
      {error && <div className="message warning">{error}</div>}

      <div className="admin-search">
        <Search size={16} />
        <input placeholder="Buscar por nombre, teléfono o nota" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="admin-actions">
        {CONTACT_FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? "" : "secondary"} onClick={() => setFilter(f.id)}>
            {f.label} ({counts[f.id] ?? 0})
          </button>
        ))}
      </div>

      <div className="contacts-bulk">
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={visible.length === 0} />
          Elegir los {visible.length} de la lista
        </label>
        {selectedVisible.length > 0 && (
          <>
            <select value={perDay} onChange={(e) => setPerDay(Number(e.target.value))}>
              {[10, 20, 30, 50].map((n) => <option key={n} value={n}>de a {n} por día</option>)}
            </select>
            <button disabled={busy} onClick={() => void schedule()}>
              <MessageCircle size={14} style={{ verticalAlign: "-2px" }} /> {busy ? "…" : `Volver a escribirles (${selectedVisible.length})`}
            </button>
          </>
        )}
      </div>

      {loading && leads.length === 0 && <p className="muted">Cargando…</p>}
      {!loading && visible.length === 0 && <p className="muted">No hay contactos con ese filtro.</p>}

      <div className="contacts-list">
        {visible.map((l) => {
          const status = contactStatus(l);
          const link = whatsappLink(l.phone, "");
          const days = daysSinceTouch(l);
          return (
            <div key={l.id} className="contacts-row">
              <input type="checkbox" checked={selected.has(l.id)} disabled={l.stage === "alta"} onChange={() => toggle(l.id)} aria-label={`Elegir ${contactName(l)}`} />
              <div className="contacts-main">
                <b>{contactName(l)}</b>
                <span className="muted">{l.phone ?? "sin teléfono"}</span>
              </div>
              <span className={`admin-trial ${TONE[status.tone]}`}>{status.label}</span>
              <span className="muted contacts-when">
                {l.lastContactedAt ? `Le escribiste ${touchLabel(days)}` : `Cargado ${touchLabel(days)}`}
                {l.nextContactOn && l.stage !== "perdido" && l.stage !== "alta" ? ` · próximo ${formatDayMonth(l.nextContactOn)}` : ""}
              </span>
              <span className="muted contacts-note">{l.note ?? ""}</span>
              {link && <a className="sales-wa-button" href={link.replace(/\?text=$/, "")} target="_blank" rel="noreferrer"><MessageCircle size={14} /> Abrir</a>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
