import { useState } from "react";
import { Copy, MessageCircle } from "lucide-react";
import { whatsappLink } from "./sales-pipeline";
import { Button, Card, Field, Input } from "./ui/components";

const PHONE_KEY = "patagonia-admin-whatsapp";

function readPhone() {
  try {
    return window.localStorage.getItem(PHONE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * "Resumen del día" (Etapa 4): el texto listo y un botón que abre WhatsApp con el mensaje para mandártelo a vos
 * (o a un socio). El número queda guardado en este navegador. El envío automático todos los días necesita un número
 * de WhatsApp aparte (API de Meta) o mail: queda para cuando el dueño lo decida.
 */
export function DailySummaryCard({ text }: { text: string }) {
  const [phone, setPhone] = useState(readPhone);
  const [copied, setCopied] = useState(false);
  const link = whatsappLink(phone.trim() || null, text);

  function savePhone(value: string) {
    setPhone(value);
    try {
      window.localStorage.setItem(PHONE_KEY, value);
    } catch {
      // Sin almacenamiento: vale mientras esté abierta la pestaña.
    }
  }

  return (
    <Card
      title="Resumen del día"
      subtitle="Lo importante de hoy, listo para mandarte por WhatsApp."
      actions={
        <>
          <Button variant="secondary" size="sm" icon={Copy} onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => undefined); }}>
            {copied ? "¡Copiado!" : "Copiar"}
          </Button>
          {link ? (
            <a className="pa-btn pa-btn-whatsapp pa-btn-sm" href={link} target="_blank" rel="noreferrer"><MessageCircle size={14} /> Mandármelo por WhatsApp</a>
          ) : null}
        </>
      }
    >
      <pre className="pa-pre" style={{ maxHeight: 320 }}>{text}</pre>
      <div style={{ maxWidth: 320 }}>
        <Field label="Tu WhatsApp" hint="Queda guardado en esta computadora o celular.">
          {(id) => <Input id={id} inputMode="tel" placeholder="Ej.: 2966 15 555-123" value={phone} onChange={(e) => savePhone(e.target.value)} />}
        </Field>
      </div>
    </Card>
  );
}
