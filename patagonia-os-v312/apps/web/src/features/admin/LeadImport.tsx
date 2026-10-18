import { useState } from "react";
import { importLeads } from "./admin-service";
import { parseContacts } from "./lead-import";

const SOURCES = ["Instagram (publicidad)", "Facebook (publicidad)", "WhatsApp", "Recomendación", "Otro"];

/** "Cargar contactos": pegar la lista de WhatsApp o subir el archivo de
 * contactos del celular y cargarlos todos como interesados de una vez. */
export function LeadImport({ onDone, onClose }: { onDone: (message: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState(SOURCES[0]);
  const [perDay, setPerDay] = useState(20);
  const [alreadyWrote, setAlreadyWrote] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const contacts = parseContacts(text);
  const withName = contacts.filter((c) => c.name).length;

  async function readFile(file: File) {
    setText(await file.text());
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await importLeads(contacts.map((c) => ({ ...c, attempts: alreadyWrote ? 1 : 0 })), source, perDay);
      const days = Math.ceil(r.inserted / perDay);
      onDone(
        `Se cargaron ${r.inserted} ${r.inserted === 1 ? "contacto" : "contactos"}` +
          (r.skipped ? ` (${r.skipped} ya estaban o no tenían un celular válido)` : "") +
          (r.inserted ? `. Te aparecen de a ${perDay} por día en "Para escribir hoy"${days > 1 ? `, durante ${days} días` : ""}.` : ".")
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los contactos.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel admin-form-panel lead-import">
      <div className="panel-title"><h2>Cargar contactos</h2></div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Pegá la lista (un contacto por renglón, con el nombre y el celular en cualquier orden) o subí el archivo de contactos del celular (.vcf).
        Los que ya están cargados no se repiten.
      </p>
      <textarea
        rows={7}
        placeholder={"Juan Pérez 11 5555-1234\n+54 9 294 455-1234 Carnicería Don Julio\n341 333 3333"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="admin-actions" style={{ alignItems: "center" }}>
        <label className="secondary lead-import-file">
          Subir archivo (.vcf, .txt, .csv)
          <input type="file" accept=".vcf,.txt,.csv,text/vcard,text/plain,text/csv" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} />
        </label>
        <label className="admin-pay-field">
          De dónde vinieron
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="admin-pay-field">
          Escribirles de a
          <select value={perDay} onChange={(e) => setPerDay(Number(e.target.value))}>
            {[10, 20, 30, 50].map((n) => <option key={n} value={n}>{n} por día</option>)}
          </select>
        </label>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
        <input type="checkbox" checked={alreadyWrote} onChange={(e) => setAlreadyWrote(e.target.checked)} />
        Ya les escribí una vez (arrancan por el mensaje 2)
      </label>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        De a pocos por día: si WhatsApp ve muchos mensajes iguales juntos a gente que no te tiene agendado, puede bloquear el número.
      </p>
      {text.trim() && (
        <p style={{ margin: 0 }}>
          Encontré <b>{contacts.length}</b> {contacts.length === 1 ? "contacto" : "contactos"} con celular{contacts.length ? ` (${withName} con nombre)` : ""}.
        </p>
      )}
      {error && <div className="message warning">{error}</div>}
      <div className="admin-actions">
        <button disabled={busy || contacts.length === 0} onClick={() => void submit()}>{busy ? "Cargando…" : `Cargar ${contacts.length || ""}`.trim()}</button>
        <button className="secondary" onClick={onClose}>Cerrar</button>
      </div>
    </section>
  );
}
