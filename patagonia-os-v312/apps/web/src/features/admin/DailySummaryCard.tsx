import { useEffect, useState } from "react";
import { Copy, MessageCircle, Send } from "lucide-react";
import { getDailySummarySettings, getFinanceOverview, sendDailySummaryNow, setDailySummarySettings, type DailySummarySettings } from "./admin-service";
import type { FinAccount } from "./finance";
import { whatsappLink } from "./sales-pipeline";
import { amountInputText, parseAmount } from "../../lib/money";
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Select } from "./ui/components";

const PHONE_KEY = "patagonia-admin-whatsapp";
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function readPhone() {
  try {
    return window.localStorage.getItem(PHONE_KEY) ?? "";
  } catch {
    return "";
  }
}

function resultText(r: DailySummarySettings["lastResult"]): { tone: "ok" | "warn" | "danger"; text: string } | null {
  if (!r) return null;
  if (r.error) return { tone: "danger", text: r.error };
  if (r.dryRun) return { tone: "warn", text: "No se mandó: falta conectar el número de WhatsApp (secretos de Meta)." };
  const failed = r.failed ?? [];
  if (failed.length > 0) return { tone: (r.sent ?? 0) > 0 ? "warn" : "danger", text: `Llegó a ${r.sent ?? 0}; falló en ${failed.length}: ${failed[0].error ?? ""}` };
  const costText = r.cost ? (r.cost.error ? ` No se pudo anotar el costo: ${r.cost.error}` : ` Costo anotado en Finanzas: ${r.cost.amount.toLocaleString("es-AR")}.`) : "";
  return { tone: r.cost?.error ? "warn" : "ok", text: `Mandado a ${r.sent ?? 0} ${(r.sent ?? 0) === 1 ? "número" : "números"}.${costText}` };
}

/**
 * "Resumen del día" (Etapa 4): el texto listo, un botón para mandártelo a mano y el envío automático por
 * WhatsApp (migraciones 209-210 + Edge Function daily-summary) a la hora que elijas, con el costo anotado en Finanzas.
 */
export function DailySummaryCard({ text }: { text: string }) {
  const [phone, setPhone] = useState(readPhone);
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState<DailySummarySettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [numbers, setNumbers] = useState("");
  const [hour, setHour] = useState(8);
  const [accounts, setAccounts] = useState<FinAccount[]>([]);
  const [costAccountId, setCostAccountId] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "send">("");
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);
  const link = whatsappLink(phone.trim() || null, text);

  async function load() {
    const s = await getDailySummarySettings();
    setSettings(s);
    if (s) {
      setEnabled(s.enabled);
      setNumbers(s.recipients.join(", "));
      setHour(s.sendHour);
      setCostAccountId(s.costAccountId ?? "");
      setPrice(s.costPerMessage !== null ? amountInputText(s.costPerMessage) : "");
    }
  }

  useEffect(() => {
    void load();
    // Cuentas de Finanzas donde anotar el costo (la tarjeta, por ejemplo).
    getFinanceOverview(new Date().toISOString().slice(0, 7))
      .then((o) => setAccounts(o.accounts.filter((a) => a.active)))
      .catch(() => setAccounts([]));
  }, []);

  function savePhone(value: string) {
    setPhone(value);
    try {
      window.localStorage.setItem(PHONE_KEY, value);
    } catch {
      // Sin almacenamiento: vale mientras esté abierta la pestaña.
    }
  }

  const list = numbers.split(/[,;\n]+/).map((n) => n.trim()).filter(Boolean);
  const priceValue = price.trim() ? parseAmount(price) : null;
  const priceOk = priceValue === null || (Number.isFinite(priceValue) && priceValue >= 0);
  const costAccount = accounts.find((a) => a.id === costAccountId) ?? null;

  async function save() {
    setBusy("save");
    setNotice(null);
    try {
      if (!priceOk) throw new Error("El precio por mensaje no es válido.");
      await setDailySummarySettings(enabled, list, hour, costAccountId || null, costAccountId ? priceValue : null);
      await load();
      setNotice({ tone: "ok", text: enabled ? `Listo: todos los días a las ${hour} h.` : "Guardado. El envío automático quedó apagado." });
    } catch (err) {
      setNotice({ tone: "danger", text: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setBusy("");
    }
  }

  async function sendNow() {
    setBusy("send");
    setNotice(null);
    try {
      const r = await sendDailySummaryNow();
      setNotice(resultText(r));
      await load();
    } catch (err) {
      setNotice({ tone: "danger", text: err instanceof Error ? err.message : "No se pudo mandar." });
    } finally {
      setBusy("");
    }
  }

  const last = resultText(settings?.lastResult ?? null);
  const dirty =
    settings !== null &&
    (enabled !== settings.enabled ||
      hour !== settings.sendHour ||
      list.join(",") !== settings.recipients.join(",") ||
      (costAccountId || null) !== settings.costAccountId ||
      (costAccountId ? priceValue : null) !== settings.costPerMessage);

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
        <Field label="Tu WhatsApp (para el botón verde)" hint="Queda guardado en esta computadora o celular.">
          {(id) => <Input id={id} inputMode="tel" placeholder="Ej.: 2966 15 555-123" value={phone} onChange={(e) => savePhone(e.target.value)} />}
        </Field>
      </div>

      {settings && (
        <section className="pa-section">
          <div className="pa-row-between">
            <h3 className="pa-section-title">Envío automático todas las mañanas</h3>
            <Badge tone={settings.enabled ? "ok" : "neutral"}>{settings.enabled ? `Prendido · ${settings.sendHour} h` : "Apagado"}</Badge>
          </div>
          <span className="pa-muted" style={{ fontSize: 13 }}>
            Llega solo desde el número de WhatsApp del sistema (no el de Kommo). Hasta que ese número esté conectado, no se manda nada.
          </span>
          <div className="pa-form-grid">
            <Field label="Números que lo reciben" hint="Separados por coma. Hasta 5.">
              {(id) => <Input id={id} inputMode="tel" placeholder="2966 15 555-123, 11 5555-1234" value={numbers} onChange={(e) => setNumbers(e.target.value)} />}
            </Field>
            <Field label="Hora">
              {(id) => (
                <Select id={id} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                </Select>
              )}
            </Field>
            <Field label="Anotar el costo en" hint="Cada envío se anota como gasto “WhatsApp” en Finanzas.">
              {(id) => (
                <Select id={id} value={costAccountId} onChange={(e) => setCostAccountId(e.target.value)}>
                  <option value="">No anotarlo</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                </Select>
              )}
            </Field>
            <Field
              label={`Precio por mensaje${costAccount ? ` (${costAccount.currency})` : ""}`}
              hint={costAccount?.currency === "USD" ? "Lo que cobra Meta, ej. 0,03" : "En pesos, lo que te cobra la tarjeta por mensaje"}
              error={priceOk ? undefined : "No es un número válido"}
            >
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  className="pa-num"
                  disabled={!costAccountId}
                  placeholder={costAccount?.currency === "USD" ? "0,03" : "40"}
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  invalid={!priceOk}
                />
              )}
            </Field>
          </div>
          <Checkbox label="Mandarlo todos los días" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <div className="pa-row">
            <Button loading={busy === "save"} disabled={!dirty} onClick={() => void save()}>Guardar</Button>
            <Button variant="secondary" icon={Send} loading={busy === "send"} disabled={settings.recipients.length === 0 || dirty} onClick={() => void sendNow()}>Probar ahora</Button>
          </div>
          {notice && <Alert tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Alert>}
          {!notice && last && settings.lastRunAt && (
            <span className={`pa-text-${last.tone}`} style={{ fontSize: 13 }}>
              Última vez {new Date(settings.lastRunAt).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}: {last.text}
            </span>
          )}
        </section>
      )}
    </Card>
  );
}
