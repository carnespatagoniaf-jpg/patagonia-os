import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "./AuthProvider";

export function Login() {
  const { signIn, sendPasswordReset } = useAuth();
  const [mode, setMode] = useState<"login" | "forgot">("login");
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

  async function submitForgot(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await sendPasswordReset(email);
      setMessage("Si el mail existe en el sistema, te enviamos un link para restablecer la contraseña.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo enviar el mail.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-logo"><LockKeyhole /></div>
        <p className="eyebrow">PATAGONIA OS</p>
        <h1>{mode === "login" ? "Iniciar sesión" : "Restablecer contraseña"}</h1>
        <p className="muted">
          {mode === "login" ? "Ingresá con tu usuario de Carnes Patagonia." : "Ingresá tu email y te mandamos un link para elegir una contraseña nueva."}
        </p>

        {!isSupabaseConfigured && (
          <div className="message warning">
            Falta configurar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.
          </div>
        )}

        {mode === "login" ? (
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
        ) : (
          <form onSubmit={submitForgot}>
            <label>
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
            </label>
            <button className="charge-button" disabled={busy || !isSupabaseConfigured}>
              {busy ? "Enviando…" : "Enviar link"}
            </button>
          </form>
        )}

        <button
          className="login-link-button"
          onClick={() => { setMode(mode === "login" ? "forgot" : "login"); setMessage(""); }}
        >
          {mode === "login" ? "¿Olvidaste tu contraseña?" : "Volver a iniciar sesión"}
        </button>

        {message && <div className="message warning">{message}</div>}
      </section>
    </main>
  );
}
