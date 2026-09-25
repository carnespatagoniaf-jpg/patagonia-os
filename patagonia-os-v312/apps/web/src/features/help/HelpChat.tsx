import { useEffect, useRef, useState } from "react";
import { HelpCircle, Send, X } from "lucide-react";
import { supabase } from "../../lib/supabase";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = ["¿Cómo agrego un producto?", "¿Qué es el PLU?", "¿Cómo cierro el turno?", "¿Cómo cargo una factura de compra?"];

async function askHelp(messages: ChatMessage[]): Promise<string> {
  if (!supabase) throw new Error("El asistente no está disponible.");

  const { data, error } = await supabase.functions.invoke("help-chat", { body: { messages } });
  if (error) {
    let message = "No pude responder en este momento. Probá de nuevo en un rato.";
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // keep default message
      }
    }
    throw new Error(message);
  }
  const answer = (data as { answer?: string } | null)?.answer;
  if (!answer) throw new Error("No pude responder en este momento. Probá de nuevo en un rato.");
  return answer;
}

/** Botón flotante de ayuda con IA. Solo contesta cómo se usa el sistema (la
 * función help-chat no ve datos del negocio). Se muestra únicamente si el
 * build tiene VITE_HELP_CHAT=1 -- así no aparece hasta que la función esté
 * desplegada y tenga su clave de API. */
export function HelpChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, open]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setInput("");
    setError("");
    setBusy(true);
    try {
      const answer = await askHelp(next);
      setMessages([...next, { role: "assistant", content: answer }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pude responder en este momento.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="help-chat no-print">
      {open && (
        <section className="help-chat-panel" aria-label="Ayuda">
          <header className="help-chat-head">
            <strong>Ayuda de Patagonia OS</strong>
            <button className="help-chat-close" onClick={() => setOpen(false)} aria-label="Cerrar ayuda"><X size={18} /></button>
          </header>

          <div className="help-chat-body">
            {messages.length === 0 && (
              <div className="help-chat-welcome">
                <p>¡Hola! Te ayudo a usar el sistema. Preguntame lo que necesites, por ejemplo:</p>
                <div className="help-chat-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="secondary" onClick={() => void send(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`help-chat-msg help-chat-${m.role}`}>{m.content}</div>
            ))}
            {busy && <div className="help-chat-msg help-chat-assistant help-chat-typing">Pensando…</div>}
            {error && <div className="help-chat-error">{error}</div>}
            <div ref={endRef} />
          </div>

          <form className="help-chat-form" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Escribí tu duda…"
              maxLength={800}
              disabled={busy}
            />
            <button disabled={busy || !input.trim()} aria-label="Enviar"><Send size={16} /></button>
          </form>
          <p className="help-chat-note">Es un asistente de IA: puede equivocarse. Si algo no te cierra, consultá con el equipo.</p>
        </section>
      )}

      <button className="help-chat-fab" onClick={() => setOpen((v) => !v)} aria-label="Abrir ayuda">
        <HelpCircle size={22} />
        {!open && <span>Ayuda</span>}
      </button>
    </div>
  );
}
