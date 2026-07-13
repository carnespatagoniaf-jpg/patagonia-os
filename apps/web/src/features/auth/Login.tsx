import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "./AuthProvider";

export function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await signIn(email, password);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo iniciar sesión.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-logo"><LockKeyhole /></div>
        <p className="eyebrow">PATAGONIA OS</p>
        <h1>Iniciar sesión</h1>
        <p className="muted">Ingresá con tu usuario de Carnes Patagonia.</p>

        {!isSupabaseConfigured && (
          <div className="message warning">
            Falta configurar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.
          </div>
        )}

        <form onSubmit={submit}>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
          </label>
          <label>
            Contraseña
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
          </label>
          <button className="charge-button" disabled={busy || !isSupabaseConfigured}>
            {busy ? "Ingresando…" : "Entrar"}
          </button>
        </form>

        {message && <div className="message warning">{message}</div>}
      </section>
    </main>
  );
}
