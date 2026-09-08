import { Fragment, useEffect, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuth } from "../auth/AuthProvider";
import { can } from "../auth/permissions";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listProductCategories, type ProductCategory } from "../inventory/product-categories-service";
import { useTreasury } from "../shifts/useTreasury";
import { useSuppliers } from "../purchases/useSuppliers";
import { registerSupplierPaymentFromPosShift } from "../purchases/purchases-service";
import { useEmployees } from "../employees/useEmployees";
import { registerEmployeeValeFromPosShift } from "../employees/employees-service";
import { createPosSale, type CreatePosSaleInput } from "./sale-service";
import { addPendingSale, getPendingSales, isNetworkError, markPendingSaleError, removePendingSale, type PendingSale } from "./offline-queue";
import {
  closePosShift,
  getOpenPosShift,
  listPosShiftSales,
  openPosShift,
  voidPosSale,
  type CloseShiftResult,
  type PosShift,
  type PosShiftSale
} from "./pos-shift-service";
import { formatMoney } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { getThermalPrintSettings, isThermalPrinterPaired, isThermalPrintSupported, printBytes, TicketBuilder } from "./thermal-printer";

const UNIT_LABELS: Record<Product["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

interface TicketLine {
  key: string;
  kind: "product" | "manual";
  productId?: string;
  name: string;
  unit: Product["unit"];
  quantity: number;
  unitPrice: number;
}

interface PaymentRow {
  accountId: string;
  amount: string;
}

interface ReceiptLine {
  name: string;
  unit: Product["unit"];
  quantity: number;
  unitPrice: number;
  discountAmount: number;
}

interface ReceiptState {
  items: ReceiptLine[];
  saleDiscount: number;
  saleSurcharge: number;
  total: number;
  soldAt: string;
  paymentSummary: string;
  amountTendered: number | null;
  change: number | null;
  /** true si esta venta se guardó localmente porque no había conexión al
   * cobrar -- todavía no llegó al servidor, se sube sola cuando vuelva
   * internet (ver features/sale/offline-queue.ts). */
  pending?: boolean;
}

const AUTO_PRINT_KEY = "patagonia-auto-print-enabled";

/** Por caja/equipo (localStorage), no por empresa -- cada mostrador puede
 * tener o no una impresora conectada. Por defecto apagado: a quien nunca
 * lo prendió no le tiene que aparecer un diálogo de impresión de la nada. */
function getAutoPrintEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_PRINT_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAutoPrintEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_PRINT_KEY, enabled ? "1" : "0");
  } catch {
    // localStorage lleno o bloqueado -- no es crítico.
  }
}

const LAST_RECEIPT_KEY = "patagonia-pos-last-receipt";

/** El "Último comprobante" vivía solo en el estado de React -- al salir de
 * Mostrador (a Turnos, Productos, lo que sea) el componente se desmonta y
 * se perdía, aunque la venta ya esté guardada. sessionStorage lo mantiene
 * mientras dure la pestaña/turno, sin guardarlo para siempre. */
function loadStoredReceipt(): ReceiptState | null {
  try {
    const raw = sessionStorage.getItem(LAST_RECEIPT_KEY);
    return raw ? (JSON.parse(raw) as ReceiptState) : null;
  } catch {
    return null;
  }
}

function saveStoredReceipt(receipt: ReceiptState | null): void {
  try {
    if (receipt) sessionStorage.setItem(LAST_RECEIPT_KEY, JSON.stringify(receipt));
    else sessionStorage.removeItem(LAST_RECEIPT_KEY);
  } catch {
    // sessionStorage lleno o bloqueado -- no es crítico.
  }
}

export function Sale() {
  const { branchId, branches, activeBranch } = useActiveBranch();
  const { profile } = useAuth();
  const { accounts, adjust } = useTreasury();
  const { suppliers } = useSuppliers();
  const { employees } = useEmployees();
  const canManageTreasury = can(profile, "treasury.manage");

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [shift, setShift] = useState<PosShift | null>(null);
  const [shiftLoading, setShiftLoading] = useState(isSupabaseConfigured);
  const [shiftSales, setShiftSales] = useState<PosShiftSale[]>([]);
  const [showShiftMovements, setShowShiftMovements] = useState(false);
  const [openingCashInput, setOpeningCashInput] = useState("");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [closingCountedCashInput, setClosingCountedCashInput] = useState("");
  const [closeSummary, setCloseSummary] = useState<CloseShiftResult | null>(null);
  const [closeDetail, setCloseDetail] = useState<PosShiftSale[]>([]);

  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [showProductTable, setShowProductTable] = useState(false);
  const [cart, setCart] = useState<TicketLine[]>([]);
  const [itemDiscounts, setItemDiscounts] = useState<Record<string, string>>({});
  const [saleDiscount, setSaleDiscount] = useState("");
  const [saleDiscountMode, setSaleDiscountMode] = useState<"amount" | "percent" | "final">("amount");
  const [saleSurcharge, setSaleSurcharge] = useState("");
  const [saleSurchargeMode, setSaleSurchargeMode] = useState<"amount" | "percent">("amount");
  const [showDiscountForm, setShowDiscountForm] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptState | null>(() => loadStoredReceipt());

  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDesc, setManualDesc] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [manualUnit, setManualUnit] = useState<Product["unit"]>("unit");

  const [payments, setPayments] = useState<PaymentRow[]>([{ accountId: "", amount: "" }]);
  const [cashTendered, setCashTendered] = useState("");
  const [focusRowIndex, setFocusRowIndex] = useState<number | null>(null);
  const accountSelectRefs = useRef<Array<HTMLSelectElement | null>>([]);
  const amountInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const cashTenderedRef = useRef<HTMLInputElement | null>(null);
  const chargeButtonRef = useRef<HTMLButtonElement | null>(null);

  const [showCajaForm, setShowCajaForm] = useState(false);
  const [cajaDirection, setCajaDirection] = useState<"in" | "out">("out");
  const [cajaAccountId, setCajaAccountId] = useState("");
  const [cajaAmount, setCajaAmount] = useState("");
  const [cajaReason, setCajaReason] = useState("");
  const [cajaBusy, setCajaBusy] = useState(false);

  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [supplierAccountId, setSupplierAccountId] = useState("");
  const [supplierAmount, setSupplierAmount] = useState("");
  const [supplierNotes, setSupplierNotes] = useState("");
  const [supplierBusy, setSupplierBusy] = useState(false);

  const [showValeForm, setShowValeForm] = useState(false);
  const [valeEmployeeId, setValeEmployeeId] = useState("");
  const [valeAccountId, setValeAccountId] = useState("");
  const [valeAmount, setValeAmount] = useState("");
  const [valeDetail, setValeDetail] = useState("");
  const [valeBusy, setValeBusy] = useState(false);

  const [thermalPrintBusy, setThermalPrintBusy] = useState(false);
  const [showPrinterSettings, setShowPrinterSettings] = useState(false);
  const [autoPrintEnabled, setAutoPrintEnabled] = useState<boolean>(() => getAutoPrintEnabled());
  const [pendingSales, setPendingSales] = useState<PendingSale[]>(() => getPendingSales());
  const [syncingOffline, setSyncingOffline] = useState(false);

  const grossTotal = cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const itemDiscountTotal = cart.reduce((sum, line) => sum + (parseAmount(itemDiscounts[line.key] || "0") || 0), 0);
  const saleSurchargeRaw = parseAmount(saleSurcharge || "0") || 0;
  const saleSurchargeValue = saleSurchargeMode === "percent" ? Math.round((grossTotal * saleSurchargeRaw) / 100) : saleSurchargeRaw;
  const saleDiscountRaw = parseAmount(saleDiscount || "0") || 0;
  // "final": en vez de calcular qué % o qué $ de descuento hace falta, se
  // escribe directo el precio final al que hay que dejar la venta (p. ej.
  // "cobrale 4000") y el descuento se calcula solo para llegar justo ahí --
  // así no hay que adivinar el % como pasaba antes.
  const saleDiscountValue =
    saleDiscountMode === "percent"
      ? Math.round((grossTotal * saleDiscountRaw) / 100)
      : saleDiscountMode === "final"
        ? Math.max(grossTotal - itemDiscountTotal + saleSurchargeValue - saleDiscountRaw, 0)
        : saleDiscountRaw;
  // Redondeado a pesos enteros -- el resto de la app no maneja centavos, y
  // si no se redondea acá el total que se ve en pantalla no coincide con el
  // que exige el servidor al dividir el pago a mano.
  const total = Math.round(Math.max(grossTotal - itemDiscountTotal - saleDiscountValue + saleSurchargeValue, 0));
  const hasAdjustment = itemDiscountTotal > 0 || saleDiscountValue > 0 || saleSurchargeValue > 0;

  const isSplit = payments.length > 1;
  const singleAccount = !isSplit ? accounts.find((a) => a.id === payments[0]?.accountId) ?? null : null;
  const isSingleCash = !isSplit && singleAccount?.paymentMethod === "cash";
  const tenderedValue = cashTendered ? parseAmount(cashTendered) : null;
  const change = isSingleCash && tenderedValue !== null && Number.isFinite(tenderedValue) ? tenderedValue - total : null;
  const splitPaymentsTotal = payments.reduce((sum, p) => sum + (parseAmount(p.amount || "0") || 0), 0);
  const splitRemaining = total - splitPaymentsTotal;

  const activeShiftSales = shiftSales.filter((s) => !s.voidedAt);
  const shiftTotal = activeShiftSales.reduce((sum, s) => sum + s.total, 0);

  async function reloadProducts() {
    if (!isSupabaseConfigured || !branchId) return;
    setLoading(true);
    try {
      setProducts(await listProductsForBranch(branchId));
    } finally {
      setLoading(false);
    }
  }

  async function reloadShift() {
    if (!isSupabaseConfigured || !branchId) {
      setShiftLoading(false);
      return;
    }
    setShiftLoading(true);
    try {
      const open = await getOpenPosShift(branchId);
      setShift(open);
      setShiftSales(open ? await listPosShiftSales(open.id) : []);
    } finally {
      setShiftLoading(false);
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void listProductCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    void reloadProducts();
    void reloadShift();
    setCloseSummary(null);
    setCloseDetail([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  /** Cuando se agrega una fila de pago (botón "+"), el foco salta directo a
   * su selector de cuenta y la lista se abre sola (showPicker) -- un
   * <select> nativo enfocado no despliega sus opciones por sí solo, así que
   * sin esto "saltar el foco" no se notaba: había que asomarse a que
   * quedaba resaltado. Con la lista ya abierta, las flechas + Enter
   * seleccionan directo. showPicker es relativamente nuevo (Chrome 121+) y
   * puede no existir o tirar error fuera de un gesto del usuario -- por
   * eso el try/catch, el focus solo ya alcanza como respaldo. */
  useEffect(() => {
    if (focusRowIndex === null) return;
    const el = accountSelectRefs.current[focusRowIndex];
    el?.focus();
    try { el?.showPicker?.(); } catch { /* navegador sin soporte, queda solo el foco */ }
    setFocusRowIndex(null);
  }, [focusRowIndex]);

  useEffect(() => {
    saveStoredReceipt(receipt);
  }, [receipt]);

  /** Reintenta mandar al servidor las ventas que quedaron guardadas
   * localmente por falta de conexión. Se corta apenas vuelve a fallar por
   * red (quedan las demás para el próximo intento); si el servidor
   * rechaza una por un motivo real (no de red) se marca como error y se
   * sigue con el resto, para que una venta rara no trabe a las demás. */
  async function syncPendingSales() {
    if (syncingOffline) return;
    const queue = getPendingSales();
    if (queue.length === 0) return;
    setSyncingOffline(true);
    try {
      for (const sale of queue) {
        if (sale.status === "error") continue;
        try {
          await createPosSale(sale.input);
          removePendingSale(sale.localId);
        } catch (err) {
          if (isNetworkError(err)) break;
          markPendingSaleError(sale.localId, err instanceof Error ? err.message : "No se pudo subir esta venta.");
        }
      }
    } finally {
      setPendingSales(getPendingSales());
      setSyncingOffline(false);
      try {
        await reloadShift();
      } catch {
        // no crítico -- si todavía no hay conexión, reintenta solo más tarde.
      }
    }
  }

  useEffect(() => {
    if (getPendingSales().length > 0) void syncPendingSales();
    window.addEventListener("online", syncPendingSales);
    return () => window.removeEventListener("online", syncPendingSales);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pendingSales.length === 0) return;
    const interval = setInterval(() => void syncPendingSales(), 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSales.length]);

  async function handleCajaMovement() {
    setMessage("");
    if (!cajaAccountId) { setMessage("Elegí una cuenta."); return; }
    const amount = parseAmount(cajaAmount || "0") || 0;
    if (!(amount > 0)) { setMessage("El monto debe ser mayor que cero."); return; }
    if (!cajaReason.trim()) { setMessage("Ingresá un motivo."); return; }
    setCajaBusy(true);
    try {
      const accountName = accounts.find((a) => a.id === cajaAccountId)?.name ?? "-";
      const posShiftId = shift && isSupabaseConfigured ? shift.id : undefined;
      await adjust({ accountId: cajaAccountId, amount, direction: cajaDirection, reason: cajaReason.trim(), posShiftId });
      await autoPrintCajaMovement({ direction: cajaDirection, amount, accountName, reason: cajaReason.trim() });
      setCajaAccountId("");
      setCajaAmount("");
      setCajaReason("");
      setShowCajaForm(false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el movimiento de caja.");
    } finally {
      setCajaBusy(false);
    }
  }

  async function handleSupplierPayment() {
    setMessage("");
    if (!shift) { setMessage("No hay un turno abierto."); return; }
    if (!supplierId) { setMessage("Elegí un proveedor."); return; }
    if (!supplierAccountId) { setMessage("Elegí una cuenta."); return; }
    const amount = parseAmount(supplierAmount || "0") || 0;
    if (!(amount > 0)) { setMessage("El monto debe ser mayor que cero."); return; }
    setSupplierBusy(true);
    try {
      const result = await registerSupplierPaymentFromPosShift({
        supplierId,
        posShiftId: shift.id,
        accountId: supplierAccountId,
        amount,
        notes: supplierNotes.trim() || undefined
      });
      const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? "-";
      setMessage(
        `Pago a ${supplierName} registrado.${result.balance !== null ? ` Saldo restante: ${formatMoney(result.balance)}.` : ""}`
      );
      setSupplierId("");
      setSupplierAccountId("");
      setSupplierAmount("");
      setSupplierNotes("");
      setShowSupplierForm(false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el pago al proveedor.");
    } finally {
      setSupplierBusy(false);
    }
  }

  async function handleEmployeeVale() {
    setMessage("");
    if (!shift) { setMessage("No hay un turno abierto."); return; }
    if (!valeEmployeeId) { setMessage("Elegí un empleado."); return; }
    if (!valeAccountId) { setMessage("Elegí una cuenta."); return; }
    const amount = parseAmount(valeAmount || "0") || 0;
    if (!(amount > 0)) { setMessage("El monto debe ser mayor que cero."); return; }
    setValeBusy(true);
    try {
      await registerEmployeeValeFromPosShift({
        employeeId: valeEmployeeId,
        posShiftId: shift.id,
        accountId: valeAccountId,
        amount,
        detail: valeDetail.trim() || undefined
      });
      const employeeName = employees.find((e) => e.id === valeEmployeeId)?.fullName ?? "-";
      setMessage(`Vale de ${employeeName} registrado -- se descuenta de su próxima liquidación de sueldo.`);
      setValeEmployeeId("");
      setValeAccountId("");
      setValeAmount("");
      setValeDetail("");
      setShowValeForm(false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el vale.");
    } finally {
      setValeBusy(false);
    }
  }

  async function handleOpenShift() {
    setMessage("");
    const openingCash = parseAmount(openingCashInput || "0") || 0;
    if (!isSupabaseConfigured) {
      setShift({ id: "demo-shift", openedAt: new Date().toISOString(), openingCash });
      setShiftSales([]);
      setOpeningCashInput("");
      return;
    }
    if (!branchId) return;
    setBusy(true);
    try {
      setShift(await openPosShift(branchId, openingCash));
      setShiftSales([]);
      setOpeningCashInput("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo abrir el turno.");
    } finally {
      setBusy(false);
    }
  }

  const filteredProducts = products
    .filter((p) => p.active ?? true)
    .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.code.toLowerCase() === search.toLowerCase());

  const CATEGORY_LESS_LABEL = "Sin categoría";
  /** Agrupa la tabla de productos por categoría (antes era una sola lista
   * plana con todo mezclado) -- categorías en el orden elegido a mano en
   * Inventario (product_categories.sort_order, ej. "Carne" siempre
   * primero), no alfabético, "Sin categoría" al final. */
  const productGroups = (() => {
    const byId = new Map(categories.map((c) => [c.id, c.name] as const));
    const orderByLabel = new Map(categories.map((c) => [c.name, c.sortOrder] as const));
    const groups = new Map<string, Product[]>();
    for (const product of filteredProducts) {
      const label = (product.categoryId && byId.get(product.categoryId)) || CATEGORY_LESS_LABEL;
      const list = groups.get(label);
      if (list) list.push(product);
      else groups.set(label, [product]);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: "base" }));
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === CATEGORY_LESS_LABEL) return 1;
      if (b === CATEGORY_LESS_LABEL) return -1;
      return (orderByLabel.get(a) ?? 0) - (orderByLabel.get(b) ?? 0);
    });
  })();

  function quickAdd(product: Product, quantity = 1) {
    setMessage("");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setMessage("La cantidad debe ser mayor que cero.");
      return;
    }
    setCart((current) => {
      const existing = current.find((l) => l.key === product.id);
      if (existing) {
        return current.map((l) => (l.key === product.id ? { ...l, quantity: l.quantity + quantity } : l));
      }
      return [...current, { key: product.id, kind: "product", productId: product.id, name: product.name, unit: product.unit, quantity, unitPrice: product.priceRetail }];
    });
    setSearch("");
    setHighlightedIndex(-1);
    // Después de agregar (con el mouse o el teclado) el foco vuelve solo al
    // buscador, para poder escanear o tipear el siguiente producto seguido.
    searchInputRef.current?.focus();
  }

  function addManualItem() {
    setMessage("");
    const desc = manualDesc.trim();
    const price = parseAmount(manualPrice || "0") || 0;
    const qty = Number(manualQty || "1");
    if (!desc) { setMessage("Ingresá una descripción para el artículo."); return; }
    if (!(price >= 0)) { setMessage("Precio inválido."); return; }
    if (!(qty > 0)) { setMessage("Cantidad inválida."); return; }
    const key = `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setCart((current) => [...current, { key, kind: "manual", name: desc, unit: manualUnit, quantity: qty, unitPrice: price }]);
    setManualDesc("");
    setManualPrice("");
    setManualQty("1");
    setManualUnit("unit");
    setShowManualForm(false);
  }

  /**
   * Etiquetas de balanza Kretz: EAN-13 "2" + PLU (5 dígitos) + peso en gramos
   * (5 dígitos) + dígito verificador. Ej. 2000102004720 = PLU 00102, peso
   * 00472 = 0,472 kg. El precio no se lee del código -- siempre se usa el
   * precio actual del producto en el sistema.
   */
  function parseWeightBarcode(code: string): { plu: string; weightKg: number } | null {
    if (!/^\d{13}$/.test(code) || code[0] !== "2") return null;
    const plu = String(parseInt(code.slice(2, 7), 10));
    const weightGrams = parseInt(code.slice(7, 12), 10);
    if (!Number.isFinite(weightGrams) || weightGrams <= 0) return null;
    return { plu, weightKg: weightGrams / 1000 };
  }

  const searchMatches = search.trim() ? filteredProducts.slice(0, 8) : [];
  // Con texto buscado siempre queda un renglón resaltado (el primero, salvo
  // que se haya navegado con las flechas) para que Enter agregue directo.
  const activeMatchIndex = searchMatches.length === 0 ? -1 : highlightedIndex >= 0 ? highlightedIndex : 0;

  /** El lector de código de barra "tipea" el código y Enter en este mismo
   * buscador. Las flechas ↑↓ navegan la lista de resultados y Enter agrega
   * el resaltado -- todo el alta de productos se puede hacer sin mouse. */
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (searchMatches.length > 0) setHighlightedIndex((i) => Math.min((i < 0 ? 0 : i) + 1, searchMatches.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (searchMatches.length > 0) setHighlightedIndex((i) => Math.max((i < 0 ? 0 : i) - 1, 0));
      return;
    }
    if (e.key === "Escape") {
      setSearch("");
      setHighlightedIndex(-1);
      return;
    }
    if (e.key !== "Enter") return;
    const raw = search.trim();
    if (!raw) return;

    const weight = parseWeightBarcode(raw);
    if (weight) {
      const match = products.find((p) => (p.active ?? true) && p.code === weight.plu);
      if (match) {
        quickAdd(match, weight.weightKg);
        return;
      }
    }

    const exactCode = products.find((p) => (p.active ?? true) && p.code.toLowerCase() === raw.toLowerCase());
    if (exactCode) {
      quickAdd(exactCode);
      return;
    }

    const picked = searchMatches[activeMatchIndex];
    if (picked) {
      quickAdd(picked);
      return;
    }

    setMessage("No se encontró ningún producto con ese código.");
  }

  function removeFromCart(key: string) {
    setCart((current) => current.filter((l) => l.key !== key));
    setItemDiscounts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function updateCartQuantity(key: string, raw: string) {
    const parsed = Number(raw);
    setCart((current) =>
      current.map((l) => {
        if (l.key !== key) return l;
        // Los productos por kg se cargan con precisión de gramos (0.001); los
        // que son por unidad o caja no tienen sentido en fracciones.
        const quantity = l.unit === "kg" ? parsed : Math.round(parsed);
        return { ...l, quantity };
      })
    );
  }

  function clearTicket() {
    setCart([]);
    setItemDiscounts({});
    setSaleDiscount("");
    setSaleDiscountMode("amount");
    setSaleSurcharge("");
    setSaleSurchargeMode("amount");
    setShowDiscountForm(false);
    setPayments([{ accountId: "", amount: "" }]);
    setCashTendered("");
    setMessage("");
    searchInputRef.current?.focus();
  }

  /** Agrega una fila de pago y le pasa el foco a su selector de cuenta --
   * ver el useEffect de focusRowIndex más arriba. */
  function addPaymentRow() {
    setFocusRowIndex(payments.length);
    setPayments((current) => [...current, { accountId: "", amount: "" }]);
  }

  function removePaymentRow(index: number) {
    setPayments((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));
  }

  function updatePaymentRow(index: number, field: "accountId" | "amount", value: string) {
    setPayments((current) => current.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  }

  async function checkout() {
    if (cart.length === 0 || !shift) return;

    if (activeBranch?.sales_mode === "turnos") {
      const confirmed = window.confirm(
        "Esta sucursal está configurada para vender por Turnos. ¿Seguro que querés cobrar por Mostrador acá también?"
      );
      if (!confirmed) return;
    }

    if (!isSplit) {
      if (!payments[0]?.accountId) {
        setMessage("Elegí de qué cuenta cobrás.");
        return;
      }
      if (isSingleCash && (tenderedValue === null || !Number.isFinite(tenderedValue) || tenderedValue < total)) {
        setMessage("Ingresá cuánto te dio el cliente (tiene que alcanzar para el total).");
        return;
      }
    } else {
      if (payments.some((p) => !p.accountId)) {
        setMessage("Elegí la cuenta en cada medio de pago.");
        return;
      }
      if (Math.abs(splitRemaining) > 0.5) {
        setMessage(`Los medios de pago no suman el total — falta ${formatMoney(splitRemaining)}.`);
        return;
      }
    }

    setBusy(true);
    setMessage("");
    try {
      const itemDiscountsSnapshot: Record<string, number> = {};
      cart.forEach((l) => { itemDiscountsSnapshot[l.key] = parseAmount(itemDiscounts[l.key] || "0") || 0; });

      const receiptLines: ReceiptLine[] = cart.map((l) => ({
        name: l.name, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: itemDiscountsSnapshot[l.key]
      }));
      const paymentSummary = isSplit
        ? payments.map((p) => accounts.find((a) => a.id === p.accountId)?.name ?? "-").join(" + ")
        : singleAccount?.name ?? "-";

      if (!isSupabaseConfigured) {
        const demoReceipt: ReceiptState = {
          items: receiptLines,
          saleDiscount: saleDiscountValue,
          saleSurcharge: saleSurchargeValue,
          total,
          soldAt: new Date().toISOString(),
          paymentSummary,
          amountTendered: tenderedValue,
          change
        };
        setReceipt(demoReceipt);
        clearTicket();
        setMessage("Venta registrada (modo demo, no se descuenta stock real).");
        await autoPrintReceipt();
        return;
      }
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      const itemsPayload = cart.map((l) => ({
        productId: l.kind === "product" ? l.productId : undefined,
        description: l.kind === "manual" ? l.name : undefined,
        unitPrice: l.kind === "manual" ? l.unitPrice : undefined,
        quantity: l.quantity,
        discountAmount: itemDiscountsSnapshot[l.key]
      }));
      const paymentsPayload = isSplit
        ? payments.map((p) => ({ accountId: p.accountId, amount: parseAmount(p.amount || "0") || 0 }))
        : [{ accountId: payments[0].accountId, amount: total }];

      const salePayload: CreatePosSaleInput = {
        branchId,
        posShiftId: shift.id,
        items: itemsPayload,
        payments: paymentsPayload,
        discountAmount: saleDiscountValue,
        surchargeAmount: saleSurchargeValue
      };

      // Si no hay conexión, createPosSale rechaza por una falla de red (no
      // un rechazo real del servidor) -- en vez de cortar la venta, queda
      // guardada tal cual para reintentar sola (ver offline-queue.ts) y el
      // cajero sigue como si hubiera salido bien, con el total calculado
      // acá mismo ya que no hay respuesta del servidor todavía.
      let saleTotal = total;
      let queuedOffline = false;
      try {
        const result = await createPosSale(salePayload);
        saleTotal = result.total;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        addPendingSale(salePayload);
        setPendingSales(getPendingSales());
        queuedOffline = true;
      }

      const newReceipt: ReceiptState = {
        items: receiptLines,
        saleDiscount: saleDiscountValue,
        saleSurcharge: saleSurchargeValue,
        total: saleTotal,
        soldAt: new Date().toISOString(),
        paymentSummary,
        amountTendered: tenderedValue,
        change,
        pending: queuedOffline
      };
      setReceipt(newReceipt);
      clearTicket();
      // El ticket tiene que salir sí o sí -- se imprime antes de refrescar
      // stock/turno, y esos dos refrescos van en su propio try/catch para
      // que un problema de red ahí (la venta ya está guardada, o ya quedó
      // en la cola offline) no tape el ticket ni dispare el mensaje de "no
      // se pudo registrar la venta" sobre una venta que en realidad sí se
      // cobró.
      await autoPrintReceipt();
      if (queuedOffline) {
        setMessage("Sin conexión: la venta se guardó en este equipo y se sube sola apenas vuelva internet.");
      } else {
        try {
          await reloadProducts();
          await reloadShift();
        } catch {
          // no crítico -- la venta y el ticket ya están hechos, se van a
          // refrescar solos la próxima vez que cambie algo.
        }
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar la venta.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVoidSale(saleId: string) {
    if (!window.confirm("¿Seguro que querés anular esta venta? Se revierte el stock y no se puede deshacer.")) return;
    setMessage("");
    setBusy(true);
    try {
      if (!isSupabaseConfigured) {
        setShiftSales((current) => current.map((s) => (s.id === saleId ? { ...s, voidedAt: new Date().toISOString() } : s)));
        return;
      }
      await voidPosSale(saleId);
      await reloadShift();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo anular la venta.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCloseShift() {
    if (!shift) return;
    setBusy(true);
    setMessage("");
    try {
      const countedCash = closingCountedCashInput ? parseAmount(closingCountedCashInput) : undefined;
      if (!isSupabaseConfigured) {
        const cashSalesDemo = activeShiftSales.reduce((sum, s) => sum + s.total, 0);
        const expectedCash = shift.openingCash + cashSalesDemo;
        setCloseSummary({
          total: shiftTotal,
          byAccount: [],
          expectedCash,
          countedCash: countedCash ?? null,
          difference: countedCash !== undefined ? countedCash - expectedCash : null
        });
        setCloseDetail(activeShiftSales);
        setShift(null);
        setShiftSales([]);
        setShowCloseConfirm(false);
        setClosingCountedCashInput("");
        return;
      }
      const detailSnapshot = activeShiftSales;
      const result = await closePosShift(shift.id, countedCash);
      setCloseSummary(result);
      setCloseDetail(detailSnapshot);
      setShowCloseConfirm(false);
      setClosingCountedCashInput("");
      await reloadShift();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cerrar el turno.");
    } finally {
      setBusy(false);
    }
  }

  /** window.print() abre un diálogo modal en la mayoría de los navegadores
   * -- se queda esperando ahí hasta que el cajero lo cierra -- así que
   * pedirlo dos veces seguidas imprime dos copias, una por diálogo. */
  function handlePrint(copies = 1) {
    for (let i = 0; i < copies; i++) window.print();
  }

  function buildReceiptTicket(receiptToPrint: ReceiptState): Uint8Array {
    const settings = getThermalPrintSettings();
    const branchName = branches.find((b) => b.id === branchId)?.name;
    const t = new TicketBuilder();
    if (settings.font !== "auto") t.font(settings.font);
    t.bodySize(settings, true);
    t.align("center").bold(true).line("COMPROBANTE INTERNO").bold(false);
    if (branchName) t.line(branchName);
    t.align("left").separator("-", settings.lineWidth);
    t.line(new Date(receiptToPrint.soldAt).toLocaleString("es-AR"));
    t.separator("-", settings.lineWidth);
    for (const item of receiptToPrint.items) {
      const lineTotal = item.quantity * item.unitPrice - item.discountAmount;
      t.line(item.name);
      t.line(`  ${item.quantity} ${UNIT_LABELS[item.unit]} x ${formatMoney(item.unitPrice)} = ${formatMoney(lineTotal)}`);
    }
    t.separator("-", settings.lineWidth);
    if (receiptToPrint.saleDiscount > 0) t.line(`Descuento: -${formatMoney(receiptToPrint.saleDiscount)}`);
    if (receiptToPrint.saleSurcharge > 0) t.line(`Recargo: +${formatMoney(receiptToPrint.saleSurcharge)}`);
    t.bodySize(settings, false);
    t.bold(true).doubleSize(true).line(`TOTAL ${formatMoney(receiptToPrint.total)}`).doubleSize(false).bold(false);
    t.bodySize(settings, true);
    t.line(`Pago: ${receiptToPrint.paymentSummary}`);
    if (receiptToPrint.amountTendered !== null) {
      t.line(`Recibido: ${formatMoney(receiptToPrint.amountTendered)}  Vuelto: ${formatMoney(Math.max(receiptToPrint.change ?? 0, 0))}`);
    }
    t.feed(1).align("center").line("Gracias por su compra");
    t.bodySize(settings, false);
    t.cut();
    return t.build();
  }

  async function handleThermalPrint() {
    if (!receipt) return;
    setMessage("");
    setThermalPrintBusy(true);
    try {
      await printBytes(buildReceiptTicket(receipt));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo imprimir en la impresora térmica.");
    } finally {
      setThermalPrintBusy(false);
    }
  }


  /** Se imprime solo al cobrar -- pero SOLO si el local activó "Imprimir
   * automáticamente" en Config. impresora. Sin ese interruptor, a quien no
   * tiene impresora nunca le aparece un diálogo de impresión de la nada;
   * quien sí imprime lo prende una vez y listo. Antes esto intentaba la
   * impresora térmica por USB primero -- forzaba a elegir el dispositivo de
   * una lista genérica de USB sin nombres claros (imposible para alguien
   * sin conocimientos técnicos, y no escala a mil clientes con mil
   * impresoras distintas). Ahora el único camino automático es el diálogo
   * de impresión normal del navegador, que ya muestra la impresora por su
   * nombre real y respeta el papel que esa impresora tenga configurado en
   * Windows. La térmica por USB sigue disponible como botón manual aparte,
   * para quien la quiera igual. */
  async function autoPrintReceipt() {
    if (!autoPrintEnabled) return;
    // Pequeña espera para que el DOM termine de pintar el comprobante nuevo
    // antes de que el navegador lo capture para imprimir.
    setTimeout(() => window.print(), 150);
  }

  /** Comprobante chico para cada Ingreso/Egreso de caja -- así queda algo en
   * papel cada vez que entra o sale plata del cajón, no solo al cerrar. */
  async function autoPrintCajaMovement(mov: { direction: "in" | "out"; amount: number; accountName: string; reason: string }) {
    // Esto no tiene un comprobante en pantalla para caer al diálogo del
    // navegador como el ticket de venta -- si no hay térmica emparejada
    // directamente no hay dónde imprimir, así que no tiene sentido
    // intentar (y menos mostrar un error cada vez que no está emparejada).
    if (!(await isThermalPrinterPaired())) return;
    try {
      const t = new TicketBuilder();
      t.align("center").bold(true).line(mov.direction === "in" ? "INGRESO DE CAJA" : "EGRESO DE CAJA").bold(false);
      t.align("left").separator();
      t.line(new Date().toLocaleString("es-AR"));
      t.line(`Cuenta: ${mov.accountName}`);
      t.bold(true).doubleSize(true).line(`${mov.direction === "in" ? "+" : "-"} ${formatMoney(mov.amount)}`).doubleSize(false).bold(false);
      t.line(`Motivo: ${mov.reason}`);
      t.cut();
      await printBytes(t.build());
    } catch (err) {
      setMessage(err instanceof Error ? `Movimiento registrado, pero no se pudo imprimir: ${err.message}` : "Movimiento registrado, pero no se pudo imprimir el ticket.");
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">VENTA</p>
          <h1>Mostrador</h1>
          <p className="muted">Escaneá la etiqueta de la balanza (carga el peso solo) o buscá por nombre para lo que no tiene código.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}

      {pendingSales.length > 0 && (
        <div className="message warning" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span>
            {pendingSales.length === 1 ? "1 venta" : `${pendingSales.length} ventas`} guardada{pendingSales.length === 1 ? "" : "s"} en este equipo, pendiente{pendingSales.length === 1 ? "" : "s"} de subir al servidor
            {pendingSales.some((s) => s.status === "error") && " (alguna quedó con error, revisala)"}.
          </span>
          <button className="secondary" disabled={syncingOffline} onClick={() => void syncPendingSales()}>
            {syncingOffline ? "Sincronizando…" : "Sincronizar ahora"}
          </button>
        </div>
      )}

      {shiftLoading ? (
        <p className="muted">Cargando turno…</p>
      ) : !shift ? (
        <section className="panel">
          <div className="panel-title">
            <h2>No hay un turno abierto</h2>
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>
            Abrí un turno para empezar a cobrar. Las ventas se van sumando y recién se cargan a Tesorería cuando cerrás el turno.
          </p>
          <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
            <label className="muted">Fondo inicial de caja $</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={openingCashInput}
              onChange={(e) => setOpeningCashInput(e.target.value)}
              style={{ width: 110 }}
            />
            <button disabled={busy} onClick={handleOpenShift}>{busy ? "Abriendo…" : "Abrir turno"}</button>
          </div>
        </section>
      ) : (
        <div className="content-grid" style={{ alignItems: "start" }}>
          <section className="panel">
            <div className="pos-search-wrap">
              <input
                ref={searchInputRef}
                type="text"
                className="pos-search"
                placeholder="Escaneá o escribí el nombre / código del producto…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setHighlightedIndex(-1); }}
                onKeyDown={handleSearchKeyDown}
                autoFocus
              />
              {searchMatches.length > 0 && (
                <div className="pos-dropdown">
                  {searchMatches.map((product, idx) => (
                    <button
                      key={product.id}
                      type="button"
                      className={`pos-dropdown-item${idx === activeMatchIndex ? " active" : ""}`}
                      onMouseEnter={() => setHighlightedIndex(idx)}
                      onClick={() => quickAdd(product)}
                    >
                      <span>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></span>
                      <strong>{formatMoney(product.priceRetail)}</strong>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="pos-toolbar">
              <button className={`pos-toolbar-btn${showManualForm ? " active" : ""}`} onClick={() => setShowManualForm((v) => !v)}>
                + Vender algo sin código
              </button>
              <button className={`pos-toolbar-btn${showProductTable ? " active" : ""}`} onClick={() => setShowProductTable((v) => !v)}>
                {showProductTable ? "Ocultar tabla de productos" : "Ver tabla de productos"}
              </button>
              <button className={`pos-toolbar-btn${showPrinterSettings ? " active" : ""}`} onClick={() => setShowPrinterSettings((v) => !v)}>
                {showPrinterSettings ? "Ocultar config. impresora" : "Config. impresora"}
              </button>
            </div>

            {showPrinterSettings && (
              <div className="pos-manual-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                  <input
                    type="checkbox"
                    checked={autoPrintEnabled}
                    onChange={(e) => {
                      setAutoPrintEnabled(e.target.checked);
                      saveAutoPrintEnabled(e.target.checked);
                    }}
                  />
                  Imprimir el comprobante automáticamente al cobrar
                </label>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Al cobrar se abre el diálogo de impresión de Windows -- ahí elegís tu impresora por su nombre y confirmás "Imprimir". Por seguridad, ningún navegador imprime sin ese paso (existe una forma de saltearlo por completo, preguntame si te interesa). Si no tenés impresora, dejalo apagado y nunca te va a aparecer nada solo.
                </p>
              </div>
            )}

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
                  type="number"
                  min={manualUnit === "kg" ? "0.001" : "1"}
                  step={manualUnit === "kg" ? "0.001" : "1"}
                  placeholder="Cant."
                  value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                  style={{ width: 70 }}
                />
                <select value={manualUnit} onChange={(e) => setManualUnit(e.target.value as Product["unit"])}>
                  <option value="unit">Unidad</option>
                  <option value="kg">Kg</option>
                </select>
                <button onClick={addManualItem}>Agregar</button>
                <button className="secondary" onClick={() => setShowManualForm(false)}>Cancelar</button>
              </div>
            )}

            {showProductTable && (
              <div className="pos-browse-card">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Producto</th>
                      <th className="num">Precio</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {productGroups.map(([categoryLabel, categoryProducts]) => (
                      <Fragment key={categoryLabel}>
                        <tr>
                          <td colSpan={4} className="pos-category-row">{categoryLabel}</td>
                        </tr>
                        {categoryProducts.map((product) => (
                          <tr key={product.id}>
                            <td>{product.code}</td>
                            <td>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></td>
                            <td className="num">{formatMoney(product.priceRetail)}</td>
                            <td><button className="secondary" onClick={() => quickAdd(product)}>+ Agregar</button></td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                    {filteredProducts.length === 0 && (
                      <tr><td colSpan={4} className="muted">No hay productos que coincidan.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {cart.length === 0 ? (
              <div className="pos-cart-empty">Escaneá o buscá un producto para empezar el ticket.</div>
            ) : (
              <div className="pos-cart">
                {cart.map((line) => (
                  <div className="pos-cart-row" key={line.key}>
                    <div className="name">
                      {line.name}
                      <small>
                        {line.kind === "manual" ? "Manual · " : ""}{formatMoney(line.unitPrice)}{line.unit === "kg" ? " /kg" : ` /${UNIT_LABELS[line.unit]}`}
                      </small>
                    </div>
                    <input
                      type="number"
                      className="pos-qty-input"
                      min={line.unit === "kg" ? "0.001" : "1"}
                      step={line.unit === "kg" ? "0.001" : "1"}
                      value={line.quantity}
                      onChange={(e) => updateCartQuantity(line.key, e.target.value)}
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      className="pos-discount-input"
                      placeholder="Desc. $"
                      value={itemDiscounts[line.key] ?? ""}
                      onChange={(e) => setItemDiscounts({ ...itemDiscounts, [line.key]: e.target.value })}
                    />
                    <span className="pos-line-total">
                      {formatMoney(line.quantity * line.unitPrice - (parseAmount(itemDiscounts[line.key] || "0") || 0))}
                    </span>
                    <button className="pos-remove-btn" onClick={() => removeFromCart(line.key)} aria-label="Quitar" title="Quitar">×</button>
                  </div>
                ))}
              </div>
            )}

            {cart.length > 0 && (
              <>
                <div className="pos-toolbar" style={{ marginTop: 10 }}>
                  <button
                    className={`pos-toolbar-btn${showDiscountForm || hasAdjustment ? " active" : ""}`}
                    onClick={() => setShowDiscountForm((v) => !v)}
                  >
                    {hasAdjustment ? "Descuento / recargo" : "+ Descuento o recargo"}
                  </button>
                  <button className="pos-toolbar-btn" onClick={clearTicket}>Cancelar ticket</button>
                </div>

                {showDiscountForm && (
                  <div className="pos-adjust-card">
                    <div className="pos-adjust-row">
                      <label>Descuento</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder={saleDiscountMode === "final" ? "Precio final" : "0"}
                        value={saleDiscount}
                        onChange={(e) => setSaleDiscount(e.target.value)}
                      />
                      <select value={saleDiscountMode} onChange={(e) => setSaleDiscountMode(e.target.value as "amount" | "percent" | "final")}>
                        <option value="amount">$ off</option>
                        <option value="percent">% off</option>
                        <option value="final">Dejarlo en $</option>
                      </select>
                      <label>Recargo</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={saleSurcharge}
                        onChange={(e) => setSaleSurcharge(e.target.value)}
                      />
                      <select value={saleSurchargeMode} onChange={(e) => setSaleSurchargeMode(e.target.value as "amount" | "percent")}>
                        <option value="amount">$</option>
                        <option value="percent">%</option>
                      </select>
                    </div>
                  </div>
                )}
                {hasAdjustment && (
                  <p className="pos-subtotal-line" style={{ marginTop: showDiscountForm ? 0 : 10 }}>
                    Subtotal {formatMoney(grossTotal)}
                    {(itemDiscountTotal > 0 || saleDiscountValue > 0) && ` · Descuentos -${formatMoney(itemDiscountTotal + saleDiscountValue)}`}
                    {saleSurchargeValue > 0 && ` · Recargo +${formatMoney(saleSurchargeValue)}`}
                  </p>
                )}

                <div className="pos-payment-card">
                  <p className="pos-section-label">Forma de pago</p>
                  {payments.map((p, i) => (
                    <div className="pos-payment-row" key={i}>
                      <select
                        ref={(el) => { accountSelectRefs.current[i] = el; }}
                        value={p.accountId}
                        onChange={(e) => {
                          updatePaymentRow(i, "accountId", e.target.value);
                          const chosen = accounts.find((a) => a.id === e.target.value);
                          requestAnimationFrame(() => {
                            if (isSplit) amountInputRefs.current[i]?.focus();
                            else if (chosen?.paymentMethod === "cash") cashTenderedRef.current?.focus();
                            else chargeButtonRef.current?.focus();
                          });
                        }}
                      >
                        <option value="">¿Con qué te paga?</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                      {isSplit && (
                        <input
                          ref={(el) => { amountInputRefs.current[i] = el; }}
                          type="text"
                          inputMode="decimal"
                          placeholder="Monto"
                          value={p.amount}
                          onChange={(e) => updatePaymentRow(i, "amount", e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            e.preventDefault();
                            const isLast = i === payments.length - 1;
                            if (!isLast) accountSelectRefs.current[i + 1]?.focus();
                            else if (Math.abs(splitRemaining) <= 0.5) chargeButtonRef.current?.focus();
                            else addPaymentRow();
                          }}
                        />
                      )}
                      {isSplit && payments.length > 1 && (
                        <button className="pos-toolbar-btn" onClick={() => removePaymentRow(i)}>Quitar medio</button>
                      )}
                    </div>
                  ))}

                  {isSingleCash && (
                    <div className="pos-payment-row">
                      <input
                        ref={cashTenderedRef}
                        type="text"
                        inputMode="decimal"
                        placeholder="Recibiste ($)"
                        value={cashTendered}
                        onChange={(e) => setCashTendered(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          chargeButtonRef.current?.focus();
                        }}
                      />
                      {change !== null && (
                        <strong className={`pos-change ${change < 0 ? "num-negative" : "num-positive"}`}>
                          Vuelto {formatMoney(Math.max(change, 0))}
                        </strong>
                      )}
                    </div>
                  )}

                  <div style={{ marginTop: 10, textAlign: "right" }}>
                    {!isSplit ? (
                      <button className="pos-toolbar-btn" onClick={addPaymentRow}>+ Dividir el pago en más de un medio</button>
                    ) : (
                      <>
                        <p className="muted" style={{ margin: "0 0 8px" }}>
                          {Math.abs(splitRemaining) <= 0.5 ? "Los medios de pago cubren el total." : `Falta pagar ${formatMoney(splitRemaining)}`}
                        </p>
                        <button className="pos-toolbar-btn" onClick={addPaymentRow}>+ Agregar otro medio de pago</button>
                      </>
                    )}
                  </div>
                </div>

                <div className="pos-total-bar">
                  <div>
                    <p className="pos-total-label">Total a cobrar</p>
                    <strong className="pos-total-value">{formatMoney(total)}</strong>
                  </div>
                  <button
                    ref={chargeButtonRef}
                    className="charge-button pos-charge-btn"
                    disabled={busy}
                    onClick={checkout}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); checkout(); } }}
                  >
                    {busy ? "Cobrando…" : (<>Cobrar <kbd>Enter</kbd></>)}
                  </button>
                </div>
              </>
            )}
          </section>

          <aside className="panel shift-card" style={{ position: "sticky", top: 18 }}>
            <div className="panel-title">
              <h2>Turno</h2>
              <span className="muted" style={{ fontSize: 12 }}>desde {new Date(shift.openedAt).toLocaleTimeString("es-AR")}</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
              <div style={{ background: "#f8f9fb", borderRadius: 12, padding: "12px 14px" }}>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>Ventas</p>
                <strong style={{ fontSize: 22 }}>{activeShiftSales.length}</strong>
              </div>
              <div style={{ background: "#f8f9fb", borderRadius: 12, padding: "12px 14px" }}>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>Acumulado</p>
                <strong style={{ fontSize: 22 }}>{formatMoney(shiftTotal)}</strong>
              </div>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              <button className="pos-toolbar-btn" onClick={() => setShowShiftMovements((v) => !v)}>
                {showShiftMovements ? "Ocultar movimientos" : "Ver movimientos"}
              </button>
              {canManageTreasury && (
                <button className="pos-toolbar-btn" onClick={() => setShowCajaForm((v) => !v)}>
                  {showCajaForm ? "Cancelar movimiento de caja" : "+ Movimiento de caja"}
                </button>
              )}
              {canManageTreasury && (
                <button className="pos-toolbar-btn" onClick={() => setShowSupplierForm((v) => !v)}>
                  {showSupplierForm ? "Cancelar pago a proveedor" : "+ Pago a proveedor"}
                </button>
              )}
              {canManageTreasury && (
                <button className="pos-toolbar-btn" onClick={() => setShowValeForm((v) => !v)}>
                  {showValeForm ? "Cancelar vale a empleado" : "+ Vale a empleado"}
                </button>
              )}
              {!showCloseConfirm && (
                <button
                  className="pos-toolbar-btn"
                  onClick={() => {
                    if (pendingSales.length > 0) {
                      setMessage("Todavía hay ventas sin subir al servidor -- sincronizalas antes de cerrar el turno para que el total esté completo.");
                      return;
                    }
                    setShowCloseConfirm(true);
                  }}
                >
                  Cerrar turno
                </button>
              )}
            </div>

            {showShiftMovements && (
              shiftSales.length > 0 ? (
                <table className="data-table" style={{ marginTop: 14 }}>
                  <thead>
                    <tr><th>Hora</th><th className="num">Total</th><th></th><th></th></tr>
                  </thead>
                  <tbody>
                    {shiftSales.map((s) => (
                      <tr key={s.id} style={s.voidedAt ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                        <td>{new Date(s.createdAt).toLocaleTimeString("es-AR")}</td>
                        <td className="num">{formatMoney(s.total)}</td>
                        <td>{s.voidedAt ? "Anulada" : ""}</td>
                        <td>
                          {!s.voidedAt && (
                            <button className="secondary" disabled={busy} onClick={() => handleVoidSale(s.id)}>Anular</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted" style={{ marginTop: 14 }}>Todavía no hay ventas en este turno.</p>
              )
            )}

            {canManageTreasury && showCajaForm && (
              <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
                <select value={cajaDirection} onChange={(e) => setCajaDirection(e.target.value as "in" | "out")}>
                  <option value="out">Egreso</option>
                  <option value="in">Ingreso</option>
                </select>
                <select value={cajaAccountId} onChange={(e) => setCajaAccountId(e.target.value)}>
                  <option value="">Cuenta…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Monto"
                  value={cajaAmount}
                  onChange={(e) => setCajaAmount(e.target.value)}
                />
                <input
                  placeholder="Motivo"
                  value={cajaReason}
                  onChange={(e) => setCajaReason(e.target.value)}
                />
                <button disabled={cajaBusy} onClick={handleCajaMovement}>{cajaBusy ? "Guardando…" : "Registrar"}</button>
              </div>
            )}

            {canManageTreasury && showSupplierForm && (
              <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Proveedor…</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <select value={supplierAccountId} onChange={(e) => setSupplierAccountId(e.target.value)}>
                  <option value="">Pagar desde…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Monto"
                  value={supplierAmount}
                  onChange={(e) => setSupplierAmount(e.target.value)}
                />
                <input
                  placeholder="Nota (opcional)"
                  value={supplierNotes}
                  onChange={(e) => setSupplierNotes(e.target.value)}
                />
                <button disabled={supplierBusy} onClick={handleSupplierPayment}>{supplierBusy ? "Guardando…" : "Registrar"}</button>
              </div>
            )}

            {canManageTreasury && showValeForm && (
              <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
                <select value={valeEmployeeId} onChange={(e) => setValeEmployeeId(e.target.value)}>
                  <option value="">Empleado…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.fullName}</option>
                  ))}
                </select>
                <select value={valeAccountId} onChange={(e) => setValeAccountId(e.target.value)}>
                  <option value="">Sale de…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Monto"
                  value={valeAmount}
                  onChange={(e) => setValeAmount(e.target.value)}
                />
                <input
                  placeholder="Detalle (opcional)"
                  value={valeDetail}
                  onChange={(e) => setValeDetail(e.target.value)}
                />
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>Se descuenta de la próxima liquidación de sueldo del empleado.</p>
                <button disabled={valeBusy} onClick={handleEmployeeVale}>{valeBusy ? "Guardando…" : "Registrar"}</button>
              </div>
            )}

            {showCloseConfirm && (
              <div style={{ marginTop: 14 }}>
                <p className="muted">¿Cerrar el turno y cargar {formatMoney(shiftTotal)} a Tesorería? No se puede deshacer.</p>
                <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                  <label className="muted" style={{ fontSize: 13 }}>Efectivo contado (arqueo) $</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={closingCountedCashInput}
                    onChange={(e) => setClosingCountedCashInput(e.target.value)}
                  />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button disabled={busy} onClick={handleCloseShift}>{busy ? "Cerrando…" : "Confirmar cierre"}</button>
                  <button className="secondary" onClick={() => setShowCloseConfirm(false)}>Cancelar</button>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {receipt && (
        <section className="panel print-area receipt-ticket" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Último comprobante</h2>
            <div className="no-print ticket-actions">
              <button className="ticket-action-btn" onClick={() => handlePrint()}>Reimprimir</button>
              <button className="ticket-action-btn" onClick={() => handlePrint(2)}>2 copias</button>
              {isThermalPrintSupported() && (
                <button className="ticket-action-btn" disabled={thermalPrintBusy} onClick={handleThermalPrint}>
                  {thermalPrintBusy ? "Imprimiendo…" : "Térmica"}
                </button>
              )}
            </div>
          </div>

          <div className="ticket-header">
            <strong>{branches.find((b) => b.id === branchId)?.name ?? "Patagonia OS"}</strong>
            <p>Comprobante interno · no válido como factura</p>
            <p>{new Date(receipt.soldAt).toLocaleString("es-AR")}</p>
            {receipt.pending && <p className="no-print" style={{ color: "#8a4b00", fontWeight: 700 }}>⏳ Guardada sin conexión, pendiente de subir</p>}
          </div>

          <div className="ticket-rule" />
          <div className="ticket-items">
            {receipt.items.map((item, idx) => (
              <div className="ticket-item" key={idx}>
                <span className="ticket-item-name">{item.name}</span>
                <span className="ticket-item-detail">
                  <span>{item.quantity} {UNIT_LABELS[item.unit]} x {formatMoney(item.unitPrice)}</span>
                  <b>{formatMoney(item.quantity * item.unitPrice - item.discountAmount)}</b>
                </span>
              </div>
            ))}
          </div>
          <div className="ticket-rule" />

          {(receipt.saleDiscount > 0 || receipt.saleSurcharge > 0) && (
            <p className="ticket-line-sm">
              {receipt.saleDiscount > 0 && `Descuento -${formatMoney(receipt.saleDiscount)} `}
              {receipt.saleSurcharge > 0 && `Recargo +${formatMoney(receipt.saleSurcharge)}`}
            </p>
          )}
          <div className="ticket-total"><span>TOTAL</span><strong>{formatMoney(receipt.total)}</strong></div>
          <p className="ticket-line-sm">Pago: {receipt.paymentSummary}</p>
          {receipt.amountTendered !== null && (
            <p className="ticket-line-sm">
              Recibido {formatMoney(receipt.amountTendered)} · Vuelto {formatMoney(Math.max(receipt.change ?? 0, 0))}
            </p>
          )}
          <p className="ticket-footer print-only-header">Gracias por su compra</p>
        </section>
      )}

      {closeSummary && (
        <section className="panel print-area" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Detalle del turno cerrado</h2>
            <button className="secondary no-print" onClick={() => handlePrint()}>Imprimir</button>
          </div>
          <p className="muted print-only-header">Cerrado {new Date().toLocaleString("es-AR")}</p>
          <p><strong>Total del turno: {formatMoney(closeSummary.total)}</strong></p>
          <div className="panel" style={{ padding: 14, marginBottom: 16 }}>
            <p className="muted" style={{ margin: 0, marginBottom: 6, fontWeight: 800, textTransform: "uppercase", fontSize: 12 }}>Arqueo de caja</p>
            <p style={{ margin: "4px 0" }}>Efectivo esperado: <strong>{formatMoney(closeSummary.expectedCash)}</strong></p>
            {closeSummary.countedCash !== null ? (
              <>
                <p style={{ margin: "4px 0" }}>Efectivo contado: <strong>{formatMoney(closeSummary.countedCash)}</strong></p>
                <p style={{ margin: "4px 0" }}>
                  Diferencia:{" "}
                  <strong className={(closeSummary.difference ?? 0) < 0 ? "num-negative" : (closeSummary.difference ?? 0) > 0 ? "num-positive" : undefined}>
                    {formatMoney(closeSummary.difference ?? 0)}
                  </strong>
                </p>
              </>
            ) : (
              <p className="muted" style={{ margin: "4px 0" }}>No se cargó el conteo de efectivo al cerrar.</p>
            )}
          </div>
          {closeSummary.byAccount.length > 0 && (
            <table className="data-table" style={{ marginBottom: 16 }}>
              <thead>
                <tr><th>Cuenta</th><th className="num">Ventas</th><th className="num">Monto</th></tr>
              </thead>
              <tbody>
                {closeSummary.byAccount.map((row) => (
                  <tr key={row.accountId}>
                    <td>{accounts.find((a) => a.id === row.accountId)?.name ?? row.accountId}</td>
                    <td className="num">{row.salesCount}</td>
                    <td className="num">{formatMoney(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table className="data-table">
            <thead>
              <tr><th>Hora</th><th>Producto</th><th className="num">Cant.</th><th className="num">Subtotal</th><th>Pago</th></tr>
            </thead>
            <tbody>
              {closeDetail.flatMap((sale) =>
                sale.items.map((item, idx) => (
                  <tr key={`${sale.id}-${idx}`}>
                    <td>{idx === 0 ? new Date(sale.createdAt).toLocaleTimeString("es-AR") : ""}</td>
                    <td>{item.productName}</td>
                    <td className="num">{item.quantity} {UNIT_LABELS[item.unit]}</td>
                    <td className="num">{formatMoney(item.lineTotal)}</td>
                    <td>{idx === 0 ? sale.payments.map((p) => p.accountName).join(" + ") : ""}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {closeDetail.length === 0 && <p className="muted">No hubo ventas en este turno.</p>}
        </section>
      )}
    </>
  );
}
