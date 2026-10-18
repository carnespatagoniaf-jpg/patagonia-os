import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { whatsappLink, type FollowUp } from "./sales-pipeline";

/** "Escribir uno por uno": recorre la lista de hoy de a un contacto. Abrís
 * WhatsApp con el mensaje listo, lo mandás, y "Listo, siguiente" lo anota y
 * pasa al próximo. La lista se fija al empezar (no se reordena mientras tanto). */
export function FollowUpRound({
  items,
  onContacted,
  onReplied,
  onClose
}: {
  items: FollowUp[];
  onContacted: (f: FollowUp) => Promise<void>;
  onReplied: (f: FollowUp) => Promise<void>;
  onClose: () => void;
}) {
  const [list] = useState(items);
  const [index, setIndex] = useState(0);
  const [edited, setEdited] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [done, setDone] = useState(0);

  if (index >= list.length) {
    return (
      <section className="panel follow-round">
        <h2>¡Listo! 🎉</h2>
        <p>Le escribiste a {done} de {list.length}. Los que no contesten vuelven a aparecer solos en unos días con el mensaje siguiente.</p>
        <div className="admin-actions"><button onClick={onClose}>Cerrar</button></div>
      </section>
    );
  }

  const f = list[index];
  const message = edited[index] ?? f.message;
  const link = whatsappLink(f.phone, message);

  async function act(kind: "contacted" | "replied" | "skip") {
    setBusy(true);
    try {
      if (kind === "contacted") {
        await onContacted(f);
        setDone((d) => d + 1);
      } else if (kind === "replied") {
        await onReplied(f);
      }
      setOpened(false);
      setIndex((i) => i + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel follow-round">
      <div className="follow-round-head">
        <b>{index + 1} de {list.length}</b>
        <div className="follow-round-progress"><div style={{ width: `${(index / list.length) * 100}%` }} /></div>
        <button className="admin-link" onClick={onClose}>Terminar</button>
      </div>
      <span className="admin-trial admin-trial-none" style={{ justifySelf: "start" }}>{f.title}</span>
      <h2 style={{ margin: 0 }}>{f.name}</h2>
      <span className="muted">{f.phone ?? "sin teléfono"} · {f.reason}</span>
      <textarea rows={4} value={message} onChange={(e) => setEdited({ ...edited, [index]: e.target.value })} />
      <div className="admin-actions">
        {link ? (
          <a className="sales-wa-button" href={link} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}>
            <MessageCircle size={14} /> 1. Abrir WhatsApp
          </a>
        ) : (
          <span className="muted">Sin celular: saltealo o cargalo editando el contacto.</span>
        )}
        <button className={opened ? "" : "secondary"} disabled={busy} onClick={() => void act("contacted")}>2. Listo, siguiente</button>
        {f.leadId && <button className="secondary" disabled={busy} onClick={() => void act("replied")}>Ya me contestó</button>}
        <button className="secondary" disabled={busy} onClick={() => void act("skip")}>Saltar</button>
      </div>
    </section>
  );
}
