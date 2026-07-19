import { useState } from "react";
import { useActiveBranch } from "../branches/BranchProvider";
import { useUsers } from "./useUsers";
import type { CompanyUser, CreateStaffUserResult, StaffRole } from "./users-service";

const ASSIGNABLE_ROLES: StaffRole[] = ["admin", "manager", "cashier", "production", "readonly"];

const ROLE_LABELS: Record<StaffRole, string> = {
  owner: "Dueño",
  admin: "Administrador",
  manager: "Encargado",
  cashier: "Cajero/a",
  production: "Producción",
  readonly: "Solo lectura"
};

interface Draft {
  email: string;
  fullName: string;
  role: StaffRole;
  branchId: string;
}

function emptyDraft(defaultBranchId: string): Draft {
  return { email: "", fullName: "", role: "cashier", branchId: defaultBranchId };
}

export function Users() {
  const { branches } = useActiveBranch();
  const { users, loading, error, create, update } = useUsers();

  const [message, setMessage] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [newDraft, setNewDraft] = useState<Draft>(emptyDraft(branches[0]?.id ?? ""));
  const [lastCreated, setLastCreated] = useState<CreateStaffUserResult | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft & { active: boolean }>({ ...emptyDraft(""), active: true });

  function openNewForm() {
    setNewDraft(emptyDraft(branches[0]?.id ?? ""));
    setShowNewForm(true);
    setLastCreated(null);
  }

  async function handleCreate() {
    try {
      if (!newDraft.email.trim()) throw new Error("Ingresá un email.");
      if (!newDraft.fullName.trim()) throw new Error("Ingresá un nombre.");
      if (!newDraft.branchId) throw new Error("Elegí una sucursal.");

      const result = await create({
        email: newDraft.email.trim(),
        fullName: newDraft.fullName.trim(),
        role: newDraft.role,
        branchId: newDraft.branchId
      });
      setLastCreated(result);
      setShowNewForm(false);
      setMessage("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el usuario.");
    }
  }

  function startEdit(user: CompanyUser) {
    setEditingId(user.id);
    setEditDraft({
      email: "",
      fullName: user.fullName,
      role: (user.role === "owner" ? "admin" : user.role) as StaffRole,
      branchId: user.branchId ?? branches[0]?.id ?? "",
      active: user.active
    });
  }

  async function handleUpdate() {
    try {
      if (!editingId) return;
      if (!editDraft.fullName.trim()) throw new Error("Ingresá un nombre.");
      if (!editDraft.branchId) throw new Error("Elegí una sucursal.");

      await update({
        id: editingId,
        fullName: editDraft.fullName.trim(),
        role: editDraft.role,
        branchId: editDraft.branchId,
        active: editDraft.active
      });
      setEditingId(null);
      setMessage("Usuario actualizado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo actualizar el usuario.");
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">USUARIOS</p>
          <h1>Accesos al sistema</h1>
          <p className="muted">Quién puede entrar, con qué rol y en qué sucursal — a medida que sumes locales, dales de alta acá.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      {lastCreated && (
        <div className="message" style={{ borderColor: "#2f9e44" }}>
          Usuario creado para <strong>{lastCreated.email}</strong>. Contraseña temporal (copiala ahora, no se vuelve a mostrar):{" "}
          <code style={{ fontSize: 16, fontWeight: 700 }}>{lastCreated.tempPassword}</code>
          {" "}
          <button className="secondary" onClick={() => setLastCreated(null)}>Listo</button>
        </div>
      )}

      <section className="panel">
        <div className="panel-title">
          <h2>Usuarios</h2>
          <span>{loading ? "Cargando…" : `${users.length} usuarios`}</span>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Rol</th>
              <th>Sucursal</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                {editingId === user.id ? (
                  <>
                    <td><input value={editDraft.fullName} onChange={(e) => setEditDraft({ ...editDraft, fullName: e.target.value })} /></td>
                    <td>
                      <select value={editDraft.role} onChange={(e) => setEditDraft({ ...editDraft, role: e.target.value as StaffRole })}>
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={editDraft.branchId} onChange={(e) => setEditDraft({ ...editDraft, branchId: e.target.value })}>
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={editDraft.active ? "1" : "0"} onChange={(e) => setEditDraft({ ...editDraft, active: e.target.value === "1" })}>
                        <option value="1">Activo</option>
                        <option value="0">Inactivo</option>
                      </select>
                    </td>
                    <td>
                      <button onClick={handleUpdate}>Guardar</button>{" "}
                      <button className="secondary" onClick={() => setEditingId(null)}>Cancelar</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{user.fullName}</td>
                    <td>{ROLE_LABELS[user.role]}</td>
                    <td>{user.branchName ?? "—"}</td>
                    <td>{user.active ? "Activo" : "Inactivo"}</td>
                    <td>
                      {user.role !== "owner" && (
                        <button className="secondary" onClick={() => startEdit(user)}>Editar</button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && !loading && <p className="muted">Todavía no hay usuarios cargados.</p>}

        {showNewForm ? (
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 16 }}>
            <input placeholder="Email" value={newDraft.email} onChange={(e) => setNewDraft({ ...newDraft, email: e.target.value })} />
            <input placeholder="Nombre" value={newDraft.fullName} onChange={(e) => setNewDraft({ ...newDraft, fullName: e.target.value })} />
            <select value={newDraft.role} onChange={(e) => setNewDraft({ ...newDraft, role: e.target.value as StaffRole })}>
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            <select value={newDraft.branchId} onChange={(e) => setNewDraft({ ...newDraft, branchId: e.target.value })}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <button onClick={handleCreate}>Crear usuario</button>
            <button className="secondary" onClick={() => setShowNewForm(false)}>Cancelar</button>
          </div>
        ) : (
          <button className="secondary" style={{ marginTop: 16 }} onClick={openNewForm}>
            + Nuevo usuario
          </button>
        )}
      </section>
    </>
  );
}
