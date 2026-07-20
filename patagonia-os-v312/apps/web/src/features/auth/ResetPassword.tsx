import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { useAuth } from "./AuthProvider";

export function ResetPassword() {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    if (password.length < 6) {
      setMessage("La contraseña tiene que tener al menos 6 caracteres.");
      return;
    }
    if (password !== confirm) {
      setMessage("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    try {
      await updatePassword(password);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar la contraseña.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-logo"><LockKeyhole /></div>
        <p className="eyebrow">PATAGONIA OS</p>
        <h1>Elegí una contraseña nueva</h1>
        <p className="muted">Es la última vez que la vas a tener que ingresar así — a partir de ahora, entrá con esta.</p>

        <form onSubmit={submit}>
          <label>
            Contraseña nueva
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={6} />
          </label>
          <label>
            Confirmar contraseña
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" required minLength={6} />
          </label>
          <button className="charge-button" disabled={busy}>
            {busy ? "Guardando…" : "Guardar contraseña"}
          </button>
        </form>

        {message && <div className="message warning">{message}</div>}
      </section>
    </main>
  );
}
