import { useCallback, useEffect, useRef, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { formatMoney } from "../shifts/format";
import { useActiveBranch } from "../branches/BranchProvider";
import { SettingSection } from "../../components/SettingSection";
import {
  authorizeInvoices,
  checkArcaConnection,
  getArcaCertificateStatus,
  getFiscalSettings,
  invoicePrintFrom,
  requestArcaCertificate,
  uploadArcaCertificate,
  type ArcaCertificateStatus,
  listInvoices,
  listUninvoicedSales,
  loadInvoiceItems,
  requestCreditNote,
  requestInvoice,
  saveFiscalSettings,
  setFiscalTradeName,
  type FiscalSettings,
  type Invoice,
  type UninvoicedSale
} from "./invoicing-service";
import { ReceiptView } from "../sale/SaleReceipts";
import { buildReceiptTicket } from "../sale/sale-tickets";
import { isThermalPrinterPaired, printBytes } from "../sale/thermal-printer";
import type { ReceiptState } from "../sale/sale-model";
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
import { RemitoRPanel } from "./RemitoRPanel";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";

// Facturas (factura electrónica ARCA, migraciones 113/121/136, planes Estándar y Full).
// Pantalla del dueño: datos fiscales, conexión con ARCA, ventas sin factura y
// facturas emitidas (reimprimir, anular con nota de crédito, reintentar pendientes).


interface Form {
  cuit: string;
  businessName: string;
  tradeName: string;
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
  tradeName: s?.tradeName ?? "",
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
  const { profile } = useAuth();
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
  const [printReceipt, setPrintReceipt] = useState<ReceiptState | null>(null);
  const [thermalBusy, setThermalBusy] = useState(false);
  const retriedRef = useRef(false);
  const [cert, setCert] = useState<ArcaCertificateStatus | null>(null);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    try {
      const s = await getFiscalSettings();
      setSettings(s);
      setForm(formFrom(s));
      // Certificado propio del negocio (migración 137). Si la función no responde, la pantalla sigue igual.
      setCert(s ? await getArcaCertificateStatus().catch(() => null) : null);
      let list = await listInvoices();
      // Pendientes (ARCA no respondió al cobrar): se reintentan solas una vez al abrir.
      if (s?.enabled && !retriedRef.current && list.some((i) => i.status === "pendiente")) {
        retriedRef.current = true;
        try {
          await authorizeInvoices();
          list = await listInvoices();
        } catch {
          // queda pendiente; está el botón "Reintentar"
        }
      }
      setInvoices(list);
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
      await setFiscalTradeName(form.tradeName);
      setMessage("Datos fiscales guardados.");
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron guardar los datos.");
    } finally {
      setBusy(false);
    }
  }

  /** Paso 1: bajar el pedido de certificado (.csr) para subirlo en ARCA. */
  async function handleDownloadRequest(regenerate = false) {
    if (regenerate && !window.confirm("¿Generar un certificado nuevo? El actual deja de servir hasta que subas el nuevo, y mientras tanto no se factura.")) return;
    setBusy(true);
    setMessage("");
    try {
      const { csrPem } = await requestArcaCertificate(regenerate);
      const url = URL.createObjectURL(new Blob([csrPem], { type: "application/pkcs10" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `pedido-certificado-${settings?.cuit ?? "arca"}.csr`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage("Pedido de certificado descargado (está en Descargas). Seguí con el paso 2 en ARCA.");
      setCert(await getArcaCertificateStatus().catch(() => cert));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo generar el pedido.");
    } finally {
      setBusy(false);
    }
  }

  /** Paso 3: subir el certificado que se bajó de ARCA. */
  async function handleUploadCertificate(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await uploadArcaCertificate(await file.text());
      setMessage(`Certificado cargado (vence el ${new Date(result.certExpiresAt).toLocaleDateString("es-AR")}). Seguí con los pasos 4 y 5 y después Probar conexión.`);
      setCert(await getArcaCertificateStatus().catch(() => cert));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar el certificado.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCheck() {
    setBusy(true);
    setMessage("");
    try {
      const result = await checkArcaConnection();
      setMessage(result.message);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo probar la conexión.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry(invoiceId?: string) {
    setBusy(true);
    setMessage("");
    try {
      const results = await authorizeInvoices(invoiceId);
      const ok = results.filter((r) => r.status === "autorizada").length;
      const notes = results.filter((r) => r.status !== "autorizada").map((r) => r.message).filter(Boolean);
      setMessage(results.length === 0 ? "No había nada pendiente." : `${ok} autorizada(s) por ARCA.${notes.length ? ` ${notes.join(" ")}` : ""}`);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo hablar con ARCA.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreditNote(inv: Invoice) {
    if (!window.confirm(`¿Anular ${invoiceLabel(inv)} por ${formatMoney(inv.total)}? Se hace una nota de crédito en ARCA y no se puede deshacer.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const id = await requestCreditNote(inv.id);
      const result = (await authorizeInvoices(id)).find((r) => r.id === id);
      setMessage(
        result?.status === "autorizada"
          ? `Nota de crédito ${result.letter} autorizada (CAE ${result.cae}).`
          : `La nota de crédito quedó ${result?.status ?? "pendiente"}${result?.message ? `: ${result.message}` : ""}.`
      );
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo anular la factura.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePrintInvoice(inv: Invoice) {
    if (!settings) return;
    setMessage("");
    try {
      const related = inv.relatedInvoiceId ? invoices.find((i) => i.id === inv.relatedInvoiceId) ?? null : null;
      const print = invoicePrintFrom(inv, settings, related);
      if (!print) return;
      const items = await loadInvoiceItems(inv);
      const itemsTotal = items.reduce((acc, i) => acc + i.lineTotal, 0);
      const receipt: ReceiptState = {
        items: items.map((i) => ({ name: i.name, unit: i.unit, quantity: i.quantity, unitPrice: i.unitPrice, discountAmount: i.quantity * i.unitPrice - i.lineTotal })),
        // Descuento o recargo de toda la venta: la diferencia entre los renglones y el total facturado.
        saleDiscount: Math.max(itemsTotal - inv.total, 0),
        saleSurcharge: Math.max(inv.total - itemsTotal, 0),
        total: inv.total,
        soldAt: inv.createdAt,
        paymentSummary: "",
        amountTendered: null,
        change: null,
        invoice: print
      };
      setPrintReceipt(receipt);
      if (await isThermalPrinterPaired()) {
        await printBytes(buildReceiptTicket(receipt));
      } else {
        setTimeout(() => window.print(), 150);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo imprimir.");
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
      const outcome = (await authorizeInvoices(result.invoiceId)).find((r) => r.id === result.invoiceId);
      setMessage(
        outcome?.status === "autorizada"
          ? `Factura ${result.letter} por ${formatMoney(sale.total)} autorizada (CAE ${outcome.cae}). Para imprimirla, tocá Imprimir en la lista de abajo.`
          : `Factura ${result.letter} ${outcome?.status ?? "pendiente"}${outcome?.message ? `: ${outcome.message}` : ""}.`
      );
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
      : { text: "Activa: en Mostrador, al cobrar, aparece la opción \"Factura\".", tone: "ok" as const };

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">FINANZAS</p>
          <h1>Facturas</h1>
          <p className="muted">Factura electrónica de ARCA: se hace en Mostrador o en Clientes cuando el cliente la pide.</p>
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
              Razón social (titular del CUIT, como figura en ARCA)
              <input name="fiscal-name" autoComplete="off" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} style={{ width: "100%" }} />
            </label>
            <label className="muted">
              Nombre de fantasía (opcional, va grande arriba)
              <input name="fiscal-trade-name" autoComplete="off" placeholder="CARNES" value={form.tradeName} onChange={(e) => setForm({ ...form, tradeName: e.target.value })} style={{ width: "100%" }} />
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
          {cert?.usesShared ? (
            <p className="setting-help">Este negocio factura con el certificado de Patagonia OS, que es de su mismo CUIT: solo hace falta el punto de venta "Web Services" y probar la conexión.</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8, fontSize: 14 }}>
              <li>
                <strong>Bajá el pedido de certificado</strong> (es de este negocio, con su CUIT).{" "}
                <button className="secondary" disabled={busy || !settings} onClick={() => void handleDownloadRequest()}>
                  {cert?.hasRequest ? "Volver a bajar el pedido" : "Bajar pedido de certificado"}
                </button>
              </li>
              <li>
                Entrá a <strong>arca.gob.ar</strong> con la clave fiscal del negocio (nivel 3) → <strong>Administración de Certificados Digitales</strong> (si no aparece:
                Administrador de Relaciones → Adherir servicio → ARCA → Servicios Interactivos) → <strong>Agregar alias</strong> → Alias: <strong>{cert?.alias ?? "patagonia"}</strong> →
                elegí el archivo del paso 1 → Agregar alias → en la lista, <strong>Ver</strong> → <strong>Descargar</strong>.
              </li>
              <li>
                <strong>Subí el certificado</strong> que bajaste de ARCA:{" "}
                <input type="file" accept=".crt,.cer,.pem,.txt" disabled={busy || !cert?.hasRequest} onChange={(e) => void handleUploadCertificate(e.target.files?.[0])} />
                {cert?.hasCertificate && cert.certExpiresAt && (
                  <span className="setting-status ok" style={{ marginLeft: 8 }}>Cargado · vence {new Date(cert.certExpiresAt).toLocaleDateString("es-AR")}</span>
                )}
              </li>
              <li>
                En ARCA → <strong>Administrador de Relaciones de Clave Fiscal</strong> → <strong>Nueva Relación</strong> → Servicio: ARCA → WebServices →{" "}
                <strong>Facturación Electrónica</strong> → Representante: Buscar → <strong>Computador Fiscal "{cert?.alias ?? "patagonia"}"</strong> → Confirmar.
              </li>
              <li>
                En <strong>Administración de puntos de venta y domicilios</strong> → A/B/M → Agregar un punto de venta con el sistema de <strong>Web Services</strong> (Monotributo:
                "Factura Electrónica - Monotributo - Web Services"; Responsable inscripto: "RECE para aplicativo y web services"). No sirve el de "Factura en Línea". Su número va arriba, en "Punto de venta".
              </li>
              <li>Tocá <strong>Probar conexión con ARCA</strong>. Si da bien, la factura queda activa en Mostrador y en Clientes.</li>
            </ol>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button disabled={busy || !settings} onClick={() => void handleCheck()}>{busy ? "Probando…" : "Probar conexión con ARCA"}</button>
            {!settings && <span className="setting-help">Primero guardá los datos fiscales.</span>}
          </div>
          {cert?.hasCertificate && !cert.usesShared && (
            <p className="setting-help">
              ¿Hay que renovarlo o cambió algo?{" "}
              <button className="link-button" disabled={busy} onClick={() => void handleDownloadRequest(true)}>Generar un certificado nuevo</button>
            </p>
          )}
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

      {printReceipt && (
        <ReceiptView
          receipt={printReceipt}
          branchName=""
          thermalPrintBusy={thermalBusy}
          onPrint={(copies = 1) => {
            for (let i = 0; i < copies; i++) window.print();
          }}
          onThermalPrint={async () => {
            setThermalBusy(true);
            try {
              await printBytes(buildReceiptTicket(printReceipt));
            } catch (err) {
              setMessage(err instanceof Error ? err.message : "No se pudo imprimir en la térmica.");
            } finally {
              setThermalBusy(false);
            }
          }}
        />
      )}

      {/* Remito R con CAI (migración 147): plan Full. */}
      {planAllows(profile, "full") && <RemitoRPanel issuerCondition={settings?.taxCondition ?? null} />}

      <section className="panel">
        <div className="panel-title">
          <h2>Facturas emitidas</h2>
          <span>{invoices.length}</span>
        </div>
        {invoices.some((i) => i.status === "pendiente") && (
          <p>
            <button className="secondary" disabled={busy} onClick={() => void handleRetry()}>Reintentar las pendientes</button>
          </p>
        )}
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
                <th />
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
                    {inv.status !== "autorizada" && inv.errorMessage && <div className="muted" style={{ fontSize: 12 }}>{inv.errorMessage}</div>}
                  </td>
                  <td>{inv.cae ? `${inv.cae}${inv.caeDue ? ` (vence ${inv.caeDue})` : ""}` : "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {inv.status === "autorizada" && <button className="secondary" onClick={() => void handlePrintInvoice(inv)}>Imprimir</button>}{" "}
                    {inv.status === "autorizada" && inv.kind === "factura" && !invoices.some((n) => n.relatedInvoiceId === inv.id && n.status !== "rechazada") && (
                      <button className="secondary" disabled={busy} onClick={() => void handleCreditNote(inv)}>Anular</button>
                    )}
                    {inv.status === "pendiente" && <button className="secondary" disabled={busy} onClick={() => void handleRetry(inv.id)}>Reintentar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
