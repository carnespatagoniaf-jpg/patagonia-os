import { useMemo, useState } from "react";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import { savePurchaseVoucher } from "./accounting-service";
import {
  PURCHASE_VOUCHER_TYPES,
  isCreditNote,
  parseVoucherNumber,
  purchaseDiscriminatesVat,
  voucherTypeLabel,
  type PurchaseVoucher,
  type VatLine
} from "./accounting-view";

export interface VoucherSupplier {
  id: string;
  name: string;
  taxId: string | null;
  taxCondition: string | null;
}

/** Datos de la compra que ya se cargó (Compras), para no volver a escribirlos. */
export interface VoucherPurchaseHint {
  purchaseId: string;
  date: string;
  supplierId: string | null;
  invoiceNumber: string | null;
  total: number;
}

const RATE_FIELDS = [21, 10.5, 27, 5, 2.5, 0] as const;
const MAIN_RATES = new Set([21, 10.5]);

type Money = string;

interface Draft {
  voucherType: number;
  voucherDate: string;
  pointOfSale: string;
  number: string;
  supplierId: string;
  sellerDoc: string;
  sellerName: string;
  net: Record<number, Money>;
  vat: Record<number, Money>;
  vatManual: Record<number, boolean>;
  noTaxed: Money;
  exempt: Money;
  percVat: Money;
  percIibb: Money;
  internalTaxes: Money;
  otherTaxes: Money;
  total: Money;
  otherPeriod: boolean;
  period: string;
  cae: string;
}

const toMoney = (n: number | null | undefined) => (n ? String(n).replace(".", ",") : "");
const money = (s: string) => {
  const n = parseAmount(s || "0");
  return Number.isFinite(n) ? n : NaN;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Tipo que corresponde según la condición del proveedor (A si es inscripto, C si es monotributista). */
function defaultType(supplier: VoucherSupplier | undefined): number {
  if (supplier?.taxCondition === "monotributo") return 11;
  if (supplier?.taxCondition === "exento") return 6;
  return 1;
}

function draftFrom(existing: PurchaseVoucher | null, hint: VoucherPurchaseHint | null, suppliers: VoucherSupplier[]): Draft {
  const net: Record<number, Money> = {};
  const vat: Record<number, Money> = {};
  const vatManual: Record<number, boolean> = {};
  for (const l of existing?.vatLines ?? []) {
    net[l.rate] = toMoney(l.net);
    vat[l.rate] = toMoney(l.vat);
    vatManual[l.rate] = true;
  }
  const supplier = suppliers.find((s) => s.id === (existing?.supplierId ?? hint?.supplierId));
  const parsed = parseVoucherNumber(hint?.invoiceNumber);
  const date = existing?.voucherDate ?? hint?.date ?? new Date().toISOString().slice(0, 10);
  return {
    voucherType: existing?.voucherType ?? defaultType(supplier),
    voucherDate: date,
    pointOfSale: existing ? String(existing.pointOfSale) : parsed ? String(parsed.pointOfSale || "") : "",
    number: existing ? String(existing.number) : parsed ? String(parsed.number) : "",
    supplierId: supplier?.id ?? "",
    sellerDoc: existing?.sellerDoc ?? supplier?.taxId ?? "",
    sellerName: existing?.sellerName ?? supplier?.name ?? "",
    net,
    vat,
    vatManual,
    noTaxed: toMoney(existing?.noTaxed),
    exempt: toMoney(existing?.exempt),
    percVat: toMoney(existing?.percVat),
    percIibb: toMoney(existing?.percIibb),
    internalTaxes: toMoney(existing?.internalTaxes),
    otherTaxes: toMoney(existing?.otherTaxes),
    total: toMoney(existing?.total ?? hint?.total),
    otherPeriod: Boolean(existing && existing.period.slice(0, 7) !== existing.voucherDate.slice(0, 7)),
    period: (existing?.period ?? date).slice(0, 7),
    cae: existing?.cae ?? ""
  };
}

/**
 * Factura del proveedor con sus datos fiscales (Libro IVA Compras). Se usa en
 * Contable (cargar a mano / corregir) y en Compras (la factura de esa compra).
 */
export function PurchaseVoucherForm({
  suppliers,
  existing = null,
  purchase = null,
  branchId = null,
  onSaved,
  onCancel
}: {
  suppliers: VoucherSupplier[];
  existing?: PurchaseVoucher | null;
  purchase?: VoucherPurchaseHint | null;
  branchId?: string | null;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(() => draftFrom(existing, purchase, suppliers));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showOtherRates, setShowOtherRates] = useState(() => RATE_FIELDS.some((r) => !MAIN_RATES.has(r) && d.net[r]));
  const discriminates = purchaseDiscriminatesVat(d.voucherType);

  const vatLines: VatLine[] = useMemo(
    () =>
      discriminates
        ? RATE_FIELDS.map((rate) => ({ rate, net: money(d.net[rate] ?? ""), vat: money(d.vat[rate] ?? "") })).filter((l) => l.net !== 0 || l.vat !== 0)
        : [],
    [d.net, d.vat, discriminates]
  );

  const computedTotal = discriminates
    ? round2(
        vatLines.reduce((s, l) => s + l.net + l.vat, 0) +
          [d.noTaxed, d.exempt, d.percVat, d.percIibb, d.internalTaxes, d.otherTaxes].reduce((s, v) => s + (money(v) || 0), 0)
      )
    : money(d.total);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setD((cur) => ({ ...cur, [key]: value }));
  }

  function setNet(rate: number, value: string) {
    setD((cur) => {
      const next = { ...cur, net: { ...cur.net, [rate]: value } };
      // El IVA se calcula solo mientras no lo hayan escrito a mano.
      if (!cur.vatManual[rate]) {
        const n = money(value);
        next.vat = { ...cur.vat, [rate]: Number.isFinite(n) && n !== 0 ? toMoney(round2((n * rate) / 100)) : "" };
      }
      return next;
    });
  }

  function setVat(rate: number, value: string) {
    setD((cur) => ({ ...cur, vat: { ...cur.vat, [rate]: value }, vatManual: { ...cur.vatManual, [rate]: value.trim() !== "" } }));
  }

  function pickSupplier(id: string) {
    const s = suppliers.find((x) => x.id === id);
    setD((cur) => ({
      ...cur,
      supplierId: id,
      sellerDoc: s?.taxId ?? cur.sellerDoc,
      sellerName: s?.name ?? cur.sellerName,
      voucherType: existing ? cur.voucherType : defaultType(s)
    }));
  }

  async function save() {
    setError("");
    const pos = Number(d.pointOfSale.replace(/\D/g, "") || "0");
    const number = Number(d.number.replace(/\D/g, "") || "0");
    if (!number) return setError("Poné el número de la factura.");
    if (d.sellerDoc.replace(/\D/g, "").length !== 11) return setError("Poné el CUIT del proveedor (11 números, está en la factura).");
    if (!d.sellerName.trim()) return setError("Poné el nombre del proveedor.");
    const parts = [d.noTaxed, d.exempt, d.percVat, d.percIibb, d.internalTaxes, d.otherTaxes].map(money);
    if (parts.some((n) => !Number.isFinite(n)) || vatLines.some((l) => !Number.isFinite(l.net) || !Number.isFinite(l.vat))) {
      return setError("Hay un importe que no es un número.");
    }
    const total = discriminates ? computedTotal : money(d.total);
    if (!Number.isFinite(total) || total <= 0) return setError("Poné el total de la factura.");
    if (discriminates && vatLines.length === 0 && !money(d.noTaxed) && !money(d.exempt)) {
      return setError("En una factura A poné el neto gravado (sin IVA) de cada alícuota.");
    }
    setBusy(true);
    try {
      await savePurchaseVoucher({
        id: existing?.id,
        purchaseId: existing?.purchaseId ?? purchase?.purchaseId ?? null,
        supplierId: d.supplierId || null,
        branchId,
        period: d.otherPeriod && d.period ? `${d.period}-01` : null,
        voucherDate: d.voucherDate,
        voucherType: d.voucherType,
        pointOfSale: pos,
        number,
        sellerDoc: d.sellerDoc.replace(/\D/g, ""),
        sellerName: d.sellerName.trim(),
        vatLines,
        noTaxed: discriminates ? parts[0] : 0,
        exempt: discriminates ? parts[1] : 0,
        percVat: parts[2],
        percIibb: parts[3],
        percNational: 0,
        percMunicipal: 0,
        internalTaxes: parts[4],
        otherTaxes: parts[5],
        total,
        cae: d.cae.trim() || null
      });
      onSaved(`${voucherTypeLabel(d.voucherType)} ${pos}-${number} de ${d.sellerName.trim()} guardada.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  const moneyInput = (value: string, onChange: (v: string) => void, placeholder?: string) => (
    <input type="text" inputMode="decimal" className="num" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ width: "100%" }} />
  );

  const visibleRates = RATE_FIELDS.filter((r) => MAIN_RATES.has(r) || showOtherRates);

  return (
    <div className="panel" style={{ padding: 14, display: "grid", gap: 12, background: "#fafafa" }}>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <label className="muted">
          Tipo
          <select value={d.voucherType} onChange={(e) => set("voucherType", Number(e.target.value))} style={{ width: "100%" }}>
            {PURCHASE_VOUCHER_TYPES.map((t) => (
              <option key={t} value={t}>{voucherTypeLabel(t)}</option>
            ))}
            {!PURCHASE_VOUCHER_TYPES.includes(d.voucherType as never) && <option value={d.voucherType}>{voucherTypeLabel(d.voucherType)}</option>}
          </select>
        </label>
        <label className="muted">
          Fecha de la factura
          <input type="date" value={d.voucherDate} onChange={(e) => set("voucherDate", e.target.value)} style={{ width: "100%" }} />
        </label>
        <label className="muted">
          Punto de venta
          <input inputMode="numeric" value={d.pointOfSale} onChange={(e) => set("pointOfSale", e.target.value)} placeholder="0003" style={{ width: "100%" }} />
        </label>
        <label className="muted">
          Número
          <input inputMode="numeric" value={d.number} onChange={(e) => set("number", e.target.value)} placeholder="00001234" style={{ width: "100%" }} />
        </label>
      </div>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <label className="muted">
          Proveedor
          <select value={d.supplierId} onChange={(e) => pickSupplier(e.target.value)} style={{ width: "100%" }}>
            <option value="">— Otro (no está en Compras) —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="muted">
          CUIT del proveedor
          <input inputMode="numeric" value={d.sellerDoc} onChange={(e) => set("sellerDoc", e.target.value)} placeholder="30-12345678-9" style={{ width: "100%" }} />
        </label>
        <label className="muted">
          Nombre o razón social
          <input value={d.sellerName} onChange={(e) => set("sellerName", e.target.value)} style={{ width: "100%" }} />
        </label>
      </div>

      {discriminates ? (
        <>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {visibleRates.map((rate) => (
              <div key={rate} style={{ display: "contents" }}>
                <label className="muted">
                  Neto gravado {String(rate).replace(".", ",")}%
                  {moneyInput(d.net[rate] ?? "", (v) => setNet(rate, v), "sin IVA")}
                </label>
                <label className="muted">
                  IVA {String(rate).replace(".", ",")}%
                  {moneyInput(d.vat[rate] ?? "", (v) => setVat(rate, v))}
                </label>
              </div>
            ))}
          </div>
          {!showOtherRates && (
            <button type="button" className="link-button" style={{ justifySelf: "start" }} onClick={() => setShowOtherRates(true)}>
              + Otras alícuotas (27%, 5%, 2,5%, 0%)
            </button>
          )}
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <label className="muted">No gravado{moneyInput(d.noTaxed, (v) => set("noTaxed", v))}</label>
            <label className="muted">Exento{moneyInput(d.exempt, (v) => set("exempt", v))}</label>
            <label className="muted">Percepción de IVA{moneyInput(d.percVat, (v) => set("percVat", v))}</label>
            <label className="muted">Percepción de Ingresos Brutos{moneyInput(d.percIibb, (v) => set("percIibb", v))}</label>
            <label className="muted">Impuestos internos{moneyInput(d.internalTaxes, (v) => set("internalTaxes", v))}</label>
            <label className="muted">Otros impuestos{moneyInput(d.otherTaxes, (v) => set("otherTaxes", v))}</label>
          </div>
          <div style={{ fontSize: 15 }}>
            Total de la factura: <strong>{Number.isFinite(computedTotal) ? formatMoney(computedTotal) : "—"}</strong>
            {purchase && Number.isFinite(computedTotal) && Math.abs(computedTotal - purchase.total) > 1 && (
              <span className="num-negative" style={{ marginLeft: 8, fontSize: 13 }}>
                No coincide con la compra ({formatMoney(purchase.total)}): revisá los importes.
              </span>
            )}
          </div>
        </>
      ) : (
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <label className="muted">
            Total de la factura
            {moneyInput(d.total, (v) => set("total", v))}
          </label>
          <label className="muted">Percepción de IVA{moneyInput(d.percVat, (v) => set("percVat", v))}</label>
          <label className="muted">Percepción de Ingresos Brutos{moneyInput(d.percIibb, (v) => set("percIibb", v))}</label>
          <p className="muted" style={{ margin: 0, fontSize: 12, alignSelf: "end" }}>
            {d.voucherType === 11 || d.voucherType === 13 ? "Factura C (monotributista): no tiene IVA para descontar." : "Factura B: el IVA no se descuenta."}
          </p>
        </div>
      )}

      {isCreditNote(d.voucherType) && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nota de crédito: se resta en el Libro IVA Compras.</p>}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={d.otherPeriod} onChange={(e) => set("otherPeriod", e.target.checked)} />
          Va en el libro de otro mes
        </label>
        {d.otherPeriod && <input type="month" value={d.period} onChange={(e) => set("period", e.target.value)} />}
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          CAE (opcional)
          <input inputMode="numeric" value={d.cae} onChange={(e) => set("cae", e.target.value)} style={{ width: 160 }} />
        </label>
      </div>

      {error && <div className="message" style={{ margin: 0 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : existing ? "Guardar cambios" : "Guardar factura"}</button>
        <button className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}
