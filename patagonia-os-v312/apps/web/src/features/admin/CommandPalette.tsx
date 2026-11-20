import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, CornerDownLeft, MessageCircle, Plus, Search, UserRound } from "lucide-react";
import { listLeads, type CompanySummary } from "./admin-service";
import { matchesCompanySearch } from "./company-billing";
import { whatsappLink, type Lead } from "./sales-pipeline";
import { Button, Modal } from "./ui/components";
import { matchesSearch } from "./ui/table-logic";

const TABS: Array<{ key: string; label: string }> = [
  { key: "resumen", label: "Resumen" },
  { key: "clientes", label: "Clientes" },
  { key: "ventas", label: "Ventas" },
  { key: "contactos", label: "Contactos" },
  { key: "finanzas", label: "Finanzas" },
  { key: "soporte", label: "Soporte" }
];

type Item =
  | { kind: "client"; id: string; title: string; sub: string; company: CompanySummary }
  | { kind: "lead"; id: string; title: string; sub: string; lead: Lead }
  | { kind: "tab"; id: string; title: string; sub: string }
  | { kind: "new"; id: string; title: string; sub: string };

/**
 * Buscador rápido del panel (Etapa 4): Ctrl+K (o el botón "Buscar") busca clientes, interesados y pestañas desde
 * cualquier lado. Enter abre la ficha del cliente; con un interesado, abre su WhatsApp.
 */
export function CommandPalette({ companies, onOpenClient, onGoTab, onNewClient }: {
  companies: CompanySummary[];
  onOpenClient: (companyId: string) => void;
  onGoTab: (tab: string) => void;
  onNewClient: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    // Los interesados se traen la primera vez que se abre (no hace falta cargarlos para usar el panel).
    if (leads === null) listLeads().then(setLeads).catch(() => setLeads([]));
  }, [open, leads]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const clients: Item[] = companies
      .filter((c) => (q ? matchesCompanySearch(c, q) : c.active))
      .slice(0, q ? 8 : 5)
      .map((c) => ({
        kind: "client",
        id: c.id,
        title: `${c.clientNumber !== undefined ? `N.º ${c.clientNumber} · ` : ""}${c.name}`,
        sub: [c.ownerFullName, c.city, c.active ? null : "desactivado"].filter(Boolean).join(" · "),
        company: c
      }));
    const leadItems: Item[] = q
      ? (leads ?? [])
          .filter((l) => l.stage !== "alta" && matchesSearch(`${l.businessName} ${l.contactName ?? ""} ${l.phone ?? ""} ${l.city ?? ""}`, q))
          .slice(0, 5)
          .map((l) => ({ kind: "lead", id: l.id, title: l.businessName, sub: ["Interesado", l.contactName, l.phone].filter(Boolean).join(" · "), lead: l }))
      : [];
    const tabs: Item[] = TABS.filter((t) => !q || matchesSearch(`ir a ${t.label}`, q)).map((t) => ({ kind: "tab", id: t.key, title: `Ir a ${t.label}`, sub: "Pestaña" }));
    const extra: Item[] = !q || matchesSearch("nuevo cliente alta", q) ? [{ kind: "new", id: "new", title: "Nuevo cliente", sub: "Dar de alta un negocio" }] : [];
    return [...clients, ...leadItems, ...extra, ...tabs];
  }, [query, companies, leads]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(item: Item | undefined) {
    if (!item) return;
    setOpen(false);
    if (item.kind === "client") onOpenClient(item.id);
    else if (item.kind === "tab") onGoTab(item.id);
    else if (item.kind === "new") onNewClient();
    else if (item.kind === "lead") {
      const link = whatsappLink(item.lead.phone, "");
      if (link) window.open(link, "_blank", "noopener");
      else onGoTab("contactos");
    }
  }

  const icon = (item: Item) =>
    item.kind === "client" ? <Building2 size={16} /> : item.kind === "lead" ? <UserRound size={16} /> : item.kind === "new" ? <Plus size={16} /> : <CornerDownLeft size={16} />;

  return (
    <>
      <Button variant="secondary" icon={Search} onClick={() => setOpen(true)} title="Buscar clientes, interesados o pestañas (Ctrl+K)">
        Buscar <kbd className="pa-kbd">Ctrl K</kbd>
      </Button>
      <Modal open={open} title="Buscar" onClose={() => setOpen(false)}>
        <div className="pa-search">
          <Search size={16} aria-hidden />
          <input
            className="pa-input"
            autoFocus
            value={query}
            placeholder="Cliente, número, dueño, teléfono, interesado o pestaña"
            aria-label="Buscar"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(items[active]); }
            }}
          />
        </div>
        <div className="pa-palette" ref={listRef} role="listbox" aria-label="Resultados">
          {items.length === 0 && <span className="pa-muted" style={{ padding: 8 }}>No encontré nada con “{query}”.</span>}
          {items.map((item, i) => (
            <button
              key={`${item.kind}-${item.id}`}
              type="button"
              role="option"
              aria-selected={i === active}
              data-index={i}
              className="pa-palette-item"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <span className="pa-palette-icon">{icon(item)}</span>
              <span style={{ display: "grid", minWidth: 0 }}>
                <strong>{item.title}</strong>
                {item.sub && <span className="pa-muted" style={{ fontSize: 12 }}>{item.sub}</span>}
              </span>
              {item.kind === "lead" && item.lead.phone && <MessageCircle size={14} className="pa-text-ok" aria-label="Abre WhatsApp" />}
            </button>
          ))}
        </div>
        <span className="pa-muted" style={{ fontSize: 12 }}>↑ ↓ para moverte · Enter para abrir · Esc para cerrar</span>
      </Modal>
    </>
  );
}
