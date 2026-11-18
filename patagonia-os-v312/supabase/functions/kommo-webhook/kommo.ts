// Lógica pura del webhook de Kommo (sin Deno ni Supabase), probada desde
// apps/web/src/features/admin/kommo-webhook.test.ts.
//
// Kommo manda los webhooks como formulario (application/x-www-form-urlencoded)
// con claves de corchetes: `contacts[add][0][id]=123`,
// `message[add][0][contact_id]=123`, `message[add][0][type]=incoming`, etc.

export type KommoNode = string | { [key: string]: KommoNode };

export interface KommoLeadEvent {
  contactId: number;
  name: string | null;
  phone: string | null;
  incoming: boolean;
  text: string | null;
}

/** Arma un objeto anidado a partir de las claves con corchetes. */
export function parseKommoForm(body: string): Record<string, KommoNode> {
  const root: Record<string, KommoNode> = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const parts = rawKey.replace(/\]/g, "").split("[").filter((p, i) => i === 0 || p !== "");
    let node: Record<string, KommoNode> = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node[part] = value;
        return;
      }
      const next = node[part];
      if (typeof next !== "object") node[part] = {};
      node = node[part] as Record<string, KommoNode>;
    });
  }
  return root;
}

function obj(n: KommoNode | undefined): Record<string, KommoNode> | null {
  return n && typeof n === "object" ? n : null;
}

function str(n: KommoNode | undefined): string | null {
  return typeof n === "string" && n.trim() !== "" ? n.trim() : null;
}

/** Los elementos de una "lista" de Kommo ({"0": {...}, "1": {...}}). */
function items(n: KommoNode | undefined): Record<string, KommoNode>[] {
  const o = obj(n);
  if (!o) return [];
  return Object.keys(o)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => obj(o[k]))
    .filter((x): x is Record<string, KommoNode> => x !== null);
}

function contactIdOf(n: KommoNode | undefined): number | null {
  const s = str(n);
  if (!s || !/^\d+$/.test(s)) return null;
  return Number(s);
}

/** Teléfono de los campos del webhook (`custom_fields`, código PHONE). */
export function phoneFromWebhookFields(fields: KommoNode | undefined): string | null {
  for (const f of items(fields)) {
    if (str(f.code) !== "PHONE") continue;
    for (const v of items(f.values)) {
      const phone = str(v.value);
      if (phone) return phone;
    }
  }
  return null;
}

/** Teléfono de un contacto leído por la API v4 (`custom_fields_values`, field_code PHONE). */
export function phoneFromApiContact(contact: unknown): string | null {
  const fields = (contact as { custom_fields_values?: unknown })?.custom_fields_values;
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (f?.field_code !== "PHONE" || !Array.isArray(f.values)) continue;
    for (const v of f.values) {
      if (typeof v?.value === "string" && v.value.trim()) return v.value.trim();
    }
  }
  return null;
}

/**
 * Lo que interesa de un webhook: contactos nuevos y mensajes que llegaron
 * (los que manda uno desde Kommo se ignoran).
 */
export function kommoLeadEvents(payload: Record<string, KommoNode>): KommoLeadEvent[] {
  const out: KommoLeadEvent[] = [];
  const contacts = obj(payload.contacts);
  for (const c of items(contacts?.add)) {
    const contactId = contactIdOf(c.id);
    if (contactId === null) continue;
    // Kommo también avisa "contacto agregado" para empresas; esas no son interesados.
    if (str(c.type) === "company") continue;
    out.push({ contactId, name: str(c.name), phone: phoneFromWebhookFields(c.custom_fields), incoming: false, text: null });
  }
  const message = obj(payload.message);
  for (const m of items(message?.add)) {
    if (str(m.type) !== "incoming") continue;
    const contactId = contactIdOf(m.contact_id);
    if (contactId === null) continue;
    out.push({
      contactId,
      name: str(obj(m.author)?.name),
      phone: null,
      incoming: true,
      text: str(m.text)
    });
  }
  return out;
}

/** Subdominio de la cuenta que mandó el aviso (`account[subdomain]`). */
export function kommoSubdomain(payload: Record<string, KommoNode>): string | null {
  return str(obj(payload.account)?.subdomain);
}

/** Compara la clave de la URL sin cortar en el primer carácter distinto. */
export function sameKey(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
