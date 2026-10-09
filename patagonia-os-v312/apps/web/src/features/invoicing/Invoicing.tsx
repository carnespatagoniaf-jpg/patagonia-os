import { useCallback, useEffect, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { formatMoney } from "../shifts/format";
import { useActiveBranch } from "../branches/BranchProvider";
import { SettingSection } from "../../components/SettingSection";
import {
  getFiscalSettings,
  listInvoices,
  listUninvoicedSales,
  requestInvoice,
  saveFiscalSettings,
  type FiscalSettings,
  type Invoice,
  type UninvoicedSale
} from "./invoicing-service";
import {
  CUSTOMER_CONDITION_LABEL,
  ISSUER_CONDITION_LABEL,
  emptyInvoiceDraft,
  formatCuit,
  invoiceDraftError,
  invoiceLabel,
  isValidCuit,
  type InvoiceDraft,
  type IssuerCondition
} from "./invoicing-view";
import { InvoiceRequestFields } from "./InvoiceRequestFields";

// Facturas (factura electrónica ARCA, migración 113, plan Full). Pantalla del dueño:
// datos fiscales, cómo conectarse con ARCA, ventas sin factura y facturas emitidas.

/** CUIT de Patagonia OS: a este CUIT le delega cada negocio la facturación en ARCA. */
const PROVIDER_CUIT = "27182448902";

interface Form {
  cuit: string;
  businessName: string;
  taxCondition: IssuerCondition;
  pointOfSale: string;
  address: string;
  grossIncomeNumber: string;
  activityStart: string;
  defaultVatRate: string;
}

const formFrom = (s: FiscalSettings | null): Form => ({
  cuit: s ? formatCuit(s.cuit) : "",
  businessName: s?.businessName ?? "",
  taxCondition: s?.taxCondition ?? "monotributo",
  pointOfSale: s ? String(s.pointOfSale) : "",
  address: s?.address ?? "",
  grossIncomeNumber: s?.grossIncomeNumber ?? "",
  activityStart: s?.activityStart ?? "",
  defaultVatRate: s ? String(s.defaultVatRate) : "10.5"
});

/** Cuántas ventas sin factura se ven sin buscar (el resto, buscando por importe). */
const SALES_SHOWN = 10;

const STATUS_LABEL: Record<Invoice["status"], string> = { pendiente: "Pendiente", autorizada: "Autorizada", rechazada: "Rechazada" };

export function Invoicing() {
  const { branchId } = useActiveBranch();
  const [settings, setSettings] = useState<FiscalSettings | null>(null);
  const [form, setForm] = useState<Form>(formFrom(null));
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [sales, setSales] = useState<UninvoicedSale[]>([]);
  const [invoicing, setInvoicing] = useState<{ saleId: string; draft: InvoiceDraft } | null>(null);
  const [saleFilter, setSaleFilter] = useState("");
  // Por importe: "24656", "24.656" o "24656,00" encuentran la venta de $24.656.
  const filterDigits = saleFilter.replace(/[.\s]/g, "").split(",")[0].replace(/\D/g, "");
  const filteredSales = filterDigits ? sales.filter((s) => String(Math.round(s.total)).includes(filterDigits)) : sales;
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    try {
      const s = await getFiscalSettings();
      setSettings(s);
      setForm(formFrom(s));
      setInvoices(await listInvoices());
      setSales(s?.enabled && branchId ? await listUninvoicedSales(branchId) : []);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar la facturación.");
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleSave() {
    setMessage("");
    if (!isValidCuit(form.cuit)) {
      setMessage("El CUIT no es válido: revisá los 11 números.");
      return;
    }
    const pointOfSale = Number(form.pointOfSale);
    if (!Number.isInteger(pointOfSale) || pointOfSale < 1) {
      setMessage("Poné el número de punto de venta que creaste en ARCA (por ejemplo 5).");
      return;
    }
    setBusy(true);
    try {
      await saveFiscalSettings({
        cuit: form.cuit,
        businessName: form.businessName.trim(),
        taxCondition: form.taxCondition,
        pointOfSale,
        address: form.address,
        grossIncomeNumber: form.grossIncomeNumber,
        activityStart: form.activityStart,
        defaultVatRate: Number(form.defaultVatRate)
      });
      setMessage("Datos fiscales guardados.");
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron guardar los datos.");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvoiceSale(sale: UninvoicedSale) {
    if (!invoicing || !settings) return;
    const error = invoiceDraftError(settings.taxCondition, invoicing.draft, sale.total);
    if (error) {
      setMessage(error);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await requestInvoice(sale.id, invoicing.draft);
      setMessage(`Factura ${result.letter} pedida a ARCA por ${formatMoney(sale.total)}.`);
      setInvoicing(null);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo pedir la factura.");
    } finally {
      setBusy(false);
    }
  }

  const status = !settings
    ? { text: "Primero cargá los datos fiscales del negocio.", tone: "warn" as const }
    : !settings.enabled
      ? { text: "Datos cargados. Falta conectar con ARCA (abajo).", tone: "warn" as const }
      : { text: "Activa: en Mostrador aparece \"El cliente pide factura\".", tone: "ok" as const };

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">FINANZAS</p>
          <h1>Facturas</h1>
          <p className="muted">Factura electrónica de ARCA: se hace en Mostrador cuando el cliente la pide.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}

      <section className="panel" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
          <strong>Estado</strong>
          <span className={`setting-status ${status.tone}`}>{loading ? "Cargando…" : status.text}</span>
        </div>

        <SettingSection
          title="Datos fiscales del negocio"
          status={settings ? `${ISSUER_CONDITION_LABEL[settings.taxCondition]} · CUIT ${formatCuit(settings.cuit)} · PV ${settings.pointOfSale}` : "Sin cargar"}
          tone={settings ? "ok" : "warn"}
          actionLabel={settings ? "Cambiar" : "Cargar"}
          defaultOpen={!settings && !loading}
        >
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", maxWidth: 760 }}>
            <label className="muted">
              CUIT
              <input name="fiscal-cuit" autoComplete="off" inputMode="numeric" placeholder="20-12345678-6" value={form.cuit} onChange={(e) => setForm({ ...form, cuit: e.target.value })} style={{ width: "100%" }} />
            </label>
            <label className="muted">
              Razón social
              <input name="fiscal-name" autoComplete="off" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} style={{ width: "100%" }} />
            </label>
            <label className="muted">
              Condición frente al IVA
              <select value={form.taxCondition} onChange={(e) => setForm({ ...form, taxCondition: e.target.value as IssuerCondition })} style={{ width: "100%" }}>
                <option value="monotributo">Monotributo (Factura C)</option>
                <option value="responsable_inscripto">Responsable inscripto (Factura A y B)</option>
              </select>
            </label>
            <label className="muted">
              Punto de venta (el que creaste en ARCA)
              <input name="fiscal-pos" autoComplete="off" inputMode="numeric" placeholder="5" value={form.pointOfSale} onChange={(e) => setForm({ ...form, pointOfSale: e.target.value.replace(/\D/g, "") })} style={{ width: "100%" }} />
            </label>
            <label className="muted">
              Domicilio comercial
              <input name="fiscal-address" autoComplete="off" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} style={{ width: "100%" }} />
            </label>
            <label className="muted">
              Ingresos Brutos (N.º)
              <input name="fiscal-iibb" autoComplete="off" value={form.grossIncomeNumber} onChange={(e) => setForm({ ...form, grossIncomeNumber: e.target.value })} style={{ width: "100%" }} />
            </label>
            <label className="muted">
              Inicio de actividades
              <input type="date" value={form.activityStart} onChange={(e) => setForm({ ...form, activityStart: e.target.value })} style={{ width: "100%" }} />
            </label>
            {form.taxCondition === "responsable_inscripto" && (
              <label className="muted">
                IVA de lo que vendés
                <select value={form.defaultVatRate} onChange={(e) => setForm({ ...form, defaultVatRate: e.target.value })} style={{ width: "100%" }}>
                  <option value="10.5">10,5% (carne fresca)</option>
                  <option value="21">21%</option>
                </select>
              </label>
            )}
          </div>
          <p className="setting-help">Estos datos salen impresos en la factura. Si cambiás el CUIT, la condición o el punto de venta, hay que volver a probar la conexión con ARCA.</p>
          <div>
            <button disabled={busy} onClick={() => void handleSave()}>{busy ? "Guardando…" : "Guardar datos fiscales"}</button>
          </div>
        </SettingSection>

        <SettingSection
          title="Conectar con ARCA (una sola vez)"
          status={settings?.enabled ? "Conectado" : "Sin conectar"}
          tone={settings?.enabled ? "ok" : "neutral"}
          actionLabel="Ver pasos"
        >
          <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6, fontSize: 14 }}>
            <li>
              Entrá a <strong>arca.gob.ar</strong> con la clave fiscal del negocio (nivel 3) → <strong>Administrador de Relaciones de Clave Fiscal</strong> →{" "}
              <strong>Nueva Relación</strong> → Servicio: ARCA → Web Services → <strong>Facturación Electrónica</strong> → Representante: el CUIT de Patagonia OS{" "}
              <strong>{formatCuit(PROVIDER_CUIT)}</strong> → Confirmar.
            </li>
            <li>
              En <strong>Administración de puntos de venta y domicilios</strong> → Agregar un punto de venta con el sistema <strong>"RECE para aplicativo y web services"</strong>. Su número es el que va arriba, en "Punto de venta".
            </li>
            <li>Tocá <strong>Probar conexión con ARCA</strong>. Si da bien, la factura queda activa en Mostrador.</li>
          </ol>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button disabled title="Se habilita en cuanto Patagonia OS termine la conexión con ARCA">Probar conexión con ARCA</button>
            <span className="setting-help">Disponible en los próximos días: la estamos terminando.</span>
          </div>
          {settings?.lastCheckAt && (
            <p className="setting-help">
              Última prueba: {new Date(settings.lastCheckAt).toLocaleString("es-AR")} — {settings.lastCheckOk ? "bien" : `falló: ${settings.lastCheckMessage ?? ""}`}
            </p>
          )}
        </SettingSection>
      </section>

      {settings?.enabled && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-title">
            <h2>Ventas sin factura (últimos 7 días)</h2>
            <span>{sales.length}</span>
          </div>
          <p className="muted" style={{ marginTop: -6 }}>Si el cliente pidió la factura después de pagar, buscá su venta por el importe del ticket.</p>
          <input
            type="search"
            name="uninvoiced-search"
            autoComplete="off"
            inputMode="decimal"
            placeholder="Importe del ticket (ej. 24656)"
            value={saleFilter}
            onChange={(e) => setSaleFilter(e.target.value)}
            style={{ width: 260, marginBottom: 8 }}
          />
          {sales.length === 0 && <p className="muted">No hay ventas sin factura.</p>}
          {filteredSales.length === 0 && sales.length > 0 && <p className="muted">Ninguna venta sin factura con ese importe.</p>}
          {filteredSales.length > SALES_SHOWN && (
            <p className="muted" style={{ fontSize: 12 }}>Mostrando las {SALES_SHOWN} más recientes de {filteredSales.length}. Escribí el importe para encontrar otra.</p>
          )}
          {filteredSales.slice(0, SALES_SHOWN).map((sale) => (
            <div key={sale.id} className="list-row" style={{ flexWrap: "wrap" }}>
              <span>
                {new Date(sale.createdAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })} · <strong>{formatMoney(sale.total)}</strong>
              </span>
              {invoicing?.saleId === sale.id ? (
                <div style={{ flexBasis: "100%" }}>
                  <InvoiceRequestFields issuer={settings.taxCondition} draft={invoicing.draft} total={sale.total} onChange={(draft) => setInvoicing({ saleId: sale.id, draft })} />
                  <button disabled={busy} onClick={() => void handleInvoiceSale(sale)}>Pedir factura</button>{" "}
                  <button className="secondary" onClick={() => setInvoicing(null)}>Cancelar</button>
                </div>
              ) : (
                <button className="secondary" onClick={() => setInvoicing({ saleId: sale.id, draft: { ...emptyInvoiceDraft(), wanted: true } })}>Facturar</button>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-title">
          <h2>Facturas emitidas</h2>
          <span>{invoices.length}</span>
        </div>
        {invoices.length === 0 && !loading && <p className="muted">Todavía no hay facturas.</p>}
        {invoices.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Comprobante</th>
                <th>Cliente</th>
                <th className="num">Total</th>
                <th>Estado</th>
                <th>CAE</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>{new Date(inv.createdAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{invoiceLabel(inv)}</td>
                  <td>
                    {inv.customerName || CUSTOMER_CONDITION_LABEL[inv.customerTaxCondition]}
                    {inv.customerDocType !== 99 && <span className="muted"> · {inv.customerDocType === 80 ? `CUIT ${formatCuit(inv.customerDocNumber)}` : `DNI ${inv.customerDocNumber}`}</span>}
                  </td>
                  <td className="num">{formatMoney(inv.total)}</td>
                  <td>
                    <span className={`setting-status ${inv.status === "autorizada" ? "ok" : inv.status === "rechazada" ? "warn" : ""}`}>{STATUS_LABEL[inv.status]}</span>
                    {inv.status === "rechazada" && inv.errorMessage && <div className="muted" style={{ fontSize: 12 }}>{inv.errorMessage}</div>}
                  </td>
                  <td>{inv.cae ? `${inv.cae}${inv.caeDue ? ` (vence ${inv.caeDue})` : ""}` : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
