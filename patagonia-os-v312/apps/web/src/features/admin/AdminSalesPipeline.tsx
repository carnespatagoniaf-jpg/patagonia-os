import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageCircle, Plus } from "lucide-react";
import { PROVINCES, deleteLead, listLeads, listSalesPipeline, saveLead, setCompanySalesFollowup, type CompanySummary, type LeadInput } from "./admin-service";
import {
  PIPELINE_STAGES, companyStage, followUpsForToday, funnelCounts, whatsappLink,
  type CompanyUsage, type FollowUp, type Lead, type PipelineCompany, type PipelineStage
} from "./sales-pipeline";
import { formatDayMonth } from "./company-billing";
import { todayIso } from "../shifts/format";

const SOURCES = ["Instagram", "Facebook", "WhatsApp", "Recomendación", "Visita al local", "Otro"];
const LOST_REASONS = ["Le pareció caro", "Usa otro sistema", "No tiene tiempo ahora", "No le sirve", "No contestó más", "Otro"];

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysAgoLabel(iso: string | null) {
  if (!iso) return "nunca";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "hoy" : days === 1 ? "ayer" : `hace ${days} días`;
}

function percent(part: number, total: number) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "-";
}

function emptyLead(): LeadInput {
  return {
    id: null, businessName: "", contactName: "", phone: "", province: "", city: "", stage: "contacto", source: "",
    note: "", nextContactOn: addDays(todayIso(), 2), lostReason: null, companyId: null
  };
}

interface Props {
  companies: CompanySummary[];
  /** Abre el formulario "Nuevo cliente" de la pestaña Clientes con los datos del interesado. */
  onCreateFromLead: (lead: Lead) => void;
  /** Cambia cuando se crea un cliente, para volver a leer interesados y uso. */
  reloadKey: number;
}

export function AdminSalesPipeline({ companies, onCreateFromLead, reloadKey }: Props) {
  const [usage, setUsage] = useState<Record<string, CompanyUsage>>({});
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stage, setStage] = useState<PipelineStage>("sin_arrancar");
  const [leadDraft, setLeadDraft] = useState<LeadInput | null>(null);
  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [lostDraft, setLostDraft] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [u, l] = await Promise.all([listSalesPipeline(), listLeads()]);
      setUsage(u);
      setLeads(l);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo cargar el embudo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const today = todayIso();
  const pipelineCompanies: PipelineCompany[] = useMemo(
    () =>
      companies.map((c) => ({
        id: c.id, name: c.name, active: c.active, createdAt: c.createdAt, ownerFullName: c.ownerFullName,
        contactPhone: c.contactPhone, trialEndsAt: c.trialEndsAt, paidUntil: c.paidUntil, usage: usage[c.id] ?? null
      })),
    [companies, usage]
  );

  const followUps = useMemo(() => followUpsForToday(pipelineCompanies, leads, today), [pipelineCompanies, leads, today]);
  const last30 = funnelCounts(pipelineCompanies, addDays(today, -30));
  const total = funnelCounts(pipelineCompanies);

  const companiesByStage = new Map<PipelineStage, PipelineCompany[]>();
  for (const c of pipelineCompanies) {
    const s = companyStage(c, today);
    companiesByStage.set(s, [...(companiesByStage.get(s) ?? []), c]);
  }
  const leadsByStage = (s: PipelineStage) => leads.filter((l) => (s === "perdido" ? l.stage === "perdido" : l.stage === s));
  const stageCount = (s: PipelineStage) => (companiesByStage.get(s)?.length ?? 0) + leadsByStage(s).length;

  async function run(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setMessage("");
    try {
      await action();
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar.");
    } finally {
      setBusyId(null);
    }
  }

  function leadToInput(lead: Lead): LeadInput {
    const { createdAt: _createdAt, ...rest } = lead;
    return rest;
  }

  function markContacted(f: FollowUp) {
    if (f.companyId) {
      const u = usage[f.companyId];
      void run(f.companyId, () => setCompanySalesFollowup({ companyId: f.companyId!, note: u?.salesNote ?? null, lostReason: u?.salesLostReason ?? null, markContacted: true }));
    } else if (f.leadId) {
      const lead = leads.find((l) => l.id === f.leadId);
      if (lead) void run(lead.id, async () => { await saveLead({ ...leadToInput(lead), nextContactOn: addDays(today, 3) }); });
    }
  }

  function copy(key: string, text: string) {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
  }

  async function submitLead(event: React.FormEvent) {
    event.preventDefault();
    if (!leadDraft) return;
    if (!leadDraft.businessName.trim()) {
      setMessage("Ingresá el nombre del negocio.");
      return;
    }
    const draft = leadDraft;
    await run(draft.id ?? "new-lead", async () => {
      await saveLead(draft);
      setLeadDraft(null);
    });
  }

  function startEditCompany(c: PipelineCompany) {
    setEditingCompanyId(c.id);
    setNoteDraft(c.usage?.salesNote ?? "");
    setLostDraft(c.usage?.salesLostReason ?? "");
  }

  function renderFollowUp(f: FollowUp) {
    const key = f.companyId ?? f.leadId ?? f.name;
    const link = whatsappLink(f.phone, f.message);
    return (
      <article key={key} className="admin-card sales-followup">
        <div className="admin-trial-row">
          <span className={`admin-trial ${f.priority <= 1 ? "admin-trial-expired" : f.priority <= 3 ? "admin-trial-soon" : "admin-trial-none"}`}>{f.title}</span>
          <span className="muted" style={{ fontSize: 12 }}>{f.phone ?? "sin teléfono"}</span>
        </div>
        <strong>{f.name}</strong>
        <span className="muted" style={{ fontSize: 13 }}>{f.reason}</span>
        <details>
          <summary className="admin-link">Ver mensaje</summary>
          <p className="sales-message">{f.message}</p>
        </details>
        <div className="admin-actions">
          {link ? (
            <a className="sales-wa-button" href={link} target="_blank" rel="noreferrer"><MessageCircle size={14} /> Abrir WhatsApp</a>
          ) : null}
          <button className="secondary" onClick={() => copy(key, f.message)}>{copiedKey === key ? "¡Copiado!" : "Copiar mensaje"}</button>
          <button className="secondary" disabled={busyId === key} onClick={() => markContacted(f)}>{busyId === key ? "…" : "Ya le escribí"}</button>
        </div>
      </article>
    );
  }

  function renderLeadCard(lead: Lead) {
    const busy = busyId === lead.id;
    return (
      <article key={lead.id} className="admin-card">
        <header className="admin-card-head">
          <h3>{lead.businessName}</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            {[lead.contactName, lead.phone, [lead.city, lead.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "Sin datos de contacto"}
          </span>
        </header>
        {lead.note && <p className="sales-message">{lead.note}</p>}
        <div className="admin-chips">
          {lead.source && <span>{lead.source}</span>}
          {lead.nextContactOn && lead.stage !== "perdido" && <span>Escribirle el {formatDayMonth(lead.nextContactOn)}</span>}
          {lead.lostReason && <span>{lead.lostReason}</span>}
          <span>Cargado {daysAgoLabel(lead.createdAt)}</span>
        </div>
        <div className="admin-actions">
          {lead.stage === "contacto" && (
            <button className="secondary" disabled={busy} onClick={() => void run(lead.id, async () => { await saveLead({ ...leadToInput(lead), stage: "demo" }); })}>Ya vio la demo</button>
          )}
          {lead.stage !== "perdido" && <button disabled={busy} onClick={() => onCreateFromLead(lead)}>Dar de alta</button>}
          <button className="secondary" onClick={() => setLeadDraft(leadToInput(lead))}>Editar</button>
          {lead.stage === "perdido" ? (
            <button className="secondary" disabled={busy} onClick={() => void run(lead.id, async () => { await saveLead({ ...leadToInput(lead), stage: "contacto", lostReason: null, nextContactOn: today }); })}>Recuperar</button>
          ) : (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt(`¿Por qué no sigue ${lead.businessName}? (${LOST_REASONS.join(", ")})`, LOST_REASONS[0]);
                if (reason === null) return;
                void run(lead.id, async () => { await saveLead({ ...leadToInput(lead), stage: "perdido", lostReason: reason.trim() || "Otro" }); });
              }}
            >
              Perdido
            </button>
          )}
          {lead.stage === "perdido" && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`¿Borrar a ${lead.businessName} de la lista?`)) void run(lead.id, () => deleteLead(lead.id));
              }}
            >
              Borrar
            </button>
          )}
        </div>
      </article>
    );
  }

  function renderCompanyCard(c: PipelineCompany) {
    const u = c.usage;
    const editing = editingCompanyId === c.id;
    const busy = busyId === c.id;
    return (
      <article key={c.id} className={`admin-card${c.active ? "" : " admin-card-off"}`}>
        <header className="admin-card-head">
          <h3>{c.name}</h3>
          <span className="muted" style={{ fontSize: 13 }}>{[c.ownerFullName, c.contactPhone].filter(Boolean).join(" · ") || "-"}</span>
        </header>
        <div className="admin-chips">
          <span>{u?.productCount ?? 0} productos</span>
          <span>{u?.saleCount ?? 0} ventas{u && u.salesLast7d > 0 ? ` (${u.salesLast7d} esta semana)` : ""}</span>
          <span>{u?.closedShiftCount ?? 0} cierres de caja</span>
          <span>{u?.purchaseCount ?? 0} compras</span>
          <span>Entró {daysAgoLabel(u?.lastSignInAt ?? null)}</span>
          <span>Alta {daysAgoLabel(c.createdAt)}</span>
          {u?.salesContactedAt && <span>Le escribiste {daysAgoLabel(u.salesContactedAt)}</span>}
          {!c.active && <span>Desactivado</span>}
        </div>
        {u?.salesLostReason && <span className="admin-trial admin-trial-expired" style={{ justifySelf: "start" }}>Perdido: {u.salesLostReason}</span>}
        {u?.salesNote && !editing && <p className="sales-message">{u.salesNote}</p>}
        {editing ? (
          <div className="admin-edit-location">
            <textarea rows={3} placeholder="Nota (qué hablaron, qué necesita, cuándo volver a escribirle)" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} />
            <label className="admin-pay-field">
              Perdido (dejar vacío si sigue)
              <input list="sales-lost-reasons" value={lostDraft} onChange={(e) => setLostDraft(e.target.value)} placeholder="Motivo" />
            </label>
            <div className="admin-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void run(c.id, async () => {
                    await setCompanySalesFollowup({ companyId: c.id, note: noteDraft, lostReason: lostDraft, markContacted: false });
                    setEditingCompanyId(null);
                  })
                }
              >
                {busy ? "…" : "Guardar"}
              </button>
              <button className="secondary" onClick={() => setEditingCompanyId(null)}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div className="admin-actions">
            <button className="secondary" onClick={() => startEditCompany(c)}>{u?.salesNote || u?.salesLostReason ? "Editar nota" : "Agregar nota"}</button>
          </div>
        )}
      </article>
    );
  }

  const stageCompanies = companiesByStage.get(stage) ?? [];
  const stageLeads = leadsByStage(stage);

  return (
    <div className="sales-pipeline">
      <datalist id="sales-lost-reasons">{LOST_REASONS.map((r) => <option key={r} value={r} />)}</datalist>

      <section className="panel sales-funnel">
        <div className="panel-title"><h2>Cómo vienen las pruebas</h2></div>
        <div className="sales-funnel-steps">
          {(
            [
              ["Altas", last30.altas, total.altas, null],
              ["Cargaron productos", last30.cargaron, total.cargaron, last30.altas],
              ["Vendieron", last30.vendieron, total.vendieron, last30.altas],
              ["Pagaron", last30.pagaron, total.pagaron, last30.altas]
            ] as [string, number, number, number | null][]
          ).map(([label, value, all, base]) => (
            <div key={label} className="kpi-card">
              <span>{label}</span>
              <strong>{value}{base !== null ? <small> ({percent(value, base)})</small> : null}</strong>
              <span className="muted" style={{ fontSize: 12 }}>Últimos 30 días · {all} en total</span>
            </div>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          La meta es que cada prueba cargue productos y haga su primera venta en los primeros 2 días. El que vende, paga.
        </span>
      </section>

      {message && <div className="message warning">{message}</div>}

      <section className="sales-today">
        <h2 className="admin-group-title">Para escribir hoy <span>{followUps.length}</span></h2>
        {loading && followUps.length === 0 && <p className="muted">Cargando…</p>}
        {!loading && followUps.length === 0 && <p className="muted">Nadie pendiente por hoy. 👌</p>}
        <div className="admin-grid">{followUps.map(renderFollowUp)}</div>
      </section>

      <div className="admin-header">
        <h2 className="admin-group-title" style={{ margin: 0 }}>Etapas</h2>
        <div className="admin-actions">
          <button onClick={() => setLeadDraft(leadDraft ? null : emptyLead())}>
            <Plus size={16} style={{ verticalAlign: "-3px" }} /> {leadDraft ? "Cerrar" : "Nuevo interesado"}
          </button>
        </div>
      </div>

      {leadDraft && (
        <section className="panel admin-form-panel">
          <div className="panel-title"><h2>{leadDraft.id ? "Editar interesado" : "Nuevo interesado"}</h2></div>
          <form onSubmit={(e) => void submitLead(e)} className="admin-form">
            <label>Nombre del negocio<input value={leadDraft.businessName} onChange={(e) => setLeadDraft({ ...leadDraft, businessName: e.target.value })} required /></label>
            <label>Nombre de la persona<input value={leadDraft.contactName ?? ""} onChange={(e) => setLeadDraft({ ...leadDraft, contactName: e.target.value })} /></label>
            <label>Teléfono (WhatsApp)<input value={leadDraft.phone ?? ""} onChange={(e) => setLeadDraft({ ...leadDraft, phone: e.target.value })} /></label>
            <label>
              De dónde vino
              <select value={leadDraft.source ?? ""} onChange={(e) => setLeadDraft({ ...leadDraft, source: e.target.value })}>
                <option value="">Sin especificar</option>
                {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>
              Provincia
              <select value={leadDraft.province ?? ""} onChange={(e) => setLeadDraft({ ...leadDraft, province: e.target.value })}>
                <option value="">Sin especificar</option>
                {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>Ciudad<input value={leadDraft.city ?? ""} onChange={(e) => setLeadDraft({ ...leadDraft, city: e.target.value })} /></label>
            <label>
              Etapa
              <select value={leadDraft.stage} onChange={(e) => setLeadDraft({ ...leadDraft, stage: e.target.value as LeadInput["stage"] })}>
                <option value="contacto">Contacto (todavía no vio la demo)</option>
                <option value="demo">Demo (ya la vio)</option>
                {leadDraft.id && <option value="perdido">Perdido</option>}
              </select>
            </label>
            <label>Volver a escribirle el<input type="date" value={leadDraft.nextContactOn ?? ""} onChange={(e) => setLeadDraft({ ...leadDraft, nextContactOn: e.target.value || null })} /></label>
            <label style={{ gridColumn: "1 / -1" }}>
              Nota (qué le duele hoy, cuántas sucursales, qué balanza usa)
              <textarea rows={3} value={leadDraft.note ?? ""} onChange={(e) => setLeadDraft({ ...leadDraft, note: e.target.value })} />
            </label>
            <div className="admin-form-submit">
              <button className="charge-button" disabled={busyId === (leadDraft.id ?? "new-lead")}>Guardar</button>
            </div>
          </form>
        </section>
      )}

      <div className="admin-filters">
        <div className="admin-actions">
          {PIPELINE_STAGES.map((s) => (
            <button key={s.id} className={stage === s.id ? "" : "secondary"} onClick={() => setStage(s.id)}>
              {s.label} ({stageCount(s.id)})
            </button>
          ))}
        </div>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>{PIPELINE_STAGES.find((s) => s.id === stage)?.hint}</span>

      {stageCount(stage) === 0 && !loading && <p className="muted">No hay nadie en esta etapa.</p>}
      <div className="admin-grid">
        {stageLeads.map(renderLeadCard)}
        {stageCompanies.map(renderCompanyCard)}
      </div>
    </div>
  );
}
