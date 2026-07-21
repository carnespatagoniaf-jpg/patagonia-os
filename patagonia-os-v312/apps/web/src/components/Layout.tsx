import { useState, type ReactNode } from "react";
import { BarChart3, Beef, Boxes, FileText, HandCoins, History, KeyRound, LogOut, PackagePlus, Receipt, ShoppingCart, TrendingUp, Users, Wallet } from "lucide-react";
import { useAuth } from "../features/auth/AuthProvider";
import { canAccessPage, type Page } from "../features/auth/permissions";
import { useActiveBranch } from "../features/branches/BranchProvider";

export type { Page };

interface Props {
  page: Page;
  onPageChange: (page: Page) => void;
  children: ReactNode;
}

const items: Array<{ page: Page; label: string; icon: typeof BarChart3 }> = [
  { page: "dashboard", label: "Inicio", icon: BarChart3 },
  { page: "sale", label: "Mostrador", icon: Receipt },
  { page: "shifts", label: "Ventas", icon: ShoppingCart },
  { page: "inventory", label: "Stock", icon: Boxes },
  { page: "purchases", label: "Compras", icon: PackagePlus },
  { page: "treasury", label: "Tesorería", icon: Wallet },
  { page: "employees", label: "Empleados", icon: Users },
  { page: "profitability", label: "Rentabilidad", icon: TrendingUp },
  { page: "carcass", label: "Despiece", icon: Beef },
  { page: "creditors", label: "Deudas", icon: HandCoins },
  { page: "reports", label: "Reportes", icon: FileText },
  { page: "users", label: "Usuarios", icon: KeyRound },
  { page: "audit", label: "Auditoría", icon: History }
];

function BranchSwitcher() {
  const { branchId, branches, canSwitch, setBranchId, addBranch } = useActiveBranch();
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
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

  return (
    <div className="branch-switcher">
      <select value={branchId ?? ""} onChange={(e) => setBranchId(e.target.value)}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
      {showNewForm ? (
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
      setMessage(err instanceof Error ? err.message : "No se pudo cambiar.");
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

export function Layout({ page, onPageChange, children }: Props) {
  const { profile, signOut } = useAuth();
  const visibleItems = items.filter((item) => canAccessPage(profile, item.page));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">PATAGONIA OS</div>
          <div className="branch">
            {profile?.full_name ?? "Usuario"} · {profile?.role ?? "sin rol"}
          </div>
          <BranchSwitcher />
        </div>

        <nav>
          {visibleItems.map(({ page: target, label, icon: Icon }) => (
            <button
              key={target}
              className={page === target ? "nav-item active" : "nav-item"}
              onClick={() => onPageChange(target)}
            >
              <Icon size={19} />
              {label}
            </button>
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

      <main className="main-content">{children}</main>
    </div>
  );
}
