import { useCallback, useEffect, useMemo, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { useActiveBranch } from "../branches/BranchProvider";
import { useSuppliers } from "../purchases/useSuppliers";
import { readStatementFile } from "../reconciliation/read-statement-file";
import { formatMoney } from "../shifts/format";
import { buildAccountingSheets } from "./accounting-export";
import {
  deletePurchaseVoucher,
  getAccountingMonth,
  getAging,
  importPurchaseVouchers,
  listInventorySnapshots,
  listOfficialDues,
  listSupplierTaxInfo,
  listTaxReminders,
  type AccountingMonth,
  type AgingRow,
  type ImportVouchersResult
} from "./accounting-service";
import { AgingPanel } from "./AgingPanel";
import { buildYearSheets, fiscalYearMonths } from "./accounting-year";
import { computeIibb } from "./iibb";
import { IibbPanel } from "./IibbPanel";
import { InventoryClosePanel } from "./InventoryClosePanel";
import { TaxCalendarPanel } from "./TaxCalendarPanel";
import { upcomingDues, type OfficialDue, type TaxReminder } from "./tax-calendar";
import { VoucherAttachment } from "./VoucherAttachment";
import {
  isCreditNote,
  monotributoStatus,
  monthLabel,
  purchaseDiscriminatesVat,
  saleVatLines,
  vatPosition,
  voucherNumber,
  voucherTypeLabel,
  type PurchaseVoucher
} from "./accounting-view";
import { buildPurchaseFiles, buildSalesFiles, lidFileNames } from "./libro-iva-digital";
import { parseMisComprobantes, type ParsedRow } from "./mis-comprobantes";
import { PurchaseVoucherForm, type VoucherPurchaseHint, type VoucherSupplier } from "./PurchaseVoucherForm";
import { buildZip, latin1Bytes } from "./zip";

function currentMonth(): string {
  const now = new Date(Date.now() - 3 * 3600_000);
  return now.toISOString().slice(0, 7);
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return fallback;
}

function downloadBlob(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const signed = (p: { voucherType: number }, n: number) => (isCreditNote(p.voucherType) ? -n : n);

type Tab = "resumen" | "libros" | "iibb" | "saldos" | "inventario";
const TABS: { key: Tab; label: string }[] = [
  { key: "resumen", label: "Resumen" },
  { key: "libros", label: "Libros de IVA" },
  { key: "iibb", label: "Ingresos Brutos" },
  { key: "saldos", label: "Quién debe" },
  { key: "inventario", label: "Inventario al cierre" }
];
const pct = (rate: number) => `${String(rate).replace(".", ",")}%`;

export function Accounting() {
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();
  const { suppliers } = useSuppliers();
  const canWrite = profile ? ["owner", "admin", "manager"].includes(profile.role) : true;

  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<AccountingMonth | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [taxInfo, setTaxInfo] = useState<Record<string, { taxId: string | null; taxCondition: string | null }>>({});

  // Formulario de factura de compra: nueva, para una compra, o para corregir una.
  const [form, setForm] = useState<{ existing?: PurchaseVoucher; purchase?: VoucherPurchaseHint } | null>(null);

  // Importar "Mis Comprobantes".
  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<ParsedRow[] | null>(null);
  const [importFile, setImportFile] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<ImportVouchersResult | null>(null);

  const [tab, setTab] = useState<Tab>("resumen");
  const [reminders, setReminders] = useState<TaxReminder[]>([]);
  const [official, setOfficial] = useState<OfficialDue[]>([]);
  const [aging, setAging] = useState<{ asOf: string; receivables: AgingRow[]; payables: AgingRow[] } | null>(null);
  const [agingLoading, setAgingLoading] = useState(false);
  // Resumen del año: mes en que cierra el ejercicio (diciembre si no se elige otro).
  const [yearEnd, setYearEnd] = useState(`${currentMonth().slice(0, 4)}-12`);
  const [yearProgress, setYearProgress] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    try {
      const sixMonthsAgo = new Date(Date.now() - 183 * 86400_000).toISOString().slice(0, 8) + "01";
      const [month_, reminders_, official_] = await Promise.all([
        getAccountingMonth(month),
        listTaxReminders().catch(() => []),
        listOfficialDues(sixMonthsAgo).catch(() => [])
      ]);
      setData(month_);
      setReminders(reminders_);
      setOfficial(official_);
    } catch (err) {
      setMessage(errorText(err, "No se pudo cargar el mes."));
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (isSupabaseConfigured) listSupplierTaxInfo().then(setTaxInfo).catch(() => setTaxInfo({}));
  }, [form]);

  const voucherSuppliers: VoucherSupplier[] = useMemo(
    () => suppliers.map((s) => ({ id: s.id, name: s.name, taxId: taxInfo[s.id]?.taxId ?? null, taxCondition: taxInfo[s.id]?.taxCondition ?? null })),
    [suppliers, taxInfo]
  );

  const ri = data?.company.taxCondition === "responsable_inscripto";
  const position = useMemo(() => (data ? vatPosition(data.sales, data.purchases) : null), [data]);
  const mono = useMemo(() => (data ? monotributoStatus(data.monotributo.invoiced12m, data.monotributo.categories) : null), [data]);
  const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const calendar = useMemo(
    () =>
      data
        ? upcomingDues({
            today,
            cuit: data.company.cuit,
            taxCondition: data.company.taxCondition,
            obligations: data.iibb.settings?.obligations ?? null,
            official,
            reminders,
            iibbDueDay: data.iibb.settings?.dueDay ?? null
          })
        : { items: [], missingCuit: false },
    [data, official, reminders, today]
  );
  const iibbResult = useMemo(
    () =>
      data?.iibb.settings
        ? computeIibb({
            settings: data.iibb.settings,
            sales: data.sales,
            systemSales: data.monthSales.pos + data.monthSales.account,
            taxCondition: data.company.taxCondition,
            defaultVatRate: data.company.defaultVatRate,
            perceptions: data.iibb.perceptions,
            bankWithholdings: data.iibb.bankWithholdings,
            credits: data.iibb.credits
          })
        : null,
    [data]
  );

  const loadAging = useCallback(async () => {
    setAgingLoading(true);
    try {
      const a = await getAging();
      setAging(a);
      return a;
    } catch (err) {
      setMessage(errorText(err, "No se pudo cargar quién debe."));
      return null;
    } finally {
      setAgingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "saldos" && isSupabaseConfigured) void loadAging();
  }, [tab, loadAging]);

  async function handleDelete(v: PurchaseVoucher) {
    if (!window.confirm(`¿Borrar ${voucherTypeLabel(v.voucherType)} ${voucherNumber(v.pointOfSale, v.number)} de ${v.sellerName}? La compra (si tiene) no se toca.`)) return;
    try {
      await deletePurchaseVoucher(v.id);
      setMessage("Factura borrada del libro.");
      await reload();
    } catch (err) {
      setMessage(errorText(err, "No se pudo borrar."));
    }
  }

  async function handleImportFile(file: File) {
    setImportResult(null);
    setImportRows(null);
    setMessage("");
    try {
      const table = await readStatementFile(file);
      const parsed = parseMisComprobantes(table);
      if (!parsed.headerFound) {
        setMessage("Ese archivo no parece el de Mis Comprobantes de ARCA: no encontré las columnas Tipo, Número, Nro. Doc. Emisor e Imp. Total.");
        return;
      }
      setImportFile(file.name);
      setImportRows(parsed.rows);
    } catch (err) {
      setMessage(errorText(err, "No se pudo leer el archivo."));
    }
  }

  async function handleImport() {
    if (!importRows) return;
    const vouchers = importRows.filter((r) => r.voucher).map((r) => r.voucher!);
    if (vouchers.length === 0) return;
    setImportBusy(true);
    try {
      const res = await importPurchaseVouchers(vouchers);
      setImportResult(res);
      setImportRows(null);
      await reload();
    } catch (err) {
      setMessage(errorText(err, "No se pudo importar."));
    } finally {
      setImportBusy(false);
    }
  }

  async function downloadPackage() {
    if (!data) return;
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const agingData = aging ?? (await loadAging());
      for (const sheet of buildAccountingSheets(data, { iibb: iibbResult, aging: agingData, dues: calendar.items })) {
        const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
        const widths = sheet.rows.reduce<number[]>((w, row) => {
          row.forEach((c, i) => (w[i] = Math.min(45, Math.max(w[i] ?? 8, String(c ?? "").length + 2))));
          return w;
        }, []);
        ws["!cols"] = widths.map((wch) => ({ wch }));
        XLSX.utils.book_append_sheet(wb, ws, sheet.name);
      }
      const fileName = (data.company.businessName || data.company.name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w]+/g, "_");
      XLSX.writeFile(wb, `Contable_${fileName}_${month}.xlsx`);
    } catch (err) {
      setMessage(errorText(err, "No se pudo armar el Excel."));
    }
  }

  /** Excel con los 12 meses del ejercicio (accounting_month de cada mes) para Ganancias y el balance. */
  async function downloadYear() {
    if (yearProgress) return;
    const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const months = fiscalYearMonths(yearEnd, today);
    if (months.length === 0) {
      setMessage("Ese ejercicio todavía no empezó.");
      return;
    }
    try {
      const loaded: AccountingMonth[] = [];
      for (const m of months) {
        setYearProgress(`Armando ${loaded.length + 1} de ${months.length}…`);
        loaded.push(await getAccountingMonth(m));
      }
      const snapshots = await listInventorySnapshots().catch(() => []);
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      for (const sheet of buildYearSheets({ endMonth: yearEnd, months: loaded, snapshots })) {
        const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
        const widths = sheet.rows.reduce<number[]>((w, row) => {
          row.forEach((c, i) => (w[i] = Math.min(40, Math.max(w[i] ?? 8, String(c ?? "").length + 2))));
          return w;
        }, []);
        ws["!cols"] = widths.map((wch) => ({ wch }));
        XLSX.utils.book_append_sheet(wb, ws, sheet.name);
      }
      const name = (loaded[0].company.businessName || loaded[0].company.name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w]+/g, "_");
      XLSX.writeFile(wb, `Resumen_ejercicio_${name}_${yearEnd}.xlsx`);
    } catch (err) {
      setMessage(errorText(err, "No se pudo armar el resumen del año."));
    } finally {
      setYearProgress(null);
    }
  }

  function downloadLibroIva() {
    if (!data) return;
    try {
      const names = lidFileNames(data.period);
      const sales = buildSalesFiles(data.sales);
      const purchases = buildPurchaseFiles(data.purchases);
      const zip = buildZip([
        { name: names.salesVouchers, data: latin1Bytes(sales.vouchers) },
        { name: names.salesRates, data: latin1Bytes(sales.rates) },
        { name: names.purchaseVouchers, data: latin1Bytes(purchases.vouchers) },
        { name: names.purchaseRates, data: latin1Bytes(purchases.rates) }
      ]);
      downloadBlob(`Libro_IVA_Digital_${month}.zip`, zip.buffer as ArrayBuffer, "application/zip");
    } catch (err) {
      setMessage(errorText(err, "No se pudieron armar los archivos."));
    }
  }

  const purchaseTotals = useMemo(() => {
    if (!data) return { net: 0, vat: 0, total: 0 };
    return data.purchases.reduce(
      (t, p) => ({
        net: t.net + signed(p, purchaseDiscriminatesVat(p.voucherType) ? p.netTaxed : 0),
        vat: t.vat + signed(p, purchaseDiscriminatesVat(p.voucherType) ? p.vatTotal : 0),
        total: t.total + signed(p, p.total)
      }),
      { net: 0, vat: 0, total: 0 }
    );
  }, [data]);

  const salesTotal = data ? data.sales.reduce((s, x) => s + signed(x, x.total), 0) : 0;
  const importable = importRows?.filter((r) => r.voucher).length ?? 0;
  const importErrors = importRows?.filter((r) => r.errors.length > 0) ?? [];
  const importWarnings = importRows?.filter((r) => r.warnings.length > 0) ?? [];

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">FINANZAS</p>
          <h1>Contable</h1>
          <p className="muted">Lo que te piden ARCA y el contador cada mes: libros de IVA, posición de IVA o monotributo, y la carpeta del mes.</p>
        </div>
        <label className="muted" style={{ display: "grid", gap: 4 }}>
          Mes
          <input type="month" value={month} max={currentMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </header>

      {!isSupabaseConfigured && <div className="message">Modo demostración: esta pantalla necesita la base conectada.</div>}
      {message && <div className="message">{message}</div>}
      {loading && !data && <p className="muted">Cargando…</p>}

      {data && (
        <>
          {!data.company.taxCondition && (
            <div className="message">Faltan los datos fiscales del negocio (CUIT y condición frente al IVA). Se cargan en Facturas → "Datos fiscales del negocio".</div>
          )}

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {TABS.map((t) => (
              <button key={t.key} className={tab === t.key ? "" : "secondary"} onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>

          {tab === "resumen" && (
          <>
          <section className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {ri && position ? (
              <>
                <Card
                  title={position.balance >= 0 ? "IVA a pagar (estimado)" : "Saldo a favor de IVA"}
                  value={formatMoney(Math.abs(position.balance))}
                  detail={`Ventas ${formatMoney(position.debit)} − compras ${formatMoney(position.credit)} − percepciones ${formatMoney(position.perceptions)}`}
                />
                <Card title="Facturado en el mes" value={formatMoney(salesTotal)} detail={`${data.sales.length} comprobantes autorizados por ARCA`} />
              </>
            ) : mono ? (
              <>
                <Card
                  title="Monotributo: facturado en 12 meses"
                  value={formatMoney(data.monotributo.invoiced12m)}
                  detail={
                    mono.level === "excede"
                      ? "Supera el tope de la categoría K: hablá con tu contador"
                      : `Categoría ${mono.category}: usaste el ${String(mono.usedPct).replace(".", ",")}% (faltan ${formatMoney(mono.remaining ?? 0)})`
                  }
                  warn={mono.level !== "ok"}
                />
                <Card
                  title="Ventas registradas en 12 meses"
                  value={formatMoney(data.monotributo.sales12m)}
                  detail="Todo lo cargado en Mostrador y a cuenta, con o sin factura"
                />
              </>
            ) : null}
            <Card
              title="Compras del mes"
              value={formatMoney(purchaseTotals.total)}
              detail={
                data.purchasesWithoutVoucher.length > 0
                  ? `${data.purchasesWithoutVoucher.length} compras sin factura cargada`
                  : `${data.purchases.length} facturas en el libro`
              }
              warn={data.purchasesWithoutVoucher.length > 0}
            />
            {iibbResult?.applies ? (
              <Card
                title={iibbResult.balance >= 0 ? "Ingresos Brutos a pagar (estimado)" : "Saldo a favor de Ingresos Brutos"}
                value={formatMoney(Math.abs(iibbResult.balance))}
                detail={`Impuesto ${formatMoney(iibbResult.tax)} − percepciones y retenciones ${formatMoney(iibbResult.tax - iibbResult.balance)}`}
              />
            ) : !data.iibb.settings ? (
              <Card title="Ingresos Brutos" value="Sin configurar" detail="Cargá tu alícuota en la pestaña Ingresos Brutos" warn />
            ) : null}
          </section>

          <TaxCalendarPanel
            dues={calendar.items}
            missingCuit={calendar.missingCuit}
            taxCondition={data.company.taxCondition}
            settings={data.iibb.settings}
            reminders={reminders}
            canWrite={canWrite}
            onChanged={(msg) => {
              setMessage(msg);
              void reload();
            }}
          />

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Para el contador</h2>
              <span>{monthLabel(month)}</span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => void downloadPackage()}>Bajar carpeta del mes (Excel)</button>
              {ri && <button className="secondary" onClick={downloadLibroIva}>Bajar Libro IVA Digital (archivos para ARCA)</button>}
            </div>
            <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 12 }}>
              <span>Resumen del año (cierre del ejercicio), que cierra en</span>
              <input type="month" value={yearEnd} onChange={(e) => e.target.value && setYearEnd(e.target.value)} />
              <button className="secondary" disabled={Boolean(yearProgress)} onClick={() => void downloadYear()}>
                {yearProgress ?? "Bajar resumen del año (Excel)"}
              </button>
            </div>
            <p className="setting-help">
              La carpeta trae en un Excel: resumen, IVA Ventas, IVA Compras, compras sin factura, gastos y sueldos, saldos de las cuentas a fin de mes, lo que te deben los clientes, lo que les debés a los proveedores, deudas, cheques y el stock a costo.
              {ri && " El Libro IVA Digital es un .zip con los 4 archivos que se importan en ARCA → Libro IVA Digital → Importar."}
              {" "}El resumen del año trae los 12 meses del ejercicio (ventas, facturado, compras, gastos por categoría, sueldos, {ri ? "IVA" : "monotributo"} e Ingresos Brutos por mes), el inventario al inicio y al cierre, y los saldos: es lo que pide el contador para Ganancias y el balance.
            </p>
            <p className="setting-help">Tu contador puede entrar a mirar: en Usuarios, creale un usuario con el rol "Contador". Solo ve esta pantalla y no puede cargar ni cambiar nada.</p>
            {ri && position && (position.salesByRate.length > 0 || position.purchasesByRate.length > 0) && (
              <table className="data-table" style={{ marginTop: 10, maxWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Alícuota</th>
                    <th className="num">Neto ventas</th>
                    <th className="num">IVA ventas</th>
                    <th className="num">Neto compras</th>
                    <th className="num">IVA compras</th>
                  </tr>
                </thead>
                <tbody>
                  {[...new Set([...position.salesByRate, ...position.purchasesByRate].map((r) => r.rate))].sort((a, b) => a - b).map((rate) => {
                    const s = position.salesByRate.find((r) => r.rate === rate);
                    const p = position.purchasesByRate.find((r) => r.rate === rate);
                    return (
                      <tr key={rate}>
                        <td>{pct(rate)}</td>
                        <td className="num">{formatMoney(s?.net ?? 0)}</td>
                        <td className="num">{formatMoney(s?.vat ?? 0)}</td>
                        <td className="num">{formatMoney(p?.net ?? 0)}</td>
                        <td className="num">{formatMoney(p?.vat ?? 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
          </>
          )}

          {tab === "libros" && (
          <>
          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Libro IVA Compras</h2>
              <span>{data.purchases.length} facturas · {formatMoney(purchaseTotals.total)}</span>
            </div>

            {canWrite && !form && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                <button onClick={() => setForm({})}>+ Cargar factura de compra</button>
                <button className="secondary" onClick={() => { setImportOpen((v) => !v); setImportResult(null); }}>
                  {importOpen ? "Cerrar importar" : "Importar de ARCA (Mis Comprobantes)"}
                </button>
              </div>
            )}

            {form && (
              <div style={{ marginBottom: 14 }}>
                <PurchaseVoucherForm
                  suppliers={voucherSuppliers}
                  existing={form.existing ?? null}
                  purchase={form.purchase ?? null}
                  branchId={branchId}
                  onCancel={() => setForm(null)}
                  onSaved={(msg) => {
                    setForm(null);
                    setMessage(msg);
                    void reload();
                  }}
                />
              </div>
            )}

            {importOpen && canWrite && (
              <div className="panel" style={{ padding: 14, marginBottom: 14, background: "#fafafa" }}>
                <p style={{ marginTop: 0 }}>
                  En arca.gob.ar con tu clave fiscal: <strong>Mis Comprobantes → Recibidos</strong> → elegí las fechas → <strong>Buscar</strong> → botón <strong>CSV</strong> o <strong>Excel</strong>. Subí ese archivo acá.
                  Las facturas que ya estaban se saltean; ninguna se carga dos veces.
                </p>
                <input type="file" accept=".csv,.xlsx,.xls,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportFile(f); e.target.value = ""; }} />
                {importRows && (
                  <div style={{ marginTop: 12 }}>
                    <p style={{ margin: "0 0 6px" }}>
                      <strong>{importFile}</strong>: {importable} facturas para importar
                      {importErrors.length > 0 && <span className="num-negative"> · {importErrors.length} filas con error (no se importan)</span>}
                    </p>
                    {[...importErrors, ...importWarnings].slice(0, 8).map((r) => (
                      <div key={r.row} className="muted" style={{ fontSize: 13 }}>
                        Fila {r.row}: {[...r.errors, ...r.warnings].join(" · ")}
                      </div>
                    ))}
                    <button style={{ marginTop: 8 }} disabled={importBusy || importable === 0} onClick={() => void handleImport()}>
                      {importBusy ? "Importando…" : `Importar ${importable} facturas`}
                    </button>
                  </div>
                )}
                {importResult && (
                  <div className="message" style={{ marginTop: 12, marginBottom: 0 }}>
                    Listo: {importResult.created} nuevas, {importResult.skipped} ya estaban.
                    {importResult.errors.length > 0 && ` ${importResult.errors.length} con error: ` + importResult.errors.slice(0, 5).map((e) => `fila ${e.row} (${e.error})`).join("; ")}
                  </div>
                )}
              </div>
            )}

            {data.purchasesWithoutVoucher.length > 0 && (
              <details className="setting-section" style={{ marginBottom: 12 }}>
                <summary>
                  <span className="setting-title">Compras de este mes sin factura cargada</span>
                  <span className="setting-status warn">{data.purchasesWithoutVoucher.length}</span>
                  <span className="setting-action">Ver</span>
                </summary>
                <div className="setting-body">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Proveedor</th>
                        <th>N.º en Compras</th>
                        <th className="num">Total</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.purchasesWithoutVoucher.map((p) => (
                        <tr key={p.id}>
                          <td>{p.date}</td>
                          <td>{p.supplier ?? "—"}</td>
                          <td>{p.invoiceNumber ?? "—"}</td>
                          <td className="num">{formatMoney(p.total)}</td>
                          <td>
                            {canWrite && (
                              <button className="secondary" onClick={() => setForm({ purchase: { purchaseId: p.id, date: p.date, supplierId: p.supplierId, invoiceNumber: p.invoiceNumber, total: p.total } })}>
                                Cargar factura
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="setting-help">Si una compra no tuvo factura (por ejemplo, un ticket o algo sin comprobante), no va al libro y se puede dejar así.</p>
                </div>
              </details>
            )}

            {data.purchases.length === 0 ? (
              <p className="muted">Todavía no hay facturas de compra de {monthLabel(month)}.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Comprobante</th>
                      <th>Proveedor</th>
                      <th className="num">Neto</th>
                      <th className="num">IVA</th>
                      <th className="num">Percepciones</th>
                      <th className="num">Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.purchases.map((p) => (
                      <tr key={p.id}>
                        <td>{p.voucherDate}</td>
                        <td>
                          {voucherTypeLabel(p.voucherType)}
                          <div className="muted" style={{ fontSize: 12 }}>{voucherNumber(p.pointOfSale, p.number)}</div>
                        </td>
                        <td>
                          {p.sellerName}
                          <div className="muted" style={{ fontSize: 12 }}>CUIT {p.sellerDoc}{p.source === "arca" ? " · de ARCA" : p.source === "compras" ? " · de Compras" : ""}</div>
                        </td>
                        <td className="num">{purchaseDiscriminatesVat(p.voucherType) ? formatMoney(signed(p, p.netTaxed)) : "—"}</td>
                        <td className="num">
                          {purchaseDiscriminatesVat(p.voucherType) ? formatMoney(signed(p, p.vatTotal)) : "—"}
                          {p.vatLines.length > 1 && <div className="muted" style={{ fontSize: 11 }}>{p.vatLines.map((l) => pct(l.rate)).join(" + ")}</div>}
                        </td>
                        <td className="num">{p.percVat + p.percIibb > 0 ? formatMoney(signed(p, p.percVat + p.percIibb)) : "—"}</td>
                        <td className="num">{formatMoney(signed(p, p.total))}</td>
                        <td>
                          <VoucherAttachment
                            companyId={profile?.company_id ?? null}
                            voucher={p}
                            canWrite={canWrite}
                            onChanged={(msg) => {
                              setMessage(msg);
                              void reload();
                            }}
                          />{" "}
                          {canWrite && (
                            <>
                              <button className="secondary" onClick={() => setForm({ existing: p })}>Editar</button>{" "}
                              <button className="link-button" onClick={() => void handleDelete(p)}>Borrar</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}><strong>Total</strong></td>
                      <td className="num"><strong>{formatMoney(purchaseTotals.net)}</strong></td>
                      <td className="num"><strong>{formatMoney(purchaseTotals.vat)}</strong></td>
                      <td></td>
                      <td className="num"><strong>{formatMoney(purchaseTotals.total)}</strong></td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <details>
              <summary style={{ cursor: "pointer" }}>
                <strong style={{ fontSize: 18 }}>Libro IVA Ventas</strong>{" "}
                <span className="muted">{data.sales.length} comprobantes · {formatMoney(salesTotal)}</span>
              </summary>
              {data.sales.length === 0 ? (
                <p className="muted">No hay facturas autorizadas por ARCA en {monthLabel(month)}.</p>
              ) : (
                <div style={{ overflowX: "auto", marginTop: 10 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Comprobante</th>
                        <th>Cliente</th>
                        <th className="num">Neto</th>
                        <th className="num">IVA</th>
                        <th className="num">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sales.map((s) => {
                        const lines = saleVatLines(s);
                        return (
                          <tr key={s.id}>
                            <td>{s.date}</td>
                            <td>
                              {voucherTypeLabel(s.voucherType)}
                              <div className="muted" style={{ fontSize: 12 }}>{voucherNumber(s.pointOfSale, s.number)}</div>
                            </td>
                            <td>{s.docType === 99 ? "Consumidor final" : `${s.name ?? ""} (${s.doc})`}</td>
                            <td className="num">{lines.length ? formatMoney(signed(s, lines.reduce((a, l) => a + l.net, 0))) : "—"}</td>
                            <td className="num">
                              {lines.length ? formatMoney(signed(s, lines.reduce((a, l) => a + l.vat, 0))) : "—"}
                              {lines.length > 1 && <div className="muted" style={{ fontSize: 11 }}>{lines.map((l) => pct(l.rate)).join(" + ")}</div>}
                            </td>
                            <td className="num">{formatMoney(signed(s, s.total))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          </section>
          </>
          )}

          {tab === "iibb" && (
            <IibbPanel
              data={data}
              result={iibbResult}
              canWrite={canWrite}
              onChanged={(msg) => {
                setMessage(msg);
                void reload();
              }}
            />
          )}

          {tab === "saldos" && <AgingPanel aging={aging} loading={agingLoading} />}

          {tab === "inventario" && <InventoryClosePanel canTake={profile ? ["owner", "admin"].includes(profile.role) : true} />}
        </>
      )}
    </>
  );
}

function Card({ title, value, detail, warn = false }: { title: string; value: string; detail: string; warn?: boolean }) {
  return (
    <div className="panel" style={{ padding: "14px 16px" }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{title}</p>
      <strong style={{ fontSize: 24 }}>{value}</strong>
      <p className={warn ? "num-negative" : "muted"} style={{ margin: "4px 0 0", fontSize: 13 }}>{detail}</p>
    </div>
  );
}

export default Accounting;
