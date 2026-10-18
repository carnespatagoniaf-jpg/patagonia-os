/** Lee contactos pegados de WhatsApp o un archivo de contactos del celular
 * (.vcf) para cargarlos de una vez como interesados (migración 132).
 * Lógica pura, sin lib/supabase, para poder testearla. */

export interface ParsedContact {
  name: string | null;
  phone: string;
}

const PHONE = /\+?\d[\d\s().-]{6,}\d/;

/** Últimos 10 dígitos de un celular argentino (igual que lead_phone_digits en SQL). */
export function phoneKey(phone: string): string | null {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("54") && d.length >= 12) d = d.slice(2);
  if (d.startsWith("9") && d.length === 11) d = d.slice(1);
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length === 12) d = d.replace(/^(\d{2,4})15(\d{6,8})$/, "$1$2");
  const key = d.slice(-10);
  return key.length >= 8 ? key : null;
}

function cleanName(text: string): string | null {
  const name = text.replace(/[\t;,|:-]+/g, " ").replace(/\s+/g, " ").trim();
  return name && /[a-záéíóúñ]/i.test(name) ? name.slice(0, 80) : null;
}

/** Archivo de contactos (vCard): FN + TEL. */
function parseVcf(text: string): ParsedContact[] {
  const out: ParsedContact[] = [];
  for (const card of text.split(/BEGIN:VCARD/i).slice(1)) {
    const unfolded = card.replace(/\r?\n[ \t]/g, "");
    const fn = unfolded.match(/^FN[^:\n]*:(.*)$/im)?.[1]?.trim() ?? null;
    for (const m of unfolded.matchAll(/^TEL[^:\n]*:(.*)$/gim)) {
      const phone = m[1].trim();
      if (phoneKey(phone)) out.push({ name: fn ? cleanName(fn) : null, phone });
    }
  }
  return out;
}

/** Una línea por contacto, en cualquier orden: "Juan Pérez 11 5555-1234",
 * "+54 9 294 455-1234 - Carnicería Don Julio", o solo el número. */
function parseLines(text: string): ParsedContact[] {
  const out: ParsedContact[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(PHONE);
    if (!match) continue;
    const phone = match[0].trim();
    if (!phoneKey(phone)) continue;
    out.push({ name: cleanName(line.replace(match[0], " ")), phone });
  }
  return out;
}

/** Contactos sin repetir (mismo celular = mismo contacto; gana el que tiene nombre). */
export function parseContacts(text: string): ParsedContact[] {
  const list = /BEGIN:VCARD/i.test(text) ? parseVcf(text) : parseLines(text);
  const byKey = new Map<string, ParsedContact>();
  for (const c of list) {
    const key = phoneKey(c.phone)!;
    const prev = byKey.get(key);
    if (!prev || (!prev.name && c.name)) byKey.set(key, c);
  }
  return [...byKey.values()];
}
