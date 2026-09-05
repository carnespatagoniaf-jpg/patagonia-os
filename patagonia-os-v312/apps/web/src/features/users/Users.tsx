import { Fragment, useState } from "react";
import { useActiveBranch } from "../branches/BranchProvider";
import { PERMISSION_LABELS, rolePermissions, type Permission } from "../auth/permissions";
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

function randomPassword() {
  return crypto.randomUUID().slice(0, 10);
}

export function Users() {
  const { branches } = useActiveBranch();
  const { users, loading, error, create, update, remove } = useUsers();

  const [message, setMessage] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [newDraft, setNewDraft] = useState<Draft>(emptyDraft(branches[0]?.id ?? ""));
  const [newPassword, setNewPassword] = useState(randomPassword());
  const [lastCreated, setLastCreated] = useState<CreateStaffUserResult | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft & { active: boolean; deniedPermissions: string[] }>({
    ...emptyDraft(""),
    active: true,
    deniedPermissions: []
  });

  function openNewForm() {
    setNewDraft(emptyDraft(branches[0]?.id ?? ""));
    setNewPassword(randomPassword());
    setShowNewForm(true);
    setLastCreated(null);
  }

  async function handleCreate() {
    try {
      if (!newDraft.email.trim()) throw new Error("Ingresá un email.");
      if (!newDraft.fullName.trim()) throw new Error("Ingresá un nombre.");
      if (!newDraft.branchId) throw new Error("Elegí una sucursal.");
      if (newPassword.length < 8) throw new Error("La contraseña tiene que tener al menos 8 caracteres.");

      const result = await create({
        email: newDraft.email.trim(),
        fullName: newDraft.fullName.trim(),
        role: newDraft.role,
        branchId: newDraft.branchId,
        password: newPassword
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
      active: user.active,
      deniedPermissions: user.deniedPermissions
    });
  }

  function toggleDeniedPermission(permission: Permission, allowed: boolean) {
    setEditDraft((current) => ({
      ...current,
      deniedPermissions: allowed
        ? current.deniedPermissions.filter((p) => p !== permission)
        : [...current.deniedPermissions, permission]
    }));
  }

  /** A diferencia de marcarlo "Inactivo" (que preserva el historial), esto
   * borra el login de verdad -- solo funciona si el usuario nunca tuvo
   * actividad real (el servidor lo rechaza solo si ya vendió algo, abrió
   * un turno, etc.), así que puede fallar con un mensaje claro. La
   * confirmación es una fila propia en la tabla, no window.confirm(): un
   * navegador puede llegar a suprimir esos diálogos nativos sin avisar
   * (por ejemplo, después de tildar "no volver a preguntar" en otro), y
   * ahí "Borrar" parece no hacer nada. */
  async function handleConfirmDelete(user: CompanyUser) {
    setDeleteBusy(true);
    try {
      await remove(user.id);
      setConfirmDeleteId(null);
      setMessage("Usuario eliminado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo eliminar el usuario.");
    } finally {
      setDeleteBusy(false);
    }
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
        active: editDraft.active,
        deniedPermissions: editDraft.deniedPermissions
      });
      setEditingId(null);
      setMessage(editDraft.active ? "Usuario actualizado." : "Usuario desactivado (sigue en la lista, marcado Inactivo, para no perder su historial).");
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
          Usuario creado para <strong>{lastCreated.email}</strong>. Pasale ese email y la contraseña que le pusiste para que entre.
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
              <Fragment key={user.id}>
                <tr>
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
                          confirmDeleteId === user.id ? (
                            <>
                              <span className="muted" style={{ fontSize: 13, marginRight: 6 }}>¿Seguro? No se puede deshacer.</span>
                              <button className="danger" disabled={deleteBusy} onClick={() => handleConfirmDelete(user)}>
                                {deleteBusy ? "Eliminando…" : "Sí, borrar"}
                              </button>{" "}
                              <button className="secondary" disabled={deleteBusy} onClick={() => setConfirmDeleteId(null)}>Cancelar</button>
                            </>
                          ) : (
                            <>
                              <button className="secondary" onClick={() => startEdit(user)}>Editar</button>{" "}
                              <button className="danger" onClick={() => setConfirmDeleteId(user.id)}>Borrar</button>
                            </>
                          )
                        )}
                      </td>
                    </>
                  )}
                </tr>
                {editingId === user.id && (
                  <tr>
                    <td colSpan={5} style={{ background: "#f8f5f2" }}>
                      <p className="muted" style={{ margin: "4px 0 8px" }}>
                        Qué puede ver {editDraft.fullName || "esta persona"} (destildá para ocultarle algo puntual, sin cambiarle el rol):
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
                        {rolePermissions[editDraft.role]
                          .filter((p): p is Permission => p !== "*")
                          .map((permission) => (
                            <label key={permission} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                              <input
                                type="checkbox"
                                checked={!editDraft.deniedPermissions.includes(permission)}
                                onChange={(e) => toggleDeniedPermission(permission, e.target.checked)}
                              />
                              {PERMISSION_LABELS[permission]}
                            </label>
                          ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {users.length === 0 && !loading && <p className="muted">Todavía no hay usuarios cargados.</p>}

        {showNewForm ? (
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 16 }}>
            <input placeholder="Email" value={newDraft.email} onChange={(e) => setNewDraft({ ...newDraft, email: e.target.value })} />
            <input placeholder="Nombre" value={newDraft.fullName} onChange={(e) => setNewDraft({ ...newDraft, fullName: e.target.value })} />
            <input placeholder="Contraseña (mínimo 8 caracteres)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={{ width: 220 }} />
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
