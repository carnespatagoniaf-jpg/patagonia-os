import { useEffect, useMemo, useState } from "react";
import type { PaymentMethod, Product } from "@patagonia/domain";
import { marginPercent, purchaseTotal } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { bulkUpdateProductPrices, listProductsForBranch } from "../inventory/inventory-service";
import { LOW_MARGIN_ALERT, costChangesFromPurchase } from "../inventory/price-tools";
import { useSuppliers } from "./useSuppliers";
import { usePurchases } from "./usePurchases";
import { useTreasury } from "../shifts/useTreasury";
import { addSupplierAdjustment, deleteSupplierAdjustment, fetchSupplierAdjustmentsEnabled, type PurchaseLineInput } from "./purchases-service";
import { parseAmount } from "../../lib/money";
import { quantityNumber } from "../sale/quantity";
import { useAuth } from "../auth/AuthProvider";
import { can, canAccessPage, planAllows } from "../auth/permissions";
import { listSupplierTaxInfo, listVouchersForPurchases, setSupplierTax } from "../accounting/accounting-service";
import { PurchaseVoucherForm } from "../accounting/PurchaseVoucherForm";
import { voucherNumber, voucherTypeLabel, type PurchaseVoucher } from "../accounting/accounting-view";
import { ChequeFields, EMPTY_CHEQUE, readChequeForm, type ChequeForm } from "../cheques/ChequeFields";
import { endorseCheque, issueCheque, listOpenCheques } from "../cheques/cheques-service";
import { chequeTitle, formatDay, type Cheque } from "../cheques/cheque-logic";

/** Valores del selector "Pagar desde…" para pagar con cheque (migración 150). */
const OWN_CHEQUE_OPTION = "__own_cheque";
const ENDORSE_PREFIX = "__endorse:";
import { useCarcassTemplates } from "../carcass/useCarcassTemplates";

interface DraftLine {
  key: string;
  productId: string;
  description: string;
  quantity: string;
  unit: "kg" | "unit";
  unitPrice: string;
  /** Para despostar (migración 126): la res aparece sola en Despiece. */
  carcass: boolean;
  animalType: string;
  /** Kilos totales cuando se compra por unidad (cajones). */
  carcassWeight: string;
}

function emptyLine(): DraftLine {
  return { key: crypto.randomUUID(), productId: "", description: "", quantity: "", unit: "kg", unitPrice: "", carcass: false, animalType: "", carcassWeight: "" };
}

const DEFAULT_ANIMAL_TYPES = ["Vaca / media res", "Cerdo", "Pollo", "Mocho"];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(value);
}

function errorText(err: unknown, fallback: string) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message) || fallback;
  return fallback;
}

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Efectivo",
  qr: "Mercado Pago QR",
  debit: "Débito",
  credit: "Crédito",
  bank_province: "Banco Provincia",
  transfer: "Transferencia",
  digital: "Pagos digitales"
};

interface LedgerRow {
  key: string;
  date: string;
  detail: string;
  debit: number;
  credit: number;
  balance: number;
  /** Detalle de la compra (peso, precio): solo con descuentos/recargos activos. */
  lines?: string[];
  /** Descuento o recargo que se puede borrar desde el detalle. */
  adjustmentId?: string;
}

export function Purchases() {
  const { suppliers, loading: suppliersLoading, error: suppliersError, create: createSupplier, update: updateSupplier, remove: removeSupplier } = useSuppliers();
  const {
    purchases,
    items,
    payments,
    adjustments,
    balance,
    loading: purchasesLoading,
    error: purchasesError,
    branchId,
    loadSupplier,
    create: createPurchase,
    editItem,
    editPurchaseDate,
    registerPayment,
    updatePayment,
    removePayment,
    voidPurchase
  } = usePurchases();
  const { accounts } = useTreasury();
  const { profile } = useAuth();
  const canCheques = isSupabaseConfigured && canAccessPage(profile, "cheques");
  useEffect(() => {
    if (!canCheques) return;
    listOpenCheques()
      .then((list) => setPortfolioCheques(list.filter((c) => c.kind === "received")))
      .catch(() => setPortfolioCheques([]));
  }, [canCheques]);
  // Para despostar: solo quien tiene Despiece (plan Estándar o más).
  const canCarcass = can(profile, "carcass.manage");
  const { templates } = useCarcassTemplates();
  const animalTypes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const name of [...DEFAULT_ANIMAL_TYPES, ...templates.map((t) => t.animalType)]) {
      if (name.trim() && !seen.has(name.trim().toLowerCase())) seen.set(name.trim().toLowerCase(), name.trim());
    }
    return [...seen.values()];
  }, [templates]);
  const templateCutsFor = (animalType: string) =>
    templates.filter((t) => t.animalType.trim().toLowerCase() === animalType.trim().toLowerCase()).length;

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [updateCosts, setUpdateCosts] = useState(true);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [supplierCategory, setSupplierCategory] = useState("");
  const [supplierPhone, setSupplierPhone] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDeleteSupplierId, setConfirmDeleteSupplierId] = useState<string | null>(null);
  const [deleteSupplierBusy, setDeleteSupplierBusy] = useState(false);

  const [purchaseDate, setPurchaseDate] = useState(todayIso());
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  // Qué renglón tiene el buscador de producto abierto ahora mismo -- antes
  // el listado de sugerencias se mostraba con solo que hubiera texto y
  // coincidencias, sin importar el foco, y al ser position:absolute tapaba
  // literalmente el botón "+ Agregar ítem" de abajo (con un solo renglón,
  // no había otro elemento debajo para "empujarlo"). Ahora solo se muestra
  // mientras el campo está enfocado, y se cierra solo al salir de foco, sin
  // obligar a borrar lo escrito para volver a ver el resto del formulario.
  const [openSearchKey, setOpenSearchKey] = useState<string | null>(null);

  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [paymentCheque, setPaymentCheque] = useState<ChequeForm>(EMPTY_CHEQUE);
  const [chequeBankAccountId, setChequeBankAccountId] = useState("");
  const [portfolioCheques, setPortfolioCheques] = useState<Cheque[]>([]);
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [paymentNotes, setPaymentNotes] = useState("");

  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [editPaymentDate, setEditPaymentDate] = useState("");
  const [editPaymentAmount, setEditPaymentAmount] = useState("");
  const [editPaymentAccountId, setEditPaymentAccountId] = useState("");
  const [editPaymentNotes, setEditPaymentNotes] = useState("");

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editUnitPrice, setEditUnitPrice] = useState("");

  const [editingDatePurchaseId, setEditingDatePurchaseId] = useState<string | null>(null);
  const [editPurchaseDateValue, setEditPurchaseDateValue] = useState("");

  // Detalle de compra + descuentos/recargos en la cuenta (migración 142):
  // solo empresas con companies.supplier_adjustments (hoy Martínez).
  const [adjustmentsEnabled, setAdjustmentsEnabled] = useState(false);
  const [adjustmentKind, setAdjustmentKind] = useState<"descuento" | "recargo">("descuento");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentDate, setAdjustmentDate] = useState(todayIso());
  const [adjustmentNotes, setAdjustmentNotes] = useState("");

  const [editingSupplier, setEditingSupplier] = useState(false);
  const [editSupplierName, setEditSupplierName] = useState("");
  const [editSupplierCategory, setEditSupplierCategory] = useState("");
  const [editSupplierPhone, setEditSupplierPhone] = useState("");
  const [editSupplierNotes, setEditSupplierNotes] = useState("");
  const [editSupplierActive, setEditSupplierActive] = useState(true);

  // Datos fiscales (plan Full, migración 155): CUIT del proveedor y la factura
  // de cada compra para el Libro IVA Compras (pantalla Contable).
  const fiscalOn = isSupabaseConfigured && planAllows(profile, "full") && ["owner", "admin", "manager"].includes(profile?.role ?? "");
  const [taxInfo, setTaxInfo] = useState<Record<string, { taxId: string | null; taxCondition: string | null }>>({});
  const [editSupplierCuit, setEditSupplierCuit] = useState("");
  const [editSupplierTaxCondition, setEditSupplierTaxCondition] = useState("");
  const [purchaseVouchers, setPurchaseVouchers] = useState<Record<string, PurchaseVoucher>>({});
  const [voucherFormFor, setVoucherFormFor] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;
    listProductsForBranch(branchId).then(setProducts).catch(() => setProducts([]));
  }, [branchId]);

  useEffect(() => {
    if (!isSupabaseConfigured || !profile?.company_id) return;
    fetchSupplierAdjustmentsEnabled(profile.company_id).then(setAdjustmentsEnabled).catch(() => setAdjustmentsEnabled(false));
  }, [profile?.company_id]);

  useEffect(() => {
    if (selectedSupplierId) void loadSupplier(selectedSupplierId);
  }, [selectedSupplierId, loadSupplier]);

  useEffect(() => {
    if (!fiscalOn) return;
    listSupplierTaxInfo().then(setTaxInfo).catch(() => setTaxInfo({}));
  }, [fiscalOn, suppliers]);

  const purchaseIdsKey = purchases.map((p) => p.id).join(",");
  useEffect(() => {
    if (!fiscalOn) return;
    listVouchersForPurchases(purchaseIdsKey ? purchaseIdsKey.split(",") : [])
      .then(setPurchaseVouchers)
      .catch(() => setPurchaseVouchers({}));
  }, [fiscalOn, purchaseIdsKey]);

  const draftTotal = useMemo(() => {
    const parsed: PurchaseLineInput[] = lines
      .filter((line) => line.quantity && line.unitPrice)
      .map((line) => ({ quantity: quantityNumber(line.quantity), unitPrice: parseAmount(line.unitPrice), unit: line.unit }));
    return purchaseTotal(parsed);
  }, [lines]);

  async function handleCreateSupplier() {
    if (busy) return;
    setBusy(true);
    try {
      if (!supplierName.trim()) throw new Error("El nombre del proveedor es obligatorio.");
      const supplier = await createSupplier({
        name: supplierName.trim(),
        category: supplierCategory.trim() || "general",
        phone: supplierPhone.trim() || undefined
      });
      setSupplierName("");
      setSupplierCategory("");
      setSupplierPhone("");
      setSelectedSupplierId(supplier.id);
      setMessage("Proveedor creado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo crear el proveedor.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateSupplier() {
    if (busy || !selectedSupplierId) return;
    setBusy(true);
    try {
      if (!editSupplierName.trim()) throw new Error("El nombre del proveedor es obligatorio.");
      await updateSupplier({
        id: selectedSupplierId,
        name: editSupplierName.trim(),
        category: editSupplierCategory.trim() || "general",
        phone: editSupplierPhone.trim() || undefined,
        notes: editSupplierNotes.trim() || undefined,
        active: editSupplierActive
      });
      if (fiscalOn) {
        const cuit = editSupplierCuit.replace(/\D/g, "") || null;
        const condition = editSupplierTaxCondition || null;
        const current = taxInfo[selectedSupplierId];
        if (cuit !== (current?.taxId ?? null) || condition !== (current?.taxCondition ?? null)) {
          await setSupplierTax(selectedSupplierId, cuit, condition);
          setTaxInfo(await listSupplierTaxInfo());
        }
      }
      setEditingSupplier(false);
      if (!editSupplierActive) setSelectedSupplierId(null);
      setMessage(editSupplierActive ? "Proveedor actualizado." : "Proveedor eliminado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar el proveedor.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmDeleteSupplier(supplierId: string) {
    setDeleteSupplierBusy(true);
    try {
      const result = await removeSupplier(supplierId);
      setConfirmDeleteSupplierId(null);
      if (selectedSupplierId === supplierId) setSelectedSupplierId(null);
      setMessage(result === "deleted" ? "Proveedor eliminado." : "Ese proveedor tenía compras o pagos: quedó dado de baja (ya no aparece en la lista) y su historia se guarda.");
    } catch (err) {
      const raw = err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "";
      setMessage(raw || "No se pudo eliminar el proveedor.");
    } finally {
      setDeleteSupplierBusy(false);
    }
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((current) => [...current, emptyLine()]);
  }

  function removeLine(key: string) {
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
  }

  async function handleCreatePurchase() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedSupplierId) throw new Error("Elegí un proveedor primero.");

      const parsed: PurchaseLineInput[] = lines.map((line) => {
        const quantity = quantityNumber(line.quantity);
        const unitPrice = parseAmount(line.unitPrice);
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Cada ítem necesita una cantidad válida.");
        if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("Cada ítem necesita un precio válido.");
        if (line.carcass) {
          const animalType = line.animalType.trim();
          if (!animalType) throw new Error("En la línea para despostar, elegí qué es (Pollo, Vaca / media res…).");
          if (line.unit === "kg") return { carcassAnimalType: animalType, description: animalType, quantity, unit: line.unit, unitPrice };
          const weight = quantityNumber(line.carcassWeight);
          if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Poné cuántos kilos son en total los ${line.quantity} de ${animalType}.`);
          return { carcassAnimalType: animalType, carcassWeight: weight, description: animalType, quantity, unit: line.unit, unitPrice };
        }
        if (line.productId) return { productId: line.productId, quantity, unit: line.unit, unitPrice };
        if (!line.description.trim()) throw new Error("Elegí un producto o escribí una descripción.");
        return { description: line.description.trim(), quantity, unit: line.unit, unitPrice };
      });

      const created = await createPurchase(selectedSupplierId, purchaseDate, invoiceNumber.trim() || undefined, parsed);
      setLines([emptyLine()]);
      setInvoiceNumber("");
      const carcassNote = created.carcass
        .map((c) => c.cuts > 0
          ? ` ${c.animalType}: repartido solo en ${c.cuts} cortes, ya están en Stock (si querés, corregí los kilos reales en Despiece).`
          : ` ${c.animalType}: quedó en Despiece para cargar los cortes.`)
        .join("");

      // Con inflación el costo del producto se desactualiza si nadie lo edita a
      // mano: se actualiza con el precio de esta compra (opcional, tildado por defecto).
      let costNote = "";
      if (updateCosts && isSupabaseConfigured) {
        const changes = costChangesFromPurchase(products, parsed);
        if (changes.length > 0) {
          try {
            await bulkUpdateProductPrices(changes.map((c) => ({ id: c.id, priceRetail: c.priceRetail, cost: c.newCost })));
            if (branchId) setProducts(await listProductsForBranch(branchId));
            const low = changes.filter((c) => c.priceRetail > 0 && c.newMargin < LOW_MARGIN_ALERT);
            costNote = ` Costo actualizado en ${changes.length} producto${changes.length === 1 ? "" : "s"}.`;
            if (low.length > 0) {
              costNote += ` Ojo, quedaron con margen bajo (menos de ${LOW_MARGIN_ALERT}%): ${low.map((c) => c.name).join(", ")}. Revisá el precio en Stock → Actualizar precios.`;
            }
          } catch {
            costNote = " No se pudo actualizar el costo de los productos (la compra sí quedó registrada).";
          }
        }
      }
      setMessage(`Compra registrada.${carcassNote}${costNote}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo registrar la compra.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit(itemId: string) {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedSupplierId) return;
      const quantity = quantityNumber(editQuantity);
      const unitPrice = parseAmount(editUnitPrice);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Cantidad inválida.");
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("Precio inválido.");
      await editItem(selectedSupplierId, itemId, quantity, unitPrice);
      setEditingItemId(null);
      setMessage("Ítem actualizado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo editar el ítem.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterPayment() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedSupplierId) throw new Error("Elegí un proveedor primero.");
      const amount = parseAmount(paymentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!paymentAccountId) throw new Error("Elegí de qué cuenta sale el pago.");
      if (paymentAccountId.startsWith(ENDORSE_PREFIX) || paymentAccountId === OWN_CHEQUE_OPTION) {
        if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
        if (paymentAccountId === OWN_CHEQUE_OPTION) {
          const read = readChequeForm(paymentCheque, paymentAmount);
          if ("error" in read) throw new Error(read.error);
          if (!chequeBankAccountId) throw new Error("Elegí de qué cuenta del banco sale el cheque.");
          await issueCheque({
            supplierId: selectedSupplierId,
            branchId,
            issuedOn: paymentDate,
            amount: read.amount,
            number: paymentCheque.number.trim(),
            payDate: paymentCheque.payDate,
            echeq: paymentCheque.echeq,
            bankAccountId: chequeBankAccountId,
            notes: paymentNotes.trim() || undefined
          });
          setMessage("Cheque propio registrado (queda en Finanzas → Cheques, para pagar).");
        } else {
          await endorseCheque(paymentAccountId.slice(ENDORSE_PREFIX.length), selectedSupplierId, branchId, paymentDate);
          setMessage("Cheque endosado al proveedor.");
        }
        await loadSupplier(selectedSupplierId);
        setPortfolioCheques(await listOpenCheques().then((l) => l.filter((c) => c.kind === "received")).catch(() => []));
        setPaymentAmount("");
        setPaymentAccountId("");
        setPaymentNotes("");
        setPaymentCheque(EMPTY_CHEQUE);
        setChequeBankAccountId("");
        return;
      }

      await registerPayment({
        supplierId: selectedSupplierId,
        paymentDate,
        amount,
        accountId: paymentAccountId,
        notes: paymentNotes.trim() || undefined
      });
      setPaymentAmount("");
      setPaymentAccountId("");
      setPaymentNotes("");
      setMessage("Pago registrado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo registrar el pago.");
    } finally {
      setBusy(false);
    }
  }

  function startEditPayment(payment: { id: string; paymentDate: string; amount: number; accountId?: string; notes?: string }) {
    setEditingPaymentId(payment.id);
    setEditPaymentDate(payment.paymentDate);
    setEditPaymentAmount(String(payment.amount));
    setEditPaymentAccountId(payment.accountId ?? "");
    setEditPaymentNotes(payment.notes ?? "");
  }

  async function handleSavePayment() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedSupplierId || !editingPaymentId) return;
      const amount = parseAmount(editPaymentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!editPaymentAccountId) throw new Error("Elegí de qué cuenta sale el pago.");

      await updatePayment(selectedSupplierId, {
        id: editingPaymentId,
        paymentDate: editPaymentDate,
        amount,
        accountId: editPaymentAccountId,
        notes: editPaymentNotes.trim() || undefined
      });
      setEditingPaymentId(null);
      setMessage("Pago actualizado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo actualizar el pago.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSavePurchaseDate(purchaseId: string) {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedSupplierId) return;
      if (!editPurchaseDateValue) throw new Error("Ingresá una fecha válida.");
      await editPurchaseDate(selectedSupplierId, purchaseId, editPurchaseDateValue);
      setEditingDatePurchaseId(null);
      setMessage("Fecha de la compra corregida.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo corregir la fecha.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVoidPurchase(purchaseId: string) {
    if (busy) return;
    const hasCarcass = (items[purchaseId] ?? []).some((item) => item.carcassAnimalType);
    const carcassWarning = hasCarcass ? " También se borra de Despiece lo que vino para despostar, con sus cortes." : "";
    if (!window.confirm(`¿Seguro que querés anular esta compra? Se revierte el stock que había sumado y no se puede deshacer.${carcassWarning}`)) return;
    setBusy(true);
    try {
      if (!selectedSupplierId) return;
      await voidPurchase(selectedSupplierId, purchaseId);
      setMessage("Compra anulada — se revirtió el stock que había sumado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo anular la compra.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddAdjustment() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedSupplierId) throw new Error("Elegí un proveedor primero.");
      const amount = parseAmount(adjustmentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!adjustmentDate) throw new Error("Ingresá una fecha.");
      await addSupplierAdjustment({
        supplierId: selectedSupplierId,
        adjustmentDate,
        amount: adjustmentKind === "descuento" ? -amount : amount,
        notes: adjustmentNotes.trim() || undefined
      });
      await loadSupplier(selectedSupplierId);
      setAdjustmentAmount("");
      setAdjustmentNotes("");
      setMessage(adjustmentKind === "descuento" ? "Descuento cargado: la deuda con el proveedor bajó." : "Recargo cargado: la deuda con el proveedor subió.");
    } catch (error) {
      setMessage(errorText(error, "No se pudo cargar el movimiento."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteAdjustment(adjustmentId: string) {
    if (busy) return;
    if (!window.confirm("¿Seguro que querés borrar este descuento o recargo?")) return;
    setBusy(true);
    try {
      if (!selectedSupplierId) return;
      await deleteSupplierAdjustment(adjustmentId);
      await loadSupplier(selectedSupplierId);
      setMessage("Movimiento borrado.");
    } catch (error) {
      setMessage(errorText(error, "No se pudo borrar el movimiento."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePayment(paymentId: string) {
    if (busy) return;
    if (!window.confirm("¿Seguro que querés borrar este pago? No se puede deshacer.")) return;
    setBusy(true);
    try {
      if (!selectedSupplierId) return;
      await removePayment(selectedSupplierId, paymentId);
      setMessage("Pago borrado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo borrar el pago.");
    } finally {
      setBusy(false);
    }
  }

  const selectedSupplier = suppliers.find((s) => s.id === selectedSupplierId) ?? null;

  useEffect(() => {
    if (selectedSupplier) {
      setEditSupplierName(selectedSupplier.name);
      setEditSupplierCategory(selectedSupplier.category);
      setEditSupplierPhone(selectedSupplier.phone ?? "");
      setEditSupplierNotes(selectedSupplier.notes ?? "");
      setEditSupplierActive(selectedSupplier.active);
      setEditSupplierCuit(taxInfo[selectedSupplier.id]?.taxId ?? "");
      setEditSupplierTaxCondition(taxInfo[selectedSupplier.id]?.taxCondition ?? "");
      setEditingSupplier(false);
    }
  }, [selectedSupplier]);

  const ledger = useMemo<LedgerRow[]>(() => {
    const rows = [
      ...purchases.filter((purchase) => purchase.status === "active").map((purchase) => ({
        key: `purchase-${purchase.id}`,
        date: purchase.purchaseDate,
        detail: purchase.invoiceNumber ? `Compra · Fact. ${purchase.invoiceNumber}` : "Compra",
        debit: purchase.total,
        credit: 0,
        lines: adjustmentsEnabled
          ? (items[purchase.id] ?? []).map((item) => {
              const name = item.description ?? products.find((p) => p.id === item.productId)?.name ?? "Producto";
              const unit = item.unit === "kg" ? "kg" : item.quantity === 1 ? "unidad" : "unidades";
              return `${name}: ${formatQuantity(item.quantity)} ${unit} × ${formatMoney(item.unitPrice)} = ${formatMoney(item.lineTotal)}`;
            })
          : undefined
      })),
      ...payments.map((payment) => ({
        key: `payment-${payment.id}`,
        date: payment.paymentDate,
        detail: `Pago · ${payment.accountName ?? PAYMENT_METHOD_LABELS[payment.paymentMethod]}${payment.notes ? ` · ${payment.notes}` : ""}`,
        debit: 0,
        credit: payment.amount
      })),
      ...(adjustmentsEnabled ? adjustments : []).map((adjustment) => ({
        key: `adjustment-${adjustment.id}`,
        date: adjustment.adjustmentDate,
        detail: `${adjustment.amount < 0 ? "Descuento" : "Recargo"}${adjustment.notes ? ` · ${adjustment.notes}` : ""}`,
        debit: adjustment.amount > 0 ? adjustment.amount : 0,
        credit: adjustment.amount < 0 ? -adjustment.amount : 0,
        adjustmentId: adjustment.id
      }))
    ].sort((a, b) => a.date.localeCompare(b.date));

    let running = 0;
    return rows.map((row) => {
      running += row.debit - row.credit;
      return { ...row, balance: running };
    });
  }, [purchases, payments, adjustments, adjustmentsEnabled, items, products]);
  const adjustmentsTotal = adjustments.reduce((sum, a) => sum + a.amount, 0);

  function handlePrintLedger() {
    window.print();
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">COMPRAS</p>
          <h1>Compras y proveedores</h1>
          <p className="muted">Cuenta corriente por proveedor, ligada a stock y a caja.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {suppliersError && <div className="message warning">{suppliersError}</div>}
      {purchasesError && <div className="message warning">{purchasesError}</div>}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Proveedores</h2>
            <span>{suppliersLoading ? "Cargando…" : `${suppliers.length} proveedores`}</span>
          </div>

          <div className="panel-list-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Rubro</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((supplier) => (
                  <tr key={supplier.id}>
                    <td>{supplier.name}</td>
                    <td>{supplier.category}</td>
                    <td>
                      {confirmDeleteSupplierId === supplier.id ? (
                        <>
                          <span className="muted" style={{ fontSize: 13, marginRight: 6 }}>¿Seguro? Si ya tiene compras o pagos, queda dado de baja y se guarda su historia.</span>
                          <button className="danger" disabled={deleteSupplierBusy} onClick={() => handleConfirmDeleteSupplier(supplier.id)}>
                            {deleteSupplierBusy ? "Eliminando…" : "Sí, borrar"}
                          </button>{" "}
                          <button className="secondary" disabled={deleteSupplierBusy} onClick={() => setConfirmDeleteSupplierId(null)}>Cancelar</button>
                        </>
                      ) : (
                        <>
                          <button
                            className={supplier.id === selectedSupplierId ? "" : "secondary"}
                            onClick={() => setSelectedSupplierId(supplier.id)}
                          >
                            {supplier.id === selectedSupplierId ? "Seleccionado" : "Ver cuenta"}
                          </button>{" "}
                          <button className="danger" onClick={() => setConfirmDeleteSupplierId(supplier.id)}>Borrar</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="cash-banner-form" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <input placeholder="Nombre" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
            <input placeholder="Rubro (pollo, carne...)" value={supplierCategory} onChange={(e) => setSupplierCategory(e.target.value)} />
            <input placeholder="Teléfono" value={supplierPhone} onChange={(e) => setSupplierPhone(e.target.value)} />
            <button disabled={busy} onClick={handleCreateSupplier}>Agregar proveedor</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Cuenta corriente</h2>
          </div>
          {!selectedSupplier && <p className="muted">Elegí un proveedor para ver su cuenta.</p>}
          {selectedSupplier && !editingSupplier && (
            <div className="totals">
              <span>Proveedor <b>{selectedSupplier.name}</b></span>
              <span>Compras <b>{formatMoney(balance?.totalPurchases ?? 0)}</b></span>
              <span>Pagos <b>{formatMoney(balance?.totalPayments ?? 0)}</b></span>
              {adjustmentsEnabled && adjustmentsTotal !== 0 && (
                <span>{adjustmentsTotal < 0 ? "Descuentos" : "Recargos"} <b>{formatMoney(Math.abs(adjustmentsTotal))}</b></span>
              )}
              <strong>Saldo <b>{formatMoney(balance?.balance ?? 0)}</b></strong>
              {fiscalOn && (
                <span className="muted" style={{ fontSize: 13 }}>
                  {taxInfo[selectedSupplier.id]?.taxId ? `CUIT ${taxInfo[selectedSupplier.id]?.taxId}` : "Sin CUIT (cargalo con Editar, sirve para el Libro IVA)"}
                </span>
              )}
              <button
                className="secondary"
                style={{ marginTop: 10 }}
                onClick={() => {
                  setEditSupplierCuit(taxInfo[selectedSupplier.id]?.taxId ?? "");
                  setEditSupplierTaxCondition(taxInfo[selectedSupplier.id]?.taxCondition ?? "");
                  setEditingSupplier(true);
                }}
              >
                Editar
              </button>
            </div>
          )}
          {selectedSupplier && editingSupplier && (
            <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
              <input placeholder="Nombre" value={editSupplierName} onChange={(e) => setEditSupplierName(e.target.value)} />
              <input placeholder="Rubro (pollo, carne...)" value={editSupplierCategory} onChange={(e) => setEditSupplierCategory(e.target.value)} />
              <input placeholder="Teléfono" value={editSupplierPhone} onChange={(e) => setEditSupplierPhone(e.target.value)} />
              <input placeholder="Notas" value={editSupplierNotes} onChange={(e) => setEditSupplierNotes(e.target.value)} />
              {fiscalOn && (
                <>
                  <input placeholder="CUIT" inputMode="numeric" value={editSupplierCuit} onChange={(e) => setEditSupplierCuit(e.target.value)} />
                  <select value={editSupplierTaxCondition} onChange={(e) => setEditSupplierTaxCondition(e.target.value)}>
                    <option value="">Condición frente al IVA…</option>
                    <option value="responsable_inscripto">Responsable inscripto (te da Factura A)</option>
                    <option value="monotributo">Monotributista (Factura C)</option>
                    <option value="exento">Exento</option>
                  </select>
                </>
              )}
              <select value={editSupplierActive ? "1" : "0"} onChange={(e) => setEditSupplierActive(e.target.value === "1")}>
                <option value="1">Activo</option>
                <option value="0">Dado de baja</option>
              </select>
              <button disabled={busy} onClick={handleUpdateSupplier}>Guardar</button>
              <button className="secondary" disabled={busy} onClick={() => setEditingSupplier(false)}>Cancelar</button>
            </div>
          )}
        </section>
      </div>

      {selectedSupplier && (
        <>
          <section className="panel no-print" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Registrar pago a {selectedSupplier.name}</h2>
            </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Monto" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                <select
                  value={paymentAccountId}
                  onChange={(e) => {
                    const value = e.target.value;
                    setPaymentAccountId(value);
                    const cheque = portfolioCheques.find((c) => ENDORSE_PREFIX + c.id === value);
                    if (cheque) setPaymentAmount(String(cheque.amount).replace(".", ","));
                  }}
                >
                  <option value="">Pagar desde…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                  {canCheques && <option value={OWN_CHEQUE_OPTION}>Cheque propio / eCheq</option>}
                  {canCheques && portfolioCheques.length > 0 && (
                    <optgroup label="Cheque de la cartera (endosar)">
                      {portfolioCheques.map((c) => (
                        <option key={c.id} value={ENDORSE_PREFIX + c.id}>
                          {chequeTitle(c)} · {formatMoney(c.amount)} · cobra {formatDay(c.payDate)}{c.customerName ? ` · de ${c.customerName}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {!paymentAccountId.startsWith("__") && (
                  <>
                    <input placeholder="Nota" value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} />
                    <button disabled={busy} onClick={handleRegisterPayment}>{busy ? "Registrando…" : "Registrar pago"}</button>
                  </>
                )}
              </div>
              {paymentAccountId === OWN_CHEQUE_OPTION && (
                <div style={{ marginTop: 10 }}>
                  <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 8 }}>
                    <select value={chequeBankAccountId} onChange={(e) => setChequeBankAccountId(e.target.value)}>
                      <option value="">¿De qué cuenta del banco sale?</option>
                      {accounts.filter((a) => !a.isSafe).map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </div>
                  <ChequeFields value={paymentCheque} onChange={setPaymentCheque} withAmount={false} withDrawer={false} />
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>Lo que le debés baja ahora; la plata sale del banco en la fecha del cheque.</p>
                </div>
              )}
              {paymentAccountId.startsWith(ENDORSE_PREFIX) && (
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>Se paga con el monto del cheque. El cheque sale de la cartera y queda como endosado a este proveedor.</p>
              )}
              {paymentAccountId.startsWith("__") && (
                <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 10 }}>
                  <input placeholder="Nota" value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} />
                  <button disabled={busy} onClick={handleRegisterPayment}>{busy ? "Registrando…" : "Registrar pago"}</button>
                </div>
              )}
          </section>

          {adjustmentsEnabled && (
            <section className="panel no-print" style={{ marginTop: 18 }}>
              <div className="panel-title">
                <h2>Descuento o recargo a {selectedSupplier.name}</h2>
              </div>
              <p className="muted" style={{ marginTop: 0 }}>Cambia lo que le debés, sin mover caja ni stock. Descuento: le debés menos. Recargo: le debés más.</p>
              <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                <select value={adjustmentKind} onChange={(e) => setAdjustmentKind(e.target.value as "descuento" | "recargo")}>
                  <option value="descuento">Descuento</option>
                  <option value="recargo">Recargo</option>
                </select>
                <input type="date" value={adjustmentDate} onChange={(e) => setAdjustmentDate(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Monto" value={adjustmentAmount} onChange={(e) => setAdjustmentAmount(e.target.value)} />
                <input placeholder="Motivo (opcional)" value={adjustmentNotes} onChange={(e) => setAdjustmentNotes(e.target.value)} />
                <button disabled={busy} onClick={handleAddAdjustment}>{busy ? "Guardando…" : adjustmentKind === "descuento" ? "Cargar descuento" : "Cargar recargo"}</button>
              </div>
            </section>
          )}

          <section className="panel no-print" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Nueva compra</h2>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
              <div className="field">
                <span>Fecha</span>
                <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
              </div>
              <div className="field" style={{ minWidth: 180 }}>
                <span>N° de factura</span>
                <input placeholder="Opcional" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
              </div>
            </div>

            <div className="purchase-lines">
              <div className="purchase-line purchase-line-head">
                <span>Producto</span>
                <span>Cantidad</span>
                <span>Unidad</span>
                <span>Precio unitario</span>
                <span className="num">Subtotal</span>
                <span></span>
              </div>
              {lines.map((line) => {
                const selectedProduct = products.find((p) => p.id === line.productId);
                const productMatches = !line.productId && line.description.trim()
                  ? products.filter((p) => p.name.toLowerCase().includes(line.description.toLowerCase())).slice(0, 8)
                  : [];
                const qty = quantityNumber(line.quantity);
                const price = parseAmount(line.unitPrice);
                const subtotal = Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;
                return (
                  <div key={line.key} className="purchase-line">
                    <div className="purchase-line-product">
                      {line.carcass ? (
                        <>
                          <input
                            list="purchase-animal-types"
                            placeholder="¿Qué es? (Pollo, Vaca…)"
                            value={line.animalType}
                            onChange={(e) => updateLine(line.key, { animalType: e.target.value })}
                          />
                          {line.unit === "unit" && (
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder="Kilos en total"
                              value={line.carcassWeight}
                              onFocus={(e) => e.target.select()}
                              onChange={(e) => updateLine(line.key, { carcassWeight: e.target.value })}
                              style={{ marginTop: 4 }}
                            />
                          )}
                          <small className="muted">
                            {line.animalType.trim() && templateCutsFor(line.animalType) > 0
                              ? `Se reparte solo en ${templateCutsFor(line.animalType)} cortes y entran a Stock.`
                              : "Aparece en Despiece para cargar los cortes (con una plantilla de cortes se reparte solo)."}
                          </small>
                        </>
                      ) : selectedProduct ? (
                        <>
                          <span className="purchase-line-picked">
                            <strong>{selectedProduct.name}</strong>
                            <button className="secondary" onClick={() => updateLine(line.key, { productId: "", description: "" })}>Cambiar</button>
                          </span>
                          <small className="muted">
                            Costo {formatMoney(selectedProduct.cost)} · Margen {marginPercent(selectedProduct.cost, selectedProduct.priceRetail)}% · Venta {formatMoney(selectedProduct.priceRetail)}
                          </small>
                        </>
                      ) : (
                        <div className="pos-search-wrap">
                          <input
                            placeholder="Buscá el producto o escribí una descripción libre…"
                            value={line.description}
                            onChange={(e) => updateLine(line.key, { description: e.target.value })}
                            onFocus={() => setOpenSearchKey(line.key)}
                            onBlur={() => setOpenSearchKey((k) => (k === line.key ? null : k))}
                            onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLInputElement).blur(); }}
                          />
                          {openSearchKey === line.key && productMatches.length > 0 && (
                            <div className="pos-dropdown">
                              {productMatches.map((product) => (
                                <button
                                  key={product.id}
                                  type="button"
                                  className="pos-dropdown-item"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => { updateLine(line.key, { productId: product.id, description: "" }); setOpenSearchKey(null); }}
                                >
                                  <span>{product.name}</span>
                                  <strong>{formatMoney(product.cost)}</strong>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {canCarcass && (
                        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, marginTop: 4, whiteSpace: "nowrap" }} title="Media res, cajones de pollo…: aparece solo en Despiece">
                          <input
                            type="checkbox"
                            checked={line.carcass}
                            style={{ width: "auto", margin: 0 }}
                            onChange={(e) => updateLine(line.key, e.target.checked
                              ? { carcass: true, productId: "", animalType: line.animalType || line.description }
                              : { carcass: false })}
                          />
                          <span>Para despostar</span>
                        </label>
                      )}
                    </div>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label="Cantidad"
                      value={line.quantity}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    />
                    <select aria-label="Unidad" value={line.unit} onChange={(e) => updateLine(line.key, { unit: e.target.value as "kg" | "unit" })}>
                      <option value="kg">kg</option>
                      <option value="unit">unidad</option>
                    </select>
                    <input
                      type="text"
                      aria-label="Precio unitario"
                      inputMode="decimal"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                    />
                    <strong className="num purchase-line-subtotal">{subtotal > 0 ? formatMoney(subtotal) : "-"}</strong>
                    <button className="danger" aria-label="Quitar ítem" onClick={() => removeLine(line.key)}>✕</button>
                  </div>
                );
              })}
            </div>
            <datalist id="purchase-animal-types">
              {animalTypes.map((name) => <option key={name} value={name} />)}
            </datalist>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              Para una descripción libre (sin elegir un producto de la lista): escribí el nombre y tocá afuera o Esc.
              {canCarcass && " Lo que se desposta (media res, cajones de pollo) marcalo \"Para despostar\": aparece solo en Despiece, no hace falta cargarlo dos veces."}
            </p>

            <div style={{ marginTop: 12 }}>
              <button className="secondary" onClick={addLine}>+ Agregar ítem</button>
            </div>

            <div className="totals" style={{ marginTop: 14 }}>
              <strong>Total <b>{formatMoney(draftTotal)}</b></strong>
            </div>

            <label className="price-tools-check" style={{ marginTop: 14 }}>
              <input type="checkbox" checked={updateCosts} onChange={(e) => setUpdateCosts(e.target.checked)} />
              Actualizar el costo de los productos con los precios de esta compra
            </label>

            <button className="charge-button" style={{ marginTop: 6 }} disabled={busy} onClick={handleCreatePurchase}>
              {busy ? "Registrando…" : "Registrar compra"}
            </button>
          </section>

          <div className="content-grid" style={{ marginTop: 18 }}>
            <section className="panel">
              <div className="panel-title">
                <h2>Compras</h2>
                <span>{purchasesLoading ? "Cargando…" : `${purchases.length} facturas`}</span>
              </div>
              {purchases.map((purchase) => (
                <div key={purchase.id} style={{ marginBottom: 16, opacity: purchase.status === "voided" ? 0.5 : 1 }}>
                  <div className="list-row">
                    {editingDatePurchaseId === purchase.id ? (
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="date" value={editPurchaseDateValue} onChange={(e) => setEditPurchaseDateValue(e.target.value)} />
                        <button disabled={busy} onClick={() => handleSavePurchaseDate(purchase.id)}>Guardar</button>
                        <button className="secondary" disabled={busy} onClick={() => setEditingDatePurchaseId(null)}>Cancelar</button>
                      </span>
                    ) : (
                      <strong style={{ textDecoration: purchase.status === "voided" ? "line-through" : undefined }}>
                        {purchase.purchaseDate}{purchase.invoiceNumber ? ` · Fact. ${purchase.invoiceNumber}` : ""}
                        {purchase.status === "voided" && " · Anulada"}
                      </strong>
                    )}
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="num">Total {formatMoney(purchase.total)}</span>
                      {editingDatePurchaseId !== purchase.id && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            setEditingDatePurchaseId(purchase.id);
                            setEditPurchaseDateValue(purchase.purchaseDate);
                          }}
                        >
                          Editar fecha
                        </button>
                      )}
                      {fiscalOn && purchase.status === "active" && (
                        <button
                          className={purchaseVouchers[purchase.id] ? "link-button" : "secondary"}
                          title="Datos de la factura del proveedor para el Libro IVA Compras (pantalla Contable)"
                          onClick={() => setVoucherFormFor(voucherFormFor === purchase.id ? null : purchase.id)}
                        >
                          {purchaseVouchers[purchase.id] ? "✓ Factura en el Libro IVA" : "Factura (Libro IVA)"}
                        </button>
                      )}
                      {purchase.status === "active" && (
                        <button className="secondary" disabled={busy} onClick={() => handleVoidPurchase(purchase.id)}>Anular</button>
                      )}
                    </span>
                  </div>
                  {fiscalOn && voucherFormFor === purchase.id && selectedSupplier && (
                    <div style={{ margin: "8px 0 12px" }}>
                      {purchaseVouchers[purchase.id] && (
                        <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>
                          Cargada: {voucherTypeLabel(purchaseVouchers[purchase.id].voucherType)} {voucherNumber(purchaseVouchers[purchase.id].pointOfSale, purchaseVouchers[purchase.id].number)}. Podés corregirla acá.
                        </p>
                      )}
                      <PurchaseVoucherForm
                        suppliers={suppliers.map((sp) => ({ id: sp.id, name: sp.name, taxId: taxInfo[sp.id]?.taxId ?? null, taxCondition: taxInfo[sp.id]?.taxCondition ?? null }))}
                        existing={purchaseVouchers[purchase.id] ?? null}
                        purchase={{ purchaseId: purchase.id, date: purchase.purchaseDate, supplierId: selectedSupplier.id, invoiceNumber: purchase.invoiceNumber ?? null, total: purchase.total }}
                        branchId={branchId}
                        onCancel={() => setVoucherFormFor(null)}
                        onSaved={(msg) => {
                          setVoucherFormFor(null);
                          setMessage(msg + " Ya está en el Libro IVA Compras (Contable).");
                          void listVouchersForPurchases(purchases.map((p) => p.id)).then(setPurchaseVouchers);
                          void listSupplierTaxInfo().then(setTaxInfo);
                        }}
                      />
                    </div>
                  )}
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Producto</th>
                        <th>Cantidad</th>
                        <th className="num">Precio</th>
                        <th className="num">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(items[purchase.id] ?? []).map((item) => (
                        <tr key={item.id}>
                          <td>
                            {item.description ?? products.find((p) => p.id === item.productId)?.name ?? "Producto"}
                            {item.carcassAnimalType && (
                              <small className="muted" style={{ display: "block" }}>
                                Para despostar{item.unit === "unit" && item.carcassWeight ? ` · ${item.carcassWeight} kg` : ""} · está en Despiece
                              </small>
                            )}
                          </td>
                          {editingItemId === item.id ? (
                            <>
                              <td>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={editQuantity}
                                  onChange={(e) => setEditQuantity(e.target.value)}
                                  style={{ width: 80 }}
                                />
                                {" "}{item.unit}
                              </td>
                              <td className="num">
                                <input type="text" inputMode="decimal" value={editUnitPrice} onChange={(e) => setEditUnitPrice(e.target.value)} style={{ width: 90 }} />
                              </td>
                              <td className="num">
                                <button disabled={busy} onClick={() => handleSaveEdit(item.id)}>Guardar</button>
                                <button className="secondary" disabled={busy} onClick={() => setEditingItemId(null)}>Cancelar</button>
                              </td>
                            </>
                          ) : (
                            <>
                              <td>{item.quantity} {item.unit}</td>
                              <td className="num">{formatMoney(item.unitPrice)}</td>
                              <td className="num">
                                {formatMoney(item.lineTotal)}{" "}
                                <button
                                  className="secondary"
                                  onClick={() => {
                                    setEditingItemId(item.id);
                                    setEditQuantity(String(item.quantity));
                                    setEditUnitPrice(String(item.unitPrice));
                                  }}
                                >
                                  Editar
                                </button>
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              {purchases.length === 0 && <p className="muted">Todavía no hay compras cargadas.</p>}
            </section>

            <section className="panel">
              <div className="panel-title">
                <h2>Pagos</h2>
              </div>
              <table className="data-table">
                <thead>
                  <tr><th>Fecha</th><th className="num">Monto</th><th>Cuenta</th><th>Nota</th><th></th></tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    editingPaymentId === payment.id ? (
                      <tr key={payment.id}>
                        <td><input type="date" value={editPaymentDate} onChange={(e) => setEditPaymentDate(e.target.value)} /></td>
                        <td>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="num"
                            value={editPaymentAmount}
                            onChange={(e) => setEditPaymentAmount(e.target.value)}
                            style={{ width: 100 }}
                          />
                        </td>
                        <td>
                          <select value={editPaymentAccountId} onChange={(e) => setEditPaymentAccountId(e.target.value)}>
                            <option value="">Pagar desde…</option>
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                          </select>
                        </td>
                        <td><input value={editPaymentNotes} onChange={(e) => setEditPaymentNotes(e.target.value)} /></td>
                        <td>
                          <button disabled={busy} onClick={handleSavePayment}>Guardar</button>{" "}
                          <button className="secondary" disabled={busy} onClick={() => setEditingPaymentId(null)}>Cancelar</button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={payment.id}>
                        <td>{payment.paymentDate}</td>
                        <td className="num">{formatMoney(payment.amount)}</td>
                        <td>{payment.accountName ?? PAYMENT_METHOD_LABELS[payment.paymentMethod]}</td>
                        <td>{payment.notes ?? "-"}</td>
                        <td>
                          <button className="secondary" disabled={busy} onClick={() => startEditPayment(payment)}>Editar</button>{" "}
                          <button className="secondary" disabled={busy} onClick={() => handleDeletePayment(payment.id)}>Borrar</button>
                        </td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
              {payments.length === 0 && <p className="muted">Todavía no hay pagos registrados.</p>}
            </section>
          </div>

          <section className="panel print-area" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Detalle de cuenta corriente</h2>
              <button className="secondary no-print" onClick={handlePrintLedger}>Imprimir</button>
            </div>
            <p className="muted print-only-header">
              {selectedSupplier.name} · {selectedSupplier.category}
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Comprobante</th>
                  <th className="num">{adjustmentsEnabled ? "Debe (compras, recargos)" : "Debe (compras)"}</th>
                  <th className="num">{adjustmentsEnabled ? "Haber (pagos, descuentos)" : "Haber (pagos)"}</th>
                  <th className="num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.key}>
                    <td>{row.date}</td>
                    <td>
                      {row.detail}
                      {row.adjustmentId && (
                        <button className="secondary no-print" style={{ marginLeft: 8 }} disabled={busy} onClick={() => handleDeleteAdjustment(row.adjustmentId!)}>Borrar</button>
                      )}
                      {row.lines && row.lines.length > 0 && (
                        <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
                          {row.lines.map((line, index) => <li key={index}>{line}</li>)}
                        </ul>
                      )}
                    </td>
                    <td className="num">{row.debit > 0 ? formatMoney(row.debit) : "-"}</td>
                    <td className="num">{row.credit > 0 ? formatMoney(row.credit) : "-"}</td>
                    <td className="num">{formatMoney(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ledger.length === 0 && <p className="muted">Todavía no hay movimientos para este proveedor.</p>}
          </section>
        </>
      )}
    </>
  );
}
