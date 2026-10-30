import { useState, type ReactNode } from "react";
import { LogOut, Menu } from "lucide-react";
import { navGroups, visibleItem, type VisibleItem } from "./nav";
import { useAuth } from "../features/auth/AuthProvider";
import { PLAN_LABELS, canAccessPage, planAllows, profilePlan, type Page } from "../features/auth/permissions";

/**
 * Facturas (ARCA) visible para todos (decisión del dueño, 14/10): se cargan los datos fiscales y se ven los pasos de
 * ARCA; "Probar conexión con ARCA" y la factura en Mostrador se activan cuando esté la parte 2 (Edge Function).
 */
const SHOW_INVOICING = true;
import { useActiveBranch } from "../features/branches/BranchProvider";
import { TrialBanner } from "./TrialBanner";
import { NewsBanner } from "./NewsBanner";
import { UpdateBanner } from "./UpdateBanner";
import { authErrorText } from "../lib/auth-errors";
import { useInvoiceRetry } from "../features/invoicing/useInvoiceRetry";
import { HelpChat } from "../features/help/HelpChat";

export type { Page };

interface Props {
  page: Page;
  onPageChange: (page: Page) => void;
  children: ReactNode;
}

function BranchSwitcher() {
  const { branchId, branches, canSwitch, setBranchId, addBranch, renameBranch } = useActiveBranch();
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [showRename, setShowRename] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [error, setError] = useState("");

  const currentName = branches.find((b) => b.id === branchId)?.name;

  if (!canSwitch) {
    return currentName ? <div className="branch-switcher-label">{currentName}</div> : null;
  }

  async function handleAdd() {
    try {
      if (!newName.trim()) throw new Error("Ingresá un nombre.");
      await addBranch(newName.trim());
      setNewName("");
      setShowNewForm(false);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la sucursal.");
    }
  }

  async function handleRename() {
    if (!branchId) return;
    const name = renameValue.trim();
    if (!name) { setError("Ingresá un nombre."); return; }
    setRenameBusy(true);
    try {
      await renameBranch(branchId, name);
      setShowRename(false);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el nombre.");
    } finally {
      setRenameBusy(false);
    }
  }

  return (
    <div className="branch-switcher">
      <select value={branchId ?? ""} onChange={(e) => setBranchId(e.target.value)}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>


      {showRename ? (
        <div className="branch-switcher-new">
          <input placeholder="Nuevo nombre" value={renameValue} maxLength={60} onChange={(e) => setRenameValue(e.target.value)} />
          <button className="secondary" disabled={renameBusy} onClick={handleRename}>Guardar</button>
          <button className="secondary" onClick={() => { setShowRename(false); setError(""); }}>Cancelar</button>
        </div>
      ) : (
        !showNewForm && (
          <button className="branch-switcher-add" onClick={() => { setRenameValue(currentName ?? ""); setShowRename(true); setError(""); }}>
            Cambiar nombre
          </button>
        )
      )}

      {showRename ? null : showNewForm ? (
        <div className="branch-switcher-new">
          <input placeholder="Nombre de la sucursal" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="secondary" onClick={handleAdd}>Guardar</button>
          <button className="secondary" onClick={() => { setShowNewForm(false); setError(""); }}>Cancelar</button>
        </div>
      ) : (
        <button className="branch-switcher-add" onClick={() => setShowNewForm(true)}>+ Nueva sucursal</button>
      )}
      {error && <p className="branch-switcher-error">{error}</p>}
    </div>
  );
}

function ChangePasswordForm() {
  const { updatePassword } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    setMessage("");
    if (password.length < 6) { setMessage("Mínimo 6 caracteres."); return; }
    if (password !== confirm) { setMessage("No coinciden."); return; }
    setBusy(true);
    try {
      await updatePassword(password);
      setOpen(false);
      setPassword("");
      setConfirm("");
    } catch (err) {
      setMessage(authErrorText(err, "No se pudo cambiar."));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="branch-switcher-add" onClick={() => setOpen(true)}>Cambiar contraseña</button>
    );
  }

  return (
    <div className="branch-switcher-new">
      <input type="password" placeholder="Contraseña nueva" value={password} onChange={(e) => setPassword(e.target.value)} />
      <input type="password" placeholder="Confirmar" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <button className="secondary" disabled={busy} onClick={handleSave}>{busy ? "Guardando…" : "Guardar"}</button>
      <button className="secondary" onClick={() => { setOpen(false); setMessage(""); }}>Cancelar</button>
      {message && <p className="branch-switcher-error">{message}</p>}
    </div>
  );
}

/** El rol en castellano (antes se veía "owner" o "cashier"). */
const ROLE_LABELS: Record<string, string> = { owner: "Dueño", admin: "Administrador", manager: "Encargado", cashier: "Cajero/a", production: "Producción", readonly: "Solo lectura", accountant: "Contador" };
function roleLabel(role: string | null | undefined): string {
  return role ? ROLE_LABELS[role] ?? role : "sin rol";
}

export function Layout({ page, onPageChange, children }: Props) {
  const { profile, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  // Solo desde la PC del dueño o de un administrador: no hace falta que cada caja y cada pestaña le pregunten a ARCA.
  useInvoiceRetry(Boolean(profile?.company_id) && (profile?.role === "owner" || profile?.role === "admin"));
  const allowed = (target: Page) => canAccessPage(profile, target) && (target !== "invoicing" || SHOW_INVOICING);
  const visibleGroups = navGroups
    .map((group) => ({ ...group, items: group.items.map((item) => visibleItem(item, allowed)).filter((item): item is VisibleItem => item !== null) }))
    .filter((group) => group.items.length > 0);
  const currentItem = visibleGroups.flatMap((g) => g.items).find((i) => i.pages.includes(page));
  const currentTabs = currentItem && currentItem.tabs.length > 1 ? currentItem.tabs : null;
  const currentLabel = currentTabs?.find((t) => t.page === page)?.label ?? currentItem?.label ?? "Patagonia OS";
  function goTo(target: Page) {
    onPageChange(target);
    setMenuOpen(false);
  }

  return (
    <div className="app-shell">
      <header className="mobile-topbar no-print">
        <button className="mobile-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menú">
          <Menu size={22} />
        </button>
        <strong className="mobile-topbar-title">{currentLabel}</strong>
        <span className="mobile-topbar-brand">PATAGONIA OS</span>
      </header>
      {menuOpen && <div className="drawer-backdrop no-print" onClick={() => setMenuOpen(false)} />}
      <aside className={menuOpen ? "sidebar open" : "sidebar"}>
        <div>
          <div className="brand">PATAGONIA OS</div>
          <div className="branch">
            {profile?.full_name ?? "Usuario"} · {roleLabel(profile?.role)}
          </div>
          {(profile?.role === "owner" || profile?.role === "admin") && profile?.plan && (
            <div className="branch" style={{ marginTop: 2 }}>Plan {PLAN_LABELS[profilePlan(profile)]}</div>
          )}
          <BranchSwitcher />
        </div>

        <nav>
          {visibleGroups.map((group) => (
            <div key={group.heading ?? "root"} className="nav-group">
              {group.heading && <p className="nav-heading">{group.heading}</p>}
              {group.items.map(({ page: target, label, icon: Icon, pages }) => (
                <button
                  key={target}
                  className={pages.includes(page) ? "nav-item active" : "nav-item"}
                  onClick={() => goTo(target)}
                >
                  <Icon size={19} />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <ChangePasswordForm />
          <button className="nav-item" onClick={() => void signOut()}>
            <LogOut size={19} />
            Salir
          </button>
        </div>
      </aside>

      <main className="main-content">
        <UpdateBanner />
        <TrialBanner />
        <NewsBanner onPageChange={onPageChange} />
        {currentTabs && (
          <div className="page-tabs no-print" role="tablist">
            {currentTabs.map((t) => (
              <button key={t.page} role="tab" aria-selected={t.page === page} className={t.page === page ? "page-tab active" : "page-tab"} onClick={() => onPageChange(t.page)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        {children}
      </main>
      {import.meta.env.VITE_HELP_CHAT === "1" && planAllows(profile, "estandar") && <HelpChat />}
    </div>
  );
}
