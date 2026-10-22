import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { useCustomers } from "./useCustomers";
import { useTreasury } from "../shifts/useTreasury";
import { todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { listProductsForBranch } from "../inventory/inventory-service";
import { deleteCustomer, type CustomerChargeItem } from "./customers-service";
import { countByStatus, customerStatus, filterAndSortCustomers, type CustomerFilter, type CustomerStatus } from "./customer-list";
import { QuantityInput } from "../../components/QuantityInput";
import { parseQuantity } from "../sale/quantity";
import { useAuth } from "../auth/AuthProvider";
import { listChargeItemsForCharges, type ChargeItemDetail } from "./customers-service";
import { isSupabaseConfigured } from "../../lib/supabase";
import { getCompanyName } from "../products/products-service";
import { downloadCustomerStatementPdf } from "./customer-statement-pdf";
import {
  authorizeInvoices,
  getCustomerTaxData,
  getFiscalSettings,
  invoicePrintFrom,
  listChargeInvoices,
  requestChargeInvoice,
  type FiscalSettings,
  type Invoice
} from "../invoicing/invoicing-service";
import { emptyInvoiceDraft, invoiceDraftError, invoiceLabel, type InvoiceDraft, type InvoicePrint } from "../invoicing/invoicing-view";
import { InvoiceRequestFields } from "../invoicing/InvoiceRequestFields";
import { InvoicePaperFooter, InvoicePaperHeader } from "../invoicing/InvoicePaper";
import { RemitoRButton, useRemitoREnabled } from "../invoicing/RemitoRButton";
import { planAllows } from "../auth/permissions";

const STATUS_BADGE: Record<CustomerStatus, { label: string; bg: string; color: string }> = {
  overdue: { label: "Atrasado", bg: "#fdecea", color: "#b3261e" },
  owes: { label: "Debe", bg: "#fff4e0", color: "#8a5300" },
  clear: { label: "Al día", bg: "#e6f4ea", color: "#2e7d32" }
};

function formatShortDate(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

const UNIT_LABELS: Record<Product["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

interface ChargeCartLine {
  key: string;
  productId?: string;
  name: string;
  unit: Product["unit"];
  quantity: number;
  unitPrice: number;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

interface LedgerRow {
  key: string;
  type: "charge" | "payment";
  id: string;
  date: string;
  detail: string;
  debit: number;
  credit: number;
  balance: number;
  /** Cantidad y precio de cada renglón (+ descuento o recargo): solo con 'ventas_detalle'. */
  lines?: string[];
}

const DETAIL_UNIT: Record<string, string> = { kg: "kg", unit: "u.", box: "caja" };

function formatQty(value: number) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(value);
}

/** Lo que se cobró de más o de menos sobre la suma de los renglones (descuento o recargo, migración 145). */
function chargeAdjustmentOf(amount: number, items: { lineTotal: number }[]) {
  if (items.length === 0) return 0;
  const diff = Math.round(amount - Math.round(items.reduce((sum, i) => sum + i.lineTotal, 0)));
  return Math.abs(diff) >= 1 ? diff : 0;
}

function adjustmentLabel(value: number) {
  return `${value < 0 ? "Descuento" : "Recargo"}: ${value < 0 ? "-" : "+"}${formatMoney(Math.abs(value))}`;
}

export function Customers() {
  const {
    branchId,
    customers,
    loading,
    error,
    reload,
    create,
    update,
    charges,
    payments,
    balance,
    detailLoading,
    loadDetail,
    addCharge,
    addChargeWithItems,
    loadChargeItems,
    registerPayment,
    editCharge,
    removeCharge,
    editPayment,
    removePayment
  } = useCustomers();
  const { accounts } = useTreasury();

  const [products, setProducts] = useState<Product[]>([]);
  const [chargeSearch, setChargeSearch] = useState("");
  const [chargeCart, setChargeCart] = useState<ChargeCartLine[]>([]);
  const [chargeNote, setChargeNote] = useState("");
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDesc, setManualDesc] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [manualUnit, setManualUnit] = useState<Product["unit"]>("unit");
  const [printCharge, setPrintCharge] = useState<{ date: string; reason: string; amount: number; items: CustomerChargeItem[]; invoice?: InvoicePrint; adjustment?: number } | null>(null);
  // Descuento o recargo en la venta + cantidad y precio en el detalle (migración 145, solo 'ventas_detalle': Martínez).
  const [chargeAdjKind, setChargeAdjKind] = useState<"descuento" | "recargo">("descuento");
  const [chargeAdjAmount, setChargeAdjAmount] = useState("");
  const [ledgerItems, setLedgerItems] = useState<Record<string, ChargeItemDetail[]>>({});
  // Factura ARCA (migración 136): casi todo sale con remito; si el cliente la pide, también factura.
  const [fiscal, setFiscal] = useState<FiscalSettings | null>(null);
  const [chargeInvoices, setChargeInvoices] = useState<Invoice[]>([]);
  const [newInvoiceDraft, setNewInvoiceDraft] = useState<InvoiceDraft>(emptyInvoiceDraft());
  const [invoicingCharge, setInvoicingCharge] = useState<{ chargeId: string; draft: InvoiceDraft } | null>(null);
  const [remitoBusyId, setRemitoBusyId] = useState<string | null>(null);
  // Saldo anterior: lo que un cliente ya debía antes de empezar a usar el sistema (no toca stock ni caja).
  const [openingBalance, setOpeningBalance] = useState("");
  const [showOpening, setShowOpening] = useState(false);
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingDate, setOpeningDate] = useState(todayIso());
  const printSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!branchId) return;
    void listProductsForBranch(branchId).then(setProducts);
  }, [branchId]);

  useEffect(() => {
    if (printCharge) printSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [printCharge]);

  useEffect(() => {
    void getFiscalSettings().then(setFiscal).catch(() => setFiscal(null));
  }, []);

  useEffect(() => {
    const ids = charges.map((c) => c.id);
    if (ids.length === 0) {
      setChargeInvoices([]);
      return;
    }
    void listChargeInvoices(ids).then(setChargeInvoices).catch(() => setChargeInvoices([]));
  }, [charges]);

  const chargeMatches = chargeSearch.trim()
    ? products.filter((p) => (p.active ?? true) && p.name.toLowerCase().includes(chargeSearch.toLowerCase())).slice(0, 8)
    : [];

  function addProductToCharge(product: Product) {
    setChargeCart((current) => {
      // Por kilo, cada vez es un renglón nuevo con su propio peso (ej. dos
      // medias reses de 106 y 98 kg en la misma venta, real Martinez 19/10):
      // sumarle 1 kg al renglón que ya estaba hacía imposible cargar la segunda.
      const existing = product.unit === "kg" ? undefined : current.find((l) => l.productId === product.id);
      if (existing) {
        return current.map((l) => (l.key === existing.key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      const key = current.some((l) => l.key === product.id) ? `${product.id}-${Date.now()}` : product.id;
      return [...current, { key, productId: product.id, name: product.name, unit: product.unit, quantity: 1, unitPrice: product.priceRetail }];
    });
    setChargeSearch("");
  }

  function addManualItem() {
    setMessage("");
    const desc = manualDesc.trim();
    const price = parseAmount(manualPrice || "0") || 0;
    if (manualUnit === "kg" && !manualQty.trim()) {
      setMessage("Ingresá los kilos.");
      return;
    }
    const qty = manualQty.trim() ? parseQuantity(manualQty) : 1;
    if (!desc) { setMessage("Ingresá una descripción para el artículo."); return; }
    if (!(price >= 0)) { setMessage("Precio inválido."); return; }
    if (!(qty > 0)) { setMessage("Cantidad inválida."); return; }
    const key = `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setChargeCart((current) => [...current, { key, name: desc, unit: manualUnit, quantity: qty, unitPrice: price }]);
    setManualDesc("");
    setManualPrice("");
    setManualQty("1");
    setManualUnit("unit");
    setShowManualForm(false);
  }

  function updateChargeItemQty(key: string, raw: string) {
    const parsed = Number(raw);
    setChargeCart((current) => current.map((l) => (l.key === key ? { ...l, quantity: l.unit === "kg" ? parsed : Math.round(parsed) } : l)));
  }

  function removeChargeItem(key: string) {
    setChargeCart((current) => current.filter((l) => l.key !== key));
  }

  const chargeTotal = chargeCart.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

  const [message, setMessage] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const { profile } = useAuth();
  // Remito R con CAI (migración 147): plan Full y un CAI cargado en Facturas.
  const remitoR = useRemitoREnabled(planAllows(profile, "full"));
  const salesDetail = Boolean(profile?.features?.includes("ventas_detalle"));
  const chargeAdjustment = salesDetail ? Math.round((chargeAdjKind === "descuento" ? -1 : 1) * (parseAmount(chargeAdjAmount || "0") || 0)) : 0;
  const finalChargeTotal = Math.round(chargeTotal) + chargeAdjustment;
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [locality, setLocality] = useState("");
  const [province, setProvince] = useState("");

  const [editingCustomer, setEditingCustomer] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editNotesField, setEditNotesField] = useState("");
  const [editLocality, setEditLocality] = useState("");
  const [editProvince, setEditProvince] = useState("");
  const [editTermDays, setEditTermDays] = useState("");
  const [editActive, setEditActive] = useState(true);

  const [chargeDate, setChargeDate] = useState(todayIso());

  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");

  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editReason, setEditReason] = useState("");
  const [editAccountId, setEditAccountId] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const selectedCustomer = customers.find((c) => c.id === selectedId) ?? null;

  // Datos fiscales del cliente (los de su última factura) para no volver a escribirlos.
  useEffect(() => {
    setInvoicingCharge(null);
    if (!selectedId) return;
    const name = customers.find((c) => c.id === selectedId)?.name ?? "";
    setNewInvoiceDraft({ ...emptyInvoiceDraft(), name });
    void getCustomerTaxData(selectedId).then((d) =>
      setNewInvoiceDraft((cur) => ({ ...cur, doc: d.taxId, customerCondition: d.taxCondition ?? cur.customerCondition }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const [search, setSearch] = useState("");
  const [listFilter, setListFilter] = useState<CustomerFilter>("all");
  const today = todayIso();
  const visibleCustomers = useMemo(() => filterAndSortCustomers(customers, search, listFilter, today), [customers, search, listFilter, today]);
  const statusCounts = useMemo(() => countByStatus(customers, today), [customers, today]);
  // Suma de lo que deben todos (pedido de Martínez, 2026-10-21): solo saldos a cobrar, no los "a favor".
  const totalOwed = useMemo(() => customers.reduce((sum, c) => (c.balance >= 1 ? sum + c.balance : sum), 0), [customers]);

  useEffect(() => {
    if (selectedCustomer) {
      setEditName(selectedCustomer.name);
      setEditPhone(selectedCustomer.phone ?? "");
      setEditNotesField(selectedCustomer.notes ?? "");
      setEditLocality(selectedCustomer.locality ?? "");
      setEditProvince(selectedCustomer.province ?? "");
      setEditTermDays(selectedCustomer.paymentTermDays ? String(selectedCustomer.paymentTermDays) : "");
      setEditActive(selectedCustomer.active);
      setEditingCustomer(false);
    }
  }, [selectedCustomer]);

  function selectCustomer(id: string) {
    setSelectedId(id);
    void loadDetail(id);
  }

  /** Sin ventas ni pagos se borra; con historia queda dado de baja (sale de la lista, se guarda todo). */
  async function handleDeleteCustomer() {
    if (busy || !selectedCustomer) return;
    const debt = balance && Math.abs(balance.balance) >= 1 ? ` Ojo: tiene saldo de ${formatMoney(balance.balance)}.` : "";
    if (!window.confirm(`¿Eliminar a ${selectedCustomer.name}?${debt} Si ya tuvo ventas o pagos, no se borra: queda dado de baja y se guarda su historia.`)) return;
    setBusy(true);
    try {
      const name = selectedCustomer.name;
      const result = isSupabaseConfigured ? await deleteCustomer(selectedCustomer.id) : "deleted";
      setEditingCustomer(false);
      setSelectedId(null);
      await reload();
      setMessage(result === "deleted" ? `${name} eliminado.` : `${name} tenía ventas o pagos: quedó dado de baja (ya no aparece en la lista) y su historia se guarda.`);
    } catch (err) {
      const raw = err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "";
      setMessage(raw || "No se pudo eliminar el cliente.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateCustomer() {
    if (busy || !selectedCustomer) return;
    setBusy(true);
    try {
      if (!editName.trim()) throw new Error("El nombre es obligatorio.");
      const termDays = editTermDays.trim() ? Number(editTermDays) : undefined;
      if (termDays !== undefined && (!Number.isFinite(termDays) || termDays <= 0)) throw new Error("El plazo tiene que ser un número mayor que cero.");
      await update({
        id: selectedCustomer.id,
        name: editName.trim(),
        phone: editPhone.trim() || undefined,
        notes: editNotesField.trim() || undefined,
        locality: editLocality.trim() || undefined,
        province: editProvince.trim() || undefined,
        paymentTermDays: termDays,
        active: editActive
      });
      setEditingCustomer(false);
      if (!editActive) setSelectedId(null);
      setMessage(editActive ? "Cliente actualizado." : "Cliente eliminado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo actualizar el cliente.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!salesDetail || charges.length === 0) {
      setLedgerItems({});
      return;
    }
    void listChargeItemsForCharges(charges.map((c) => c.id))
      .then((list) => {
        const grouped: Record<string, ChargeItemDetail[]> = {};
        for (const item of list) (grouped[item.chargeId] ??= []).push(item);
        setLedgerItems(grouped);
      })
      .catch(() => setLedgerItems({}));
  }, [charges, salesDetail]);

  const ledger = useMemo<LedgerRow[]>(() => {
    const rows: Omit<LedgerRow, "balance">[] = [
      ...charges.map((c) => {
        const items = salesDetail ? ledgerItems[c.id] ?? [] : [];
        const adjustment = chargeAdjustmentOf(c.amount, items);
        const lines = items.map((i) => `${i.name}: ${formatQty(i.quantity)}${i.unit ? ` ${DETAIL_UNIT[i.unit] ?? i.unit}` : ""} × ${formatMoney(i.unitPrice)} = ${formatMoney(i.lineTotal)}`);
        if (adjustment !== 0) lines.push(adjustmentLabel(adjustment));
        return {
          key: `charge-${c.id}`,
          type: "charge" as const,
          id: c.id,
          date: c.chargeDate,
          detail: `Venta · ${c.reason}`,
          debit: c.amount,
          credit: 0,
          lines: lines.length > 0 ? lines : undefined
        };
      }),
      ...payments.map((p) => ({
        key: `payment-${p.id}`,
        type: "payment" as const,
        id: p.id,
        date: p.paymentDate,
        detail: `Pago · ${p.accountName ?? "-"}${p.notes ? ` · ${p.notes}` : ""}`,
        debit: 0,
        credit: p.amount
      }))
    ].sort((a, b) => a.date.localeCompare(b.date));

    let running = 0;
    return rows.map((row) => {
      running += row.debit - row.credit;
      return { ...row, balance: running };
    });
  }, [charges, payments, ledgerItems, salesDetail]);

  async function handleCreateCustomer() {
    if (busy) return;
    setBusy(true);
    try {
      if (!name.trim()) throw new Error("El nombre es obligatorio.");
      const result = await create({
        name: name.trim(),
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        locality: locality.trim() || undefined,
        province: province.trim() || undefined
      });
      const opening = parseAmount(openingBalance || "0") || 0;
      if (opening > 0) {
        await addCharge({ customerId: result.id, chargeDate: todayIso(), amount: opening, reason: "Saldo anterior" });
        await reload();
      }
      setName("");
      setPhone("");
      setNotes("");
      setLocality("");
      setProvince("");
      setOpeningBalance("");
      selectCustomer(result.id);
      const created = result.number !== undefined ? `Cliente creado: es el N.º ${result.number}.` : "Cliente creado.";
      setMessage(opening > 0 ? `${created} Arranca debiendo ${formatMoney(opening)} (saldo anterior).` : created);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el cliente.");
    } finally {
      setBusy(false);
    }
  }

  /** La factura viva (pendiente o autorizada) de una venta en cuenta corriente. */
  function invoiceForCharge(chargeId: string): Invoice | undefined {
    return chargeInvoices.find((i) => i.customerChargeId === chargeId && i.kind === "factura" && i.status !== "rechazada");
  }

  /** Pide la factura de una venta ya registrada y, si ARCA la autoriza, la deja lista para imprimir. */
  async function invoiceCharge(chargeId: string, draft: InvoiceDraft, sale: { date: string; reason: string; amount: number; items: CustomerChargeItem[] }): Promise<string> {
    const { invoiceId, letter } = await requestChargeInvoice(chargeId, draft);
    const outcome = (await authorizeInvoices(invoiceId)).find((r) => r.id === invoiceId);
    const list = await listChargeInvoices(charges.map((c) => c.id).concat(chargeId));
    setChargeInvoices(list);
    const inv = list.find((i) => i.id === invoiceId);
    if (outcome?.status === "autorizada" && inv && fiscal) {
      const print = invoicePrintFrom(inv, fiscal);
      if (print) setPrintCharge({ ...sale, invoice: print });
      return `Factura ${letter} autorizada por ARCA (CAE ${outcome.cae}). El remito sigue en el botón Remito.`;
    }
    if (outcome?.status === "rechazada") return `ARCA rechazó la factura: ${outcome.message ?? "sin motivo"}`;
    return `Factura ${letter} pedida, pero ARCA todavía no respondió. Se reintenta desde Facturas.`;
  }

  async function handleInvoiceExisting(row: LedgerRow) {
    if (!invoicingCharge || !fiscal) return;
    const error = invoiceDraftError(fiscal.taxCondition, invoicingCharge.draft, row.debit);
    if (error) {
      setMessage(error);
      return;
    }
    setBusy(true);
    try {
      const items = await loadChargeItems(row.id);
      const text = await invoiceCharge(row.id, invoicingCharge.draft, { date: row.date, reason: row.detail, amount: row.debit, items });
      setInvoicingCharge(null);
      setMessage(text);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo pedir la factura.");
    } finally {
      setBusy(false);
    }
  }

  async function handleShowInvoice(row: LedgerRow, inv: Invoice) {
    if (!fiscal) return;
    setRemitoBusyId(row.id);
    try {
      const print = invoicePrintFrom(inv, fiscal);
      if (!print) return;
      const items = await loadChargeItems(row.id);
      setPrintCharge({ date: row.date, reason: row.detail, amount: row.debit, items, invoice: print });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar la factura.");
    } finally {
      setRemitoBusyId(null);
    }
  }

  async function handleAddCharge() {
    if (busy) return;
    const wantsInvoice = Boolean(fiscal?.enabled && newInvoiceDraft.wanted);
    if (wantsInvoice && fiscal) {
      const invoiceError = invoiceDraftError(fiscal.taxCondition, newInvoiceDraft, chargeTotal);
      if (invoiceError) {
        setMessage(invoiceError);
        return;
      }
    }
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      if (chargeCart.length === 0) throw new Error("Agregá al menos un producto.");
      if (salesDetail && finalChargeTotal <= 0) throw new Error("Con ese descuento la venta queda en cero o menos.");
      const cartSnapshot = chargeCart;
      const adjustmentSnapshot = chargeAdjustment;
      const noteSnapshot = chargeNote.trim();
      const result = await addChargeWithItems({
        customerId: selectedCustomer.id,
        chargeDate,
        items: cartSnapshot.map((l) =>
          l.productId
            ? { productId: l.productId, quantity: l.quantity }
            : { description: l.name, unitPrice: l.unitPrice, quantity: l.quantity }
        ),
        reason: noteSnapshot || undefined,
        adjustment: adjustmentSnapshot || undefined
      });
      setChargeCart([]);
      setChargeNote("");
      setChargeAdjAmount("");
      setMessage("Venta registrada -- se descontó el stock, igual que en el Mostrador.");
      // Se muestra el remito de ESTA venta al toque -- la mercadería tiene
      // que salir con la boleta en el momento, no buscarla después en el
      // historial (ahí es fácil confundir la de hoy con una vieja).
      const sale = {
        date: chargeDate,
        reason: noteSnapshot || cartSnapshot.map((l) => l.name).join(", "),
        amount: result.amount,
        items: cartSnapshot.map((l) => ({
          id: l.key,
          productName: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.quantity * l.unitPrice
        })),
        adjustment: adjustmentSnapshot || undefined
      };
      setPrintCharge(sale);
      if (wantsInvoice) {
        const draft = newInvoiceDraft;
        setNewInvoiceDraft((cur) => ({ ...cur, wanted: false }));
        try {
          setMessage(`Venta registrada. ${await invoiceCharge(result.id, draft, sale)}`);
        } catch (err) {
          setMessage(`Venta registrada, pero la factura no se pudo pedir (${err instanceof Error ? err.message : "error"}). Tocá Facturar en el movimiento.`);
        }
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar la venta.");
    } finally {
      setBusy(false);
    }
  }

  /** El remito se arma al toque con lo que ya está guardado (los items de
   * la venta) -- no hace falta cargar nada de nuevo, solo traerlos. */
  async function handleShowRemito(row: LedgerRow) {
    setRemitoBusyId(row.id);
    try {
      const items = await loadChargeItems(row.id);
      if (items.length === 0) {
        setMessage("Esta venta no tiene detalle de productos (se cargó con el formulario viejo de monto + texto).");
        return;
      }
      const adjustment = salesDetail ? chargeAdjustmentOf(row.debit, items) : 0;
      setPrintCharge({ date: row.date, reason: row.detail, amount: row.debit, items, adjustment: adjustment || undefined });
    } catch (err) {
      // Detalle crudo del error -- para diagnosticar sin acceso a la base,
      // ya que el mensaje "lindo" de más abajo no alcanzó para ver la causa
      // real la primera vez que esto falló.
      const raw = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err);
      const code = (err as { code?: string })?.code;
      setMessage(`No se pudo cargar el detalle de la venta. [detalle: ${raw}${code ? ` · code ${code}` : ""}]`);
    } finally {
      setRemitoBusyId(null);
    }
  }

  /** Lo que el cliente ya debía antes de usar el sistema: un movimiento "Saldo anterior" (sin stock ni caja). */
  async function handleOpeningBalance() {
    if (busy || !selectedCustomer) return;
    const amount = parseAmount(openingAmount || "0") || 0;
    if (amount <= 0) {
      setMessage("Poné cuánto te debía el cliente antes de empezar con el sistema.");
      return;
    }
    setBusy(true);
    try {
      await addCharge({ customerId: selectedCustomer.id, chargeDate: openingDate, amount, reason: "Saldo anterior" });
      await reload();
      setOpeningAmount("");
      setShowOpening(false);
      setMessage(`Saldo anterior de ${formatMoney(amount)} cargado a ${selectedCustomer.name}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar el saldo anterior.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterPayment() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      const amount = parseAmount(paymentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!paymentAccountId) throw new Error("Elegí a qué cuenta entra el pago.");
      const result = await registerPayment({
        customerId: selectedCustomer.id,
        paymentDate,
        amount,
        accountId: paymentAccountId,
        notes: paymentNotes.trim() || undefined
      });
      setPaymentAmount("");
      setPaymentAccountId("");
      setPaymentNotes("");
      setMessage(`Pago registrado. Saldo restante: ${formatMoney(result.balance)}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el pago.");
    } finally {
      setBusy(false);
    }
  }

  function startEditRow(row: LedgerRow) {
    setEditingRowKey(row.key);
    setEditDate(row.date);
    if (row.type === "charge") {
      const charge = charges.find((c) => c.id === row.id);
      setEditAmount(String(charge?.amount ?? ""));
      setEditReason(charge?.reason ?? "");
    } else {
      const payment = payments.find((p) => p.id === row.id);
      setEditAmount(String(payment?.amount ?? ""));
      setEditAccountId(payment?.accountId ?? "");
      setEditNotes(payment?.notes ?? "");
    }
  }

  async function handleSaveRow(row: LedgerRow) {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      const amount = parseAmount(editAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");

      if (row.type === "charge") {
        if (!editReason.trim()) throw new Error("Ingresá un detalle.");
        await editCharge(selectedCustomer.id, { id: row.id, chargeDate: editDate, amount, reason: editReason.trim() });
      } else {
        if (!editAccountId) throw new Error("Elegí a qué cuenta entra el pago.");
        await editPayment(selectedCustomer.id, {
          id: row.id,
          paymentDate: editDate,
          amount,
          accountId: editAccountId,
          notes: editNotes.trim() || undefined
        });
      }
      setEditingRowKey(null);
      setMessage(row.type === "charge" ? "Venta actualizada." : "Pago actualizado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRow(row: LedgerRow) {
    if (busy) return;
    const label = row.type === "charge" ? "esta venta" : "este pago";
    if (!window.confirm(`¿Seguro que querés borrar ${label}? No se puede deshacer.`)) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      if (row.type === "charge") {
        await removeCharge(selectedCustomer.id, row.id);
        setMessage("Venta borrada.");
      } else {
        await removePayment(selectedCustomer.id, row.id);
        setMessage("Pago borrado.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo borrar.");
    } finally {
      setBusy(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  async function handleDownloadPdf() {
    if (!selectedCustomer || pdfBusy) return;
    setPdfBusy(true);
    setMessage("");
    try {
      const business = await getCompanyName(profile?.company_id).catch(() => "");
      await downloadCustomerStatementPdf({
        business,
        customerName: selectedCustomer.name,
        customerNumber: selectedCustomer.number,
        phone: selectedCustomer.phone,
        location: [selectedCustomer.locality, selectedCustomer.province].filter(Boolean).join(", "),
        issuedAt: todayIso(),
        rows: ledger
      });
    } catch {
      setMessage("No se pudo armar el PDF. Probá de nuevo.");
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">CLIENTES</p>
          <h1>Clientes y cuenta corriente</h1>
          <p className="muted">Clientes a los que les vendés fiado, sin cobrar en el momento (mayoristas, etc.). Elegí un cliente de la lista y abajo vas a poder cargarle una venta o registrar un pago.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Clientes</h2>
            <span>{loading ? "Cargando…" : `${visibleCustomers.length} de ${customers.length}`}</span>
          </div>
          {!loading && statusCounts.owes > 0 && (
            <div className="totals" style={{ marginBottom: 10 }}>
              <strong>Te deben en total <b>{formatMoney(totalOwed)}</b></strong>
              <span className="muted">entre {statusCounts.owes} {statusCounts.owes === 1 ? "cliente" : "clientes"}</span>
            </div>
          )}
          <input
            placeholder="Buscar por número, nombre, teléfono o localidad"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {(
              [
                ["all", `Todos (${statusCounts.all})`],
                ["owes", `Deben (${statusCounts.owes})`],
                ["overdue", `Atrasados (${statusCounts.overdue})`],
                ["clear", `Al día (${statusCounts.clear})`]
              ] as [CustomerFilter, string][]
            ).map(([value, label]) => (
              <button key={value} className={listFilter === value ? "" : "secondary"} onClick={() => setListFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className="panel-list-scroll">
            <table className="data-table">
              <thead>
                <tr><th>N.º</th><th>Nombre</th><th>Estado</th><th className="num">Saldo</th><th>Últ. movimiento</th><th></th></tr>
              </thead>
              <tbody>
                {visibleCustomers.map((c) => {
                  const status = customerStatus(c, today);
                  const badge = STATUS_BADGE[status];
                  return (
                    <tr key={c.id} style={status === "overdue" ? { background: "#fdecea" } : undefined}>
                      <td><b>{c.number ?? "—"}</b></td>
                      <td>{c.name}</td>
                      <td>
                        <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: badge.bg, color: badge.color, whiteSpace: "nowrap" }}>
                          {status === "clear" && c.balance <= -1 ? "A favor" : badge.label}
                        </span>
                      </td>
                      <td className="num" style={{ color: status === "clear" ? "#2e7d32" : undefined }}>{formatMoney(c.balance)}</td>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>{c.lastActivityDate ? formatShortDate(c.lastActivityDate) : "—"}</td>
                      <td>
                        <button className={c.id === selectedId ? "" : "secondary"} onClick={() => selectCustomer(c.id)}>
                          {c.id === selectedId ? "Seleccionado" : "Ver cuenta"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {customers.length === 0 && !loading && <p className="muted">Todavía no cargaste ningún cliente.</p>}
          {customers.length > 0 && visibleCustomers.length === 0 && <p className="muted">Ningún cliente coincide con la búsqueda.</p>}

          <div className="cash-banner-form" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="Teléfono (opcional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <input placeholder="Localidad (opcional)" value={locality} onChange={(e) => setLocality(e.target.value)} />
            <input placeholder="Provincia (opcional)" value={province} onChange={(e) => setProvince(e.target.value)} />
            <input placeholder="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Saldo anterior: lo que ya te debe (opcional)"
              title="Si el cliente ya te debía antes de usar el sistema, poné cuánto. Queda como primer movimiento de su cuenta."
              value={openingBalance}
              onChange={(e) => setOpeningBalance(e.target.value)}
              style={{ minWidth: 260 }}
            />
            <button disabled={busy} onClick={handleCreateCustomer}>Agregar cliente</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Cuenta corriente</h2>
          </div>
          {!selectedCustomer && <p className="muted">Elegí un cliente para ver su cuenta.</p>}
          {selectedCustomer && !editingCustomer && (
            <div className="totals">
              <span>Cliente <b>{selectedCustomer.number !== undefined ? `N.º ${selectedCustomer.number} · ` : ""}{selectedCustomer.name}</b></span>
              <span>Total vendido <b>{formatMoney(balance?.totalCharged ?? 0)}</b></span>
              <span>Pagado <b>{formatMoney(balance?.totalPaid ?? 0)}</b></span>
              <strong>Saldo (te debe) <b>{formatMoney(balance?.balance ?? 0)}</b></strong>
              <span>Plazo de pago <b>{selectedCustomer.paymentTermDays ? `${selectedCustomer.paymentTermDays} días` : "sin definir"}</b></span>
              {(selectedCustomer.locality || selectedCustomer.province) && (
                <span>Ubicación <b>{[selectedCustomer.locality, selectedCustomer.province].filter(Boolean).join(", ")}</b></span>
              )}
              <button className="secondary" style={{ marginTop: 10 }} onClick={() => setEditingCustomer(true)}>Editar</button>
            </div>
          )}
          {selectedCustomer && editingCustomer && (
            <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
              <input placeholder="Nombre" value={editName} onChange={(e) => setEditName(e.target.value)} />
              <input placeholder="Teléfono" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
              <input placeholder="Localidad" value={editLocality} onChange={(e) => setEditLocality(e.target.value)} />
              <input placeholder="Provincia" value={editProvince} onChange={(e) => setEditProvince(e.target.value)} />
              <input placeholder="Nota" value={editNotesField} onChange={(e) => setEditNotesField(e.target.value)} />
              <input
                type="number"
                placeholder="Plazo de pago (días)"
                value={editTermDays}
                onChange={(e) => setEditTermDays(e.target.value)}
                style={{ width: 170 }}
              />
              <select value={editActive ? "1" : "0"} onChange={(e) => setEditActive(e.target.value === "1")}>
                <option value="1">Activo</option>
                <option value="0">Dado de baja</option>
              </select>
              <button disabled={busy} onClick={handleUpdateCustomer}>Guardar</button>
              <button className="secondary" disabled={busy} onClick={() => setEditingCustomer(false)}>Cancelar</button>
              <button className="link-button" disabled={busy} onClick={() => void handleDeleteCustomer()}>Eliminar cliente</button>
            </div>
          )}
        </section>
      </div>

      {printCharge && (
        <section ref={printSectionRef} className="panel print-area" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>{printCharge.invoice ? "Factura" : "Remito"}</h2>
            <div className="no-print">
              <button className="secondary" onClick={handlePrint}>Imprimir</button>{" "}
              <button className="secondary" onClick={() => setPrintCharge(null)}>Cerrar</button>
            </div>
          </div>
          {printCharge.invoice && <InvoicePaperHeader invoice={printCharge.invoice} />}
          <div className="print-only-header">
            <p className="muted">{selectedCustomer?.number !== undefined ? `Cliente N.º ${selectedCustomer.number} · ` : ""}{selectedCustomer?.name}</p>
            <p className="muted">Fecha de venta: {printCharge.date}</p>
            {printCharge.reason && <p className="muted">{printCharge.reason}</p>}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Cantidad</th>
                <th className="num">Precio unit.</th>
                <th className="num">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {printCharge.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.productName}</td>
                  <td className="num">{item.quantity}</td>
                  <td className="num">{formatMoney(item.unitPrice)}</td>
                  <td className="num">{formatMoney(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="totals" style={{ marginTop: 12 }}>
            {printCharge.adjustment ? (
              <span>{printCharge.adjustment < 0 ? "Descuento" : "Recargo"} <b>{printCharge.adjustment < 0 ? "-" : "+"}{formatMoney(Math.abs(printCharge.adjustment))}</b></span>
            ) : null}
            <strong>Total <b>{formatMoney(printCharge.amount)}</b></strong>
          </div>
          {printCharge.invoice && <InvoicePaperFooter invoice={printCharge.invoice} />}
        </section>
      )}

      {selectedCustomer && (
        <>
          <div className="content-grid" style={{ marginTop: 18 }}>
            <section className="panel">
              <div className="panel-title">
                <h2>Nueva venta (fiado)</h2>
                <span className="muted" style={{ fontSize: 12 }}>Descuenta stock y suma al saldo del cliente, igual que una venta del Mostrador</span>
              </div>
              <div className="cash-banner-form" style={{ marginBottom: 10 }}>
                <label className="muted">Fecha</label>
                <input type="date" value={chargeDate} onChange={(e) => setChargeDate(e.target.value)} />
              </div>
              <div className="pos-search-wrap">
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>Producto</label>
                <input
                  type="text"
                  className="pos-search"
                  placeholder="Buscá el producto que le vendés…"
                  value={chargeSearch}
                  onChange={(e) => setChargeSearch(e.target.value)}
                  style={{ fontSize: 16, padding: "12px 14px 12px 42px" }}
                />
                {chargeMatches.length > 0 && (
                  <div className="pos-dropdown">
                    {chargeMatches.map((product) => (
                      <button key={product.id} type="button" className="pos-dropdown-item" onClick={() => addProductToCharge(product)}>
                        <span>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></span>
                        <strong>{formatMoney(product.priceRetail)}</strong>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {products.length === 0 && (
                <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Todavía no cargaste productos en el catálogo — usá "Vender algo sin código" para cargar la venta igual.
                </p>
              )}

              <div className="pos-toolbar">
                <button className={`pos-toolbar-btn${showManualForm ? " active" : ""}`} onClick={() => setShowManualForm((v) => !v)}>
                  + Vender algo sin código
                </button>
              </div>

              {showManualForm && (
                <div className="pos-manual-card">
                  <input placeholder="Descripción" value={manualDesc} onChange={(e) => setManualDesc(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={manualUnit === "kg" ? "Precio /kg" : "Precio"}
                    value={manualPrice}
                    onChange={(e) => setManualPrice(e.target.value)}
                    style={{ width: 100 }}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={manualUnit === "kg" ? "Kilos" : "Cant."}
                    value={manualQty}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setManualQty(e.target.value)}
                    style={{ width: 70 }}
                  />
                  <select
                    value={manualUnit}
                    onChange={(e) => {
                      const unit = e.target.value as Product["unit"];
                      setManualUnit(unit);
                      // Por kilo no arranca en "1": queda vacío para tipear los kilos (igual que Mostrador).
                      if (unit === "kg" && manualQty === "1") setManualQty("");
                      if (unit !== "kg" && manualQty === "") setManualQty("1");
                    }}
                  >
                    <option value="unit">Unidad</option>
                    <option value="kg">Kg</option>
                  </select>
                  <button onClick={addManualItem}>Agregar</button>
                  <button className="secondary" onClick={() => setShowManualForm(false)}>Cancelar</button>
                </div>
              )}

              {chargeCart.length === 0 ? (
                <p className="muted" style={{ marginTop: 12 }}>Buscá y agregá los productos que le estás vendiendo.</p>
              ) : (
                <div className="pos-cart">
                  {chargeCart.map((line) => (
                    <div className="pos-cart-row" key={line.key} style={{ gridTemplateColumns: "1fr 90px 110px 34px" }}>
                      <div className="name">
                        {line.name}
                        <small>{formatMoney(line.unitPrice)} /{UNIT_LABELS[line.unit]}</small>
                      </div>
                      <QuantityInput className="pos-qty-input" value={line.quantity} onChange={(q) => updateChargeItemQty(line.key, String(q))} />
                      <span className="pos-line-total">{formatMoney(line.quantity * line.unitPrice)}</span>
                      <button className="pos-remove-btn" onClick={() => removeChargeItem(line.key)} aria-label="Quitar" title="Quitar">×</button>
                    </div>
                  ))}
                </div>
              )}

              {chargeCart.length > 0 && (
                <>
                  <div className="cash-banner-form" style={{ marginTop: 12 }}>
                    <input placeholder="Nota (opcional, ej. nº de factura)" value={chargeNote} onChange={(e) => setChargeNote(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
                  </div>
                  {salesDetail && (
                    <div className="cash-banner-form" style={{ marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <select value={chargeAdjKind} onChange={(e) => setChargeAdjKind(e.target.value as "descuento" | "recargo")}>
                        <option value="descuento">Descuento</option>
                        <option value="recargo">Recargo</option>
                      </select>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="Monto (opcional)"
                        value={chargeAdjAmount}
                        onChange={(e) => setChargeAdjAmount(e.target.value)}
                        style={{ width: 150 }}
                      />
                      {chargeAdjustment !== 0 && (
                        <span className="muted" style={{ fontSize: 13 }}>
                          Productos {formatMoney(Math.round(chargeTotal))} {chargeAdjustment < 0 ? "−" : "+"} {formatMoney(Math.abs(chargeAdjustment))}
                        </span>
                      )}
                    </div>
                  )}
                  {fiscal?.enabled && (
                    <InvoiceRequestFields issuer={fiscal.taxCondition} draft={newInvoiceDraft} total={chargeTotal} onChange={setNewInvoiceDraft} />
                  )}
                  <div className="pos-total-bar" style={{ marginTop: 12 }}>
                    <div>
                      <p className="pos-total-label">Total de la venta</p>
                      <strong className="pos-total-value">{formatMoney(salesDetail ? finalChargeTotal : chargeTotal)}</strong>
                    </div>
                    <button className="charge-button pos-charge-btn" disabled={busy} onClick={handleAddCharge}>
                      {busy ? "Registrando…" : "Registrar venta"}
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="panel">
              <div className="panel-title">
                <h2>Registrar pago</h2>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
                <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Monto" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                <select value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
                  <option value="">Entra a…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                <input placeholder="Nota (opcional)" value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
                <button disabled={busy} onClick={handleRegisterPayment}>{busy ? "Registrando…" : "Registrar pago"}</button>
              </div>
              <div style={{ marginTop: 12 }}>
                {!showOpening ? (
                  <button className="link-button" onClick={() => setShowOpening(true)}>Cargar saldo anterior (lo que ya debía antes del sistema)</button>
                ) : (
                  <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                    <input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
                    <input type="text" inputMode="decimal" placeholder="Cuánto te debía" value={openingAmount} onChange={(e) => setOpeningAmount(e.target.value)} />
                    <button disabled={busy} onClick={handleOpeningBalance}>Cargar saldo anterior</button>
                    <button className="secondary" onClick={() => setShowOpening(false)}>Cancelar</button>
                  </div>
                )}
              </div>
            </section>
          </div>

          <section className={`panel${printCharge ? "" : " print-area"}`} style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Detalle de cuenta corriente</h2>
              <div className="no-print" style={{ display: "flex", gap: 8 }}>
                <button className="secondary" disabled={pdfBusy || ledger.length === 0} onClick={handleDownloadPdf}>
                  {pdfBusy ? "Armando PDF…" : "Descargar PDF"}
                </button>
                <button className="secondary" onClick={handlePrint}>Imprimir</button>
              </div>
            </div>
            <p className="muted print-only-header">{selectedCustomer.name}</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Concepto</th>
                  <th className="num">Venta</th>
                  <th className="num">Pago</th>
                  <th className="num">Saldo</th>
                  <th className="no-print"></th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) =>
                  editingRowKey === row.key ? (
                    <Fragment key={row.key}>
                      <tr className="no-print">
                        <td><input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></td>
                        <td>
                          {row.type === "charge" ? (
                            <input placeholder="Detalle" value={editReason} onChange={(e) => setEditReason(e.target.value)} />
                          ) : (
                            <input placeholder="Nota" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
                          )}
                        </td>
                        <td colSpan={2}>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="num"
                            value={editAmount}
                            onChange={(e) => setEditAmount(e.target.value)}
                            style={{ width: 100 }}
                          />{" "}
                          {row.type === "payment" && (
                            <select value={editAccountId} onChange={(e) => setEditAccountId(e.target.value)}>
                              <option value="">Entra a…</option>
                              {accounts.map((a) => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td colSpan={2}>
                          <button disabled={busy} onClick={() => handleSaveRow(row)}>Guardar</button>{" "}
                          <button className="secondary" disabled={busy} onClick={() => setEditingRowKey(null)}>Cancelar</button>
                        </td>
                      </tr>
                    </Fragment>
                  ) : (
                    <Fragment key={row.key}>
                    <tr>
                      <td>{row.date}</td>
                      <td>
                        {row.detail}
                        {row.type === "charge" && invoiceForCharge(row.id) && (
                          <span className="muted" style={{ fontSize: 12 }}> · {invoiceLabel(invoiceForCharge(row.id)!)}</span>
                        )}
                        {row.lines && (
                          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
                            {row.lines.map((line, index) => <li key={index}>{line}</li>)}
                          </ul>
                        )}
                      </td>
                      <td className="num">{row.debit > 0 ? formatMoney(row.debit) : "-"}</td>
                      <td className="num">{row.credit > 0 ? formatMoney(row.credit) : "-"}</td>
                      <td className="num">{formatMoney(row.balance)}</td>
                      <td className="no-print">
                        {/* El saldo anterior no tiene productos: sin remito ni factura. */}
                        {row.type === "charge" && !/Saldo anterior$/.test(row.detail) && (
                          <>
                            <button className="secondary" disabled={remitoBusyId === row.id} onClick={() => handleShowRemito(row)}>
                              {remitoBusyId === row.id ? "…" : "Remito"}
                            </button>{" "}
                            {remitoR && <RemitoRButton chargeId={row.id} />}
                            {(() => {
                              const inv = invoiceForCharge(row.id);
                              if (inv?.status === "autorizada") {
                                return (
                                  <>
                                    <button className="secondary" disabled={remitoBusyId === row.id} onClick={() => handleShowInvoice(row, inv)}>Factura</button>{" "}
                                  </>
                                );
                              }
                              if (inv) return <span className="muted" style={{ fontSize: 12 }}>Factura pendiente </span>;
                              if (!fiscal?.enabled) return null;
                              return (
                                <>
                                  <button
                                    className="secondary"
                                    disabled={busy}
                                    onClick={() => setInvoicingCharge(invoicingCharge?.chargeId === row.id ? null : { chargeId: row.id, draft: { ...newInvoiceDraft, wanted: true } })}
                                  >
                                    Facturar
                                  </button>{" "}
                                </>
                              );
                            })()}
                          </>
                        )}
                        <button className="secondary" disabled={busy} onClick={() => startEditRow(row)}>Editar</button>{" "}
                        <button className="secondary" disabled={busy} onClick={() => handleDeleteRow(row)}>Borrar</button>
                      </td>
                    </tr>
                    {invoicingCharge?.chargeId === row.id && fiscal && (
                      <tr className="no-print">
                        <td colSpan={6}>
                          <InvoiceRequestFields
                            issuer={fiscal.taxCondition}
                            draft={invoicingCharge.draft}
                            total={row.debit}
                            onChange={(draft) => setInvoicingCharge({ chargeId: row.id, draft: { ...draft, wanted: true } })}
                          />
                          <button disabled={busy} onClick={() => void handleInvoiceExisting(row)}>Pedir factura a ARCA</button>{" "}
                          <button className="secondary" onClick={() => setInvoicingCharge(null)}>Cancelar</button>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                )}
              </tbody>
            </table>
            {ledger.length === 0 && !detailLoading && <p className="muted">Todavía no hay movimientos para este cliente.</p>}
          </section>
        </>
      )}
    </>
  );
}
