import { Fragment, useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import type { Product, TreasuryAccount } from "@patagonia/domain";
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
import {
  deletePosShiftOutflow,
  listPosShiftVales,
  registerEmployeeValeFromPosShift,
  type PosShiftVale
} from "../employees/employees-service";
import { createPosSale, type CreatePosSaleInput } from "./sale-service";
import { addPendingSale, getPendingSales, isNetworkError, markPendingSaleError, removePendingSale, type PendingSale } from "./offline-queue";
import {
  closePosShift,
  deletePosShiftAdjustment,
  getOpenPosShift,
  listPosShiftAdjustments,
  listPosShiftSupplierPayments,
  type PosShiftSupplierPayment,
  listPosShiftSales,
  openPosShift,
  registerPosShiftTransfer,
  voidPosSale,
  type CloseShiftResult,
  type PosShift,
  type PosShiftAdjustment,
  type PosShiftSale
} from "./pos-shift-service";
import { formatMoney } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { buildTestTicket, getThermalPrintSettings, isThermalPrinterPaired, isThermalPrintSupported, printBytes, TicketBuilder } from "./thermal-printer";
import {
  DEFAULT_SCALE_CONFIG,
  deleteBranchScaleConfig,
  detectScaleConfig,
  getBranchScaleConfig,
  parseTicketTotalBarcode,
  TICKET_TOTAL_CONFIRM_FROM,
  parseWeightBarcode,
  saveBranchScaleConfig,
  type ScaleConfig,
  type ScalePayloadType
} from "./scale-config-service";
import { isWeightScaleEnabled, readScaleWeight } from "./scale-weight";
import { ScaleWeightSettings } from "./ScaleWeightSettings";
import { CloseSummaryView, MovementReceiptView, ReceiptView } from "./SaleReceipts";
import { ShiftPanel } from "./ShiftPanel";
import { SaleConfigPanel } from "./SaleConfigPanel";
import { getMostradorPin, setMostradorPin } from "./company-settings-service";
import { buildCloseTicket as buildCloseTicketBytes, buildMovementTicket as buildMovementTicketBytes, buildReceiptTicket as buildReceiptTicketBytes } from "./sale-tickets";
import { type TicketLine, type PaymentRow, type ReceiptLine, type ReceiptState, type MovementReceiptState, UNIT_LABELS, STALE_SHIFT_HOURS, formatShiftStart, getAutoPrintEnabled, saveAutoPrintEnabled, loadStoredReceipt, saveStoredReceipt } from "./sale-model";

export function Sale() {
  const { branchId, branches, activeBranch } = useActiveBranch();
  const { profile } = useAuth();
  const { accounts, adjust } = useTreasury();
  const { suppliers } = useSuppliers();
  const { employees } = useEmployees();
  // "treasury.manage" (dueño/admin) da acceso a la pantalla completa de
  // Tesorería; "pos.treasury" es más angosto y solo destraba estos botones
  // de Mostrador (caja/proveedor/vale) para un cajero, sin abrirle Tesorería
  // -- ver el comentario en permissions.ts.
  const canManageTreasury = can(profile, "treasury.manage") || can(profile, "pos.treasury");
  // A diferencia de canManageTreasury (que un cajero también tiene, vía
  // pos.treasury, para poder cargar caja/proveedor/vale), esto es a
  // propósito más angosto: cuánto se lleva vendido en el turno es
  // información que el dueño/admin puede querer no mostrarle a un cajero
  // en pantalla mientras atiende.
  const canSeeShiftTotals = can(profile, "treasury.manage");

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [shift, setShift] = useState<PosShift | null>(null);
  const [shiftLoading, setShiftLoading] = useState(isSupabaseConfigured);
  const [shiftSales, setShiftSales] = useState<PosShiftSale[]>([]);
  const [showShiftMovements, setShowShiftMovements] = useState(false);
  // PIN para revelar "Ver movimientos" / "Ver movimientos de caja" -- ver
  // company-settings-service.ts. null = todavía no se cargó o no hay
  // ninguno configurado (en ese caso no se pide nada, como antes).
  const [mostradorPin, setMostradorPinValue] = useState<string | null>(null);
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const [pinPromptFor, setPinPromptFor] = useState<null | "movements" | "caja">(null);
  // Arranca siempre oculto, incluso para quien SÍ puede verlo -- la idea no
  // es solo "que el cajero no tenga permiso", sino que el número de ventas
  // no quede pegado en la pantalla todo el tiempo, porque cualquiera que
  // pase por detrás del mostrador (dueño cobrando incluido) lo puede ver
  // de reojo. Hace falta un clic deliberado cada vez.
  const [showShiftTotals, setShowShiftTotals] = useState(false);
  const [openingCashInput, setOpeningCashInput] = useState("");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [closingCountedCashInput, setClosingCountedCashInput] = useState("");
  const [closeSummary, setCloseSummary] = useState<CloseShiftResult | null>(null);
  const [closeDetail, setCloseDetail] = useState<PosShiftSale[]>([]);
  /** Foto de los "Movimiento de caja" (egresos a la caja fuerte, ingresos,
   * traspasos) del turno que se acaba de cerrar -- para que el dueño pueda
   * corroborar en el cierre, sin ir a buscarlo a otro lado, que lo que la
   * cajera tiró a la caja fuerte durante el día coincide con lo que
   * declaró (ver discusión: acá no hay una encargada que se lleve la
   * plata como en un supermercado, así que este es el único registro). */
  const [closeAdjustments, setCloseAdjustments] = useState<PosShiftAdjustment[]>([]);
  /** Mismo criterio que closeAdjustments pero para "Vale a empleado" -- el
   * detalle del turno cerrado no tenía ninguna sección de vales, así que
   * al imprimir el cierre esa plata quedaba invisible (bug real
   * reportado: "no se ve el detalle" de los vales en el papel). */
  const [closeVales, setCloseVales] = useState<PosShiftVale[]>([]);
  const [closeSupplierPayments, setCloseSupplierPayments] = useState<PosShiftSupplierPayment[]>([]);
  /** Al cerrar, cada cuenta no efectivo (tarjeta/posnet, transferencias)
   * también se puede corroborar contra el resumen real (el ticket del
   * posnet, el resumen de transferencias del banco) -- solo en pantalla,
   * no se guarda en ningún lado, es nomás para que el dueño vea si algo
   * no cuadra antes de dar el turno por cerrado. */
  const [accountReconcileInput, setAccountReconcileInput] = useState<Record<string, string>>({});

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
  const [movementReceipt, setMovementReceipt] = useState<MovementReceiptState | null>(null);
  const movementReceiptRef = useRef<HTMLDivElement | null>(null);

  const [showManualForm, setShowManualForm] = useState(false);
  const [weighing, setWeighing] = useState(false);
  const [manualDesc, setManualDesc] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [manualUnit, setManualUnit] = useState<Product["unit"]>("unit");

  const [payments, setPayments] = useState<PaymentRow[]>([{ accountId: "", amount: "", reference: "" }]);
  // Cartel de "confirmá para cobrar" -- se arma con el primer Enter/clic en
  // "Cobrar" (una vez que el medio de pago ya es válido) y recién con un
  // segundo Enter/clic se cobra de verdad. Pensado para el miedo real de
  // cobrar con el medio equivocado (ej. tocar Efectivo siendo Mercado
  // Pago) -- ver checkout().
  const [confirmCharge, setConfirmCharge] = useState(false);
  const [cashTendered, setCashTendered] = useState("");
  const [focusRowIndex, setFocusRowIndex] = useState<number | null>(null);
  const accountSelectRefs = useRef<Array<HTMLSelectElement | null>>([]);
  const amountInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const cashTenderedRef = useRef<HTMLInputElement | null>(null);
  const chargeButtonRef = useRef<HTMLButtonElement | null>(null);

  const [showCajaForm, setShowCajaForm] = useState(false);

  const [showMovementsList, setShowMovementsList] = useState(false);
  const [cajaAdjustments, setCajaAdjustments] = useState<PosShiftAdjustment[]>([]);
  const [posShiftVales, setPosShiftVales] = useState<PosShiftVale[]>([]);
  const [deletingMovementId, setDeletingMovementId] = useState<string | null>(null);

  const [showSupplierForm, setShowSupplierForm] = useState(false);

  const [showValeForm, setShowValeForm] = useState(false);

  const [thermalPrintBusy, setThermalPrintBusy] = useState(false);
  const [thermalConnectBusy, setThermalConnectBusy] = useState(false);
  const [thermalPaired, setThermalPaired] = useState(false);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [autoPrintEnabled, setAutoPrintEnabled] = useState<boolean>(() => getAutoPrintEnabled());
  const [pendingSales, setPendingSales] = useState<PendingSale[]>(() => getPendingSales());
  const [syncingOffline, setSyncingOffline] = useState(false);

  const [scaleConfig, setScaleConfig] = useState<ScaleConfig>(DEFAULT_SCALE_CONFIG);
  const [scaleConfigCalibrated, setScaleConfigCalibrated] = useState(false);

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
      if (open) {
        const [adjustments, vales] = await Promise.all([listPosShiftAdjustments(open.id), listPosShiftVales(open.id)]);
        setCajaAdjustments(adjustments);
        setPosShiftVales(vales);
      } else {
        setCajaAdjustments([]);
        setPosShiftVales([]);
      }
    } finally {
      setShiftLoading(false);
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void listProductCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;
    void getBranchScaleConfig(branchId)
      .then((config) => {
        if (config) {
          setScaleConfig(config);
          setScaleConfigCalibrated(true);
        } else {
          setScaleConfig(DEFAULT_SCALE_CONFIG);
          setScaleConfigCalibrated(false);
        }
      })
      .catch(() => {
        setScaleConfig(DEFAULT_SCALE_CONFIG);
        setScaleConfigCalibrated(false);
      });
  }, [branchId]);

  useEffect(() => {
    void reloadProducts();
    void reloadShift();
    setCloseSummary(null);
    setCloseDetail([]);
    setCloseAdjustments([]);
    setCloseVales([]);
    setCloseSupplierPayments([]);
    setAccountReconcileInput({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  useEffect(() => {
    void getMostradorPin().then(setMostradorPinValue);
  }, []);

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

  useEffect(() => {
    if (movementReceipt) movementReceiptRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [movementReceipt]);

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
    // navigator.usb.getDevices() no pide permiso -- solo informa si YA hay
    // una impresora emparejada de una sesión anterior (igual que la
    // balanza), así que se puede chequear solo al entrar a la página.
    void isThermalPrinterPaired().then(setThermalPaired);
  }, []);

  useEffect(() => {
    if (pendingSales.length === 0) return;
    const interval = setInterval(() => void syncPendingSales(), 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSales.length]);

  async function reloadShiftMovements() {
    if (!shift || !isSupabaseConfigured) return;
    try {
      const [adjustments, vales] = await Promise.all([listPosShiftAdjustments(shift.id), listPosShiftVales(shift.id)]);
      setCajaAdjustments(adjustments);
      setPosShiftVales(vales);
    } catch {
      // La lista de movimientos es informativa -- si falla no bloquea nada.
    }
  }

  /** Comprobante de un movimiento (caja, pago a proveedor, vale): saca el ticket
   * de venta viejo de pantalla para que no compita al imprimir, muestra este y,
   * si corresponde, lo imprime solo. */
  async function publishMovementReceipt(data: MovementReceiptState) {
    setReceipt(null);
    setMovementReceipt(data);
    await autoPrintMovementReceipt(data);
  }

  function handlePinSuccess() {
    setPinUnlocked(true);
    if (pinPromptFor === "movements") setShowShiftMovements(true);
    else if (pinPromptFor === "caja") setShowMovementsList(true);
    setPinPromptFor(null);
  }

  /** "Ver movimientos" y "Ver movimientos de caja" -- si hay un PIN
   * configurado y todavía no se destrabó en esta sesión, pide el PIN antes
   * de mostrar. Ocultar (el toggle inverso) nunca pide nada. */
  function requestReveal(kind: "movements" | "caja") {
    const isShown = kind === "movements" ? showShiftMovements : showMovementsList;
    const reveal = kind === "movements" ? () => setShowShiftMovements(true) : () => setShowMovementsList(true);
    if (isShown) {
      if (kind === "movements") setShowShiftMovements(false);
      else setShowMovementsList(false);
      return;
    }
    if (mostradorPin && !pinUnlocked) {
      setPinPromptFor(kind);
      return;
    }
    reveal();
  }

  async function handleDeleteAdjustment(id: string) {
    setDeletingMovementId(id);
    try {
      await deletePosShiftAdjustment(id);
      await reloadShiftMovements();
      setMessage("Movimiento borrado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo borrar el movimiento.");
    } finally {
      setDeletingMovementId(null);
    }
  }

  async function handleDeleteVale(id: string) {
    setDeletingMovementId(id);
    try {
      await deletePosShiftOutflow(id);
      await reloadShiftMovements();
      setMessage("Vale borrado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo borrar el vale.");
    } finally {
      setDeletingMovementId(null);
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

  /** Agregar un producto elegido por nombre o código. Si hay balanza por cable
   * activada y el producto es por kg, el peso lo trae la balanza; si no se
   * puede leer, NO se agrega nada (mejor que vender 1 kg por error). */
  async function addProductFromSearch(product: Product) {
    if (product.unit !== "kg" || !isWeightScaleEnabled()) {
      quickAdd(product);
      return;
    }
    if (weighing) return;
    setWeighing(true);
    setMessage("Leyendo la balanza…");
    try {
      const { frame } = await readScaleWeight();
      quickAdd(product, frame.weightKg);
      setMessage(`${product.name}: ${frame.weightKg.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg (peso de la balanza).`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No pude leer la balanza.");
    } finally {
      setWeighing(false);
    }
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

    // Ticket de total de una balanza tipo caja (Kretz Aura): trae solo el
    // importe, no los productos -- va como línea manual, sin descontar stock.
    // Se evalúa antes que la etiqueta por PLU (los 5 ceros iniciales la
    // confundirían con el PLU 1) y solo si no hay un producto con ese código.
    const ticketTotal = parseTicketTotalBarcode(raw);
    if (ticketTotal !== null && !products.some((p) => p.code === raw)) {
      const key = `ticket-${raw.padStart(13, "0")}`;
      if (cart.some((l) => l.key === key)) {
        setMessage("Ese ticket de la balanza ya está cargado en esta venta.");
      } else if (
        ticketTotal >= TICKET_TOTAL_CONFIRM_FROM &&
        !window.confirm(`El ticket de la balanza indica ${formatMoney(ticketTotal)}. ¿Coincide con el TOTAL impreso en el ticket?`)
      ) {
        setMessage("Ticket de la balanza no cargado. Revisá el importe o cargá los productos a mano.");
      } else {
        setCart((current) => [...current, { key, kind: "manual", name: "Ticket de balanza", unit: "unit", quantity: 1, unitPrice: ticketTotal }]);
        setMessage(`Ticket de balanza cargado: ${formatMoney(ticketTotal)}.`);
      }
      setSearch("");
      setHighlightedIndex(-1);
      return;
    }

    const scanned = parseWeightBarcode(raw, scaleConfig);
    if (scanned) {
      const match = products.find((p) => (p.active ?? true) && p.code === scanned.plu);
      if (match) {
        if (scanned.kind === "weight") {
          quickAdd(match, scanned.weightKg);
        } else {
          // La balanza grabó el importe final, no el peso -- se recalcula
          // la cantidad al precio actual del producto (mismo criterio que
          // el peso: el precio no se lee del código, siempre se usa el
          // precio vigente en el sistema).
          const quantity = match.priceRetail > 0 ? scanned.amount / match.priceRetail : 0;
          if (quantity > 0) quickAdd(match, quantity);
        }
        return;
      }
    }

    const exactCode = products.find((p) => (p.active ?? true) && p.code.toLowerCase() === raw.toLowerCase());
    if (exactCode) {
      void addProductFromSearch(exactCode);
      return;
    }

    const picked = searchMatches[activeMatchIndex];
    if (picked) {
      void addProductFromSearch(picked);
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
    setPayments([{ accountId: "", amount: "", reference: "" }]);
    setCashTendered("");
    // Se vuelve a tapar solo después de cada venta -- que no quede
    // "revelado" toda la tarde después de un solo clic.
    setShowShiftTotals(false);
    setMessage("");
    searchInputRef.current?.focus();
  }

  /** Agrega una fila de pago y le pasa el foco a su selector de cuenta --
   * ver el useEffect de focusRowIndex más arriba. */
  function addPaymentRow() {
    setFocusRowIndex(payments.length);
    setPayments((current) => [...current, { accountId: "", amount: "", reference: "" }]);
  }

  function removePaymentRow(index: number) {
    setPayments((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));
  }

  function updatePaymentRow(index: number, field: "accountId" | "amount" | "reference", value: string) {
    setPayments((current) => current.map((p, i) => {
      if (i !== index) return p;
      // Cambiar de cuenta borra el cupón que hubiera cargado -- si no, un
      // cupón de una tarjeta podría quedar pegado a otro medio de pago
      // elegido después sin que nadie lo note.
      return field === "accountId" ? { ...p, accountId: value, reference: "" } : { ...p, [field]: value };
    }));
    // Si ya estaba armado el cartel de "confirmá para cobrar", cualquier
    // cambio en el medio/monto lo desarma -- que muestre siempre el medio
    // que realmente está elegido AHORA, no uno viejo.
    setConfirmCharge(false);
  }

  /** Elige la cuenta de la fila 0 (pago único, no dividido) -- mismo efecto
   * que elegirla del <select>, para que F1/F2/etc. y el mouse terminen en
   * el mismo lugar: foco en "Recibiste" si es efectivo, si no en Cobrar. */
  function selectSinglePaymentAccount(account: TreasuryAccount) {
    updatePaymentRow(0, "accountId", account.id);
    requestAnimationFrame(() => {
      if (account.paymentMethod === "cash") cashTenderedRef.current?.focus();
      else chargeButtonRef.current?.focus();
    });
  }

  // Si el carrito cambia (se agrega/saca/edita algo) después de armar el
  // cartel de confirmación, lo desarma -- no tiene sentido confirmar un
  // total que ya no es el que se muestra.
  useEffect(() => {
    setConfirmCharge(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart]);

  // F1..F9 eligen el medio de pago único por orden (el mismo orden que ya
  // tiene la cuenta en Tesorería) sin soltar el teclado -- solo tiene
  // sentido en pago único (no dividido), con turno abierto y carrito con
  // algo cargado. Se frena el comportamiento normal de esas teclas en el
  // navegador (F1 ayuda, F5 recargar, etc.) mientras se usan acá, para no
  // perder el ticket por accidente.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && confirmCharge) {
        e.preventDefault();
        setConfirmCharge(false);
        return;
      }
      if (isSplit || busy || cart.length === 0 || !shift) return;
      const match = /^F([1-9])$/.exec(e.key);
      if (!match) return;
      const account = accounts[Number(match[1]) - 1];
      if (!account) return;
      e.preventDefault();
      selectSinglePaymentAccount(account);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSplit, busy, cart.length, shift, accounts, confirmCharge]);

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
      if (!isSingleCash && !payments[0].reference.trim()) {
        setMessage("Cargá el cupón o número de operación de este pago.");
        return;
      }
    } else {
      if (payments.some((p) => !p.accountId)) {
        setMessage("Elegí la cuenta en cada medio de pago.");
        return;
      }
      if (payments.some((p) => accounts.find((a) => a.id === p.accountId)?.paymentMethod !== "cash" && !p.reference.trim())) {
        setMessage("Cargá el cupón o número de operación en cada pago que no sea efectivo.");
        return;
      }
      if (Math.abs(splitRemaining) > 0.5) {
        setMessage(`Los medios de pago no suman el total — falta ${formatMoney(splitRemaining)}.`);
        return;
      }
    }

    // El medio de pago ya es válido -- pero todavía no se cobra. Primer
    // Enter/clic solo arma el cartel de confirmación (ver el botón más
    // abajo); recién el segundo, con el cartel ya armado, cobra de
    // verdad. Pensado para el miedo real de cobrar con el medio
    // equivocado (ej. tocar Efectivo siendo Mercado Pago).
    if (!confirmCharge) {
      setMessage("");
      setConfirmCharge(true);
      return;
    }
    setConfirmCharge(false);

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
        setMovementReceipt(null);
        clearTicket();
        setMessage("Venta registrada (modo demo, no se descuenta stock real).");
        await autoPrintReceipt(demoReceipt);
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
        ? payments.map((p) => ({ accountId: p.accountId, amount: parseAmount(p.amount || "0") || 0, reference: p.reference.trim() || undefined }))
        : [{ accountId: payments[0].accountId, amount: total, reference: payments[0].reference.trim() || undefined }];

      const salePayload: CreatePosSaleInput = {
        branchId,
        posShiftId: shift.id,
        items: itemsPayload,
        payments: paymentsPayload,
        discountAmount: saleDiscountValue,
        surchargeAmount: saleSurchargeValue,
        // Generada una sola vez acá -- si esta venta termina en la cola
        // offline, el reintento reusa el mismo payload (con la misma
        // clave), así el servidor puede reconocer un reintento y nunca
        // duplicar la venta aunque la confirmación se haya perdido en el
        // camino de vuelta.
        idempotencyKey: crypto.randomUUID()
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
      // Si quedó un comprobante de caja/proveedor/vale de antes en pantalla,
      // sacarlo -- las dos secciones son .print-area, y si las dos quedan
      // montadas a la vez, imprimir la venta nueva puede terminar sacando
      // el papel viejo en vez del ticket de esta venta (bug real reportado
      // en producción).
      setMovementReceipt(null);
      clearTicket();
      // El ticket tiene que salir sí o sí -- se imprime antes de refrescar
      // stock/turno, y esos dos refrescos van en su propio try/catch para
      // que un problema de red ahí (la venta ya está guardada, o ya quedó
      // en la cola offline) no tape el ticket ni dispare el mensaje de "no
      // se pudo registrar la venta" sobre una venta que en realidad sí se
      // cobró.
      await autoPrintReceipt(newReceipt);
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
      // Los errores de RPC de Supabase (PostgrestError) sí son instancias de
      // Error, pero por las dudas -- que nunca se le muestre al cajero un
      // mensaje genérico e inútil cuando el motivo real está ahí adentro.
      const raw = err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "";
      setMessage(raw || "No se pudo registrar la venta.");
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
          difference: countedCash !== undefined ? countedCash - expectedCash : null,
          breakdown: null
        });
        setCloseDetail(activeShiftSales);
        setCloseAdjustments(cajaAdjustments);
        setCloseVales(posShiftVales);
        setCloseSupplierPayments([]);
        setAccountReconcileInput({});
        setShift(null);
        setShiftSales([]);
        setShowCloseConfirm(false);
        setClosingCountedCashInput("");
        return;
      }
      const detailSnapshot = activeShiftSales;
      const adjustmentsSnapshot = cajaAdjustments;
      const valesSnapshot = posShiftVales;
      const closingShiftId = shift.id;
      const result = await closePosShift(shift.id, countedCash);
      setCloseSummary(result);
      try {
        setCloseSupplierPayments(await listPosShiftSupplierPayments(closingShiftId));
      } catch {
        // informativo -- si falla no tapa el cierre, que ya está hecho.
      }
      setCloseDetail(detailSnapshot);
      setCloseAdjustments(adjustmentsSnapshot);
      setCloseVales(valesSnapshot);
      setAccountReconcileInput({});
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

  const currentBranchName = () => branches.find((b) => b.id === branchId)?.name;
  const buildReceiptTicket = (r: ReceiptState) => buildReceiptTicketBytes(r, currentBranchName());
  const buildMovementTicket = (m: MovementReceiptState) => buildMovementTicketBytes(m, currentBranchName());
  const buildCloseTicket = () =>
    buildCloseTicketBytes({
      summary: closeSummary,
      branchName: currentBranchName(),
      accounts,
      adjustments: closeAdjustments,
      vales: closeVales,
      supplierPayments: closeSupplierPayments
    });

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

  /** Emparejar la impresora térmica una sola vez -- mismo mecanismo que
   * "Conectar balanza" en Stock (navigator.usb.requestDevice, recordado por
   * el navegador después). Imprime un ticket de prueba en el momento para
   * confirmar que además de emparejarse, imprime bien -- así no queda
   * "conectada" en el papel pero rota en la práctica. */
  /** El error real de WebUSB cuando Windows ya tiene un driver instalado
   * para esta impresora (el caso más común, ej. la "POS-80C" genérica) es
   * un mensaje técnico en inglés que no le dice nada a un dueño de
   * carnicería -- "Unable to claim interface" o similar. En vez de mostrar
   * eso tal cual, se distingue el caso de "cancelaste el selector sin
   * elegir nada" (NotFoundError, no es un error real) del resto, y a
   * cualquier otro error se le agrega la explicación + el siguiente paso
   * (modo kiosco), en vez de dejar a alguien no técnico con un mensaje en
   * inglés y ningún rumbo. */
  async function handleConnectThermalPrinter() {
    setMessage("");
    setThermalConnectBusy(true);
    try {
      await printBytes(buildTestTicket(getThermalPrintSettings()));
      setThermalPaired(true);
      setMessage("Impresora térmica conectada -- imprimió un ticket de prueba. De ahora en más, el comprobante sale ahí directo al cobrar (si tenés activado \"Imprimir automáticamente\" arriba), sin ningún diálogo.");
    } catch (err) {
      if (err instanceof Error && err.name === "NotFoundError") {
        setMessage("No elegiste ninguna impresora de la lista -- probá de nuevo y seleccioná una.");
      } else {
        const raw = err instanceof Error ? err.message : String(err);
        setMessage(
          `No se pudo conectar directo por USB (detalle técnico: ${raw}). Es normal si Windows ya tiene instalado el driver de esta impresora para el diálogo de impresión normal -- en ese caso este camino 100% automático no va a funcionar para este equipo. Usá el modo kiosco como alternativa (link para descargarlo más abajo).`
        );
      }
    } finally {
      setThermalConnectBusy(false);
    }
  }

  async function handleCloseTicketPrint() {
    setMessage("");
    setThermalPrintBusy(true);
    try {
      await printBytes(buildCloseTicket());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo imprimir el ticket de cierre en la térmica.");
    } finally {
      setThermalPrintBusy(false);
    }
  }

  /** Se imprime solo al cobrar -- pero SOLO si el local activó "Imprimir
   * automáticamente" en Config. impresora. Sin ese interruptor, a quien no
   * tiene impresora nunca le aparece un diálogo de impresión de la nada;
   * quien sí imprime lo prende una vez y listo.
   * Si ya hay una térmica emparejada por USB (navigator.usb, el mismo
   * mecanismo de "conectar una vez y listo" que la balanza), se manda ahí
   * directo -- sale el ticket sin ningún diálogo ni clic extra, ideal para
   * un cliente que compra el sistema y solo necesita emparejar la
   * impresora una vez. Si no hay ninguna emparejada (o el envío falla, ej.
   * un hipo de USB puntual), cae al diálogo de impresión normal del
   * navegador como red de seguridad -- ese SÍ requiere un clic en
   * "Imprimir" (ningún navegador permite saltear eso por seguridad), pero
   * nunca deja a alguien sin ticket. */
  async function autoPrintReceipt(receiptToPrint: ReceiptState) {
    if (!autoPrintEnabled) return;
    if (await isThermalPrinterPaired()) {
      try {
        await printBytes(buildReceiptTicket(receiptToPrint));
        return;
      } catch {
        // térmica emparejada pero falló el envío -- cae al diálogo de abajo.
      }
    }
    // Pequeña espera para que el DOM termine de pintar el comprobante nuevo
    // antes de que el navegador lo capture para imprimir.
    setTimeout(() => window.print(), 150);
  }

  /** Mismo criterio que autoPrintReceipt, para el comprobante de caja/pago
   * a proveedor/vale a empleado. */
  async function autoPrintMovementReceipt(mov: MovementReceiptState) {
    if (!autoPrintEnabled) return;
    if (await isThermalPrinterPaired()) {
      try {
        await printBytes(buildMovementTicket(mov));
        return;
      } catch {
        // térmica emparejada pero falló el envío -- cae al diálogo de abajo.
      }
    }
    setTimeout(() => window.print(), 150);
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">VENTA</p>
          <h1>Mostrador</h1>
          <p className="muted">Escaneá la etiqueta de la balanza (carga el peso solo) o buscá por nombre para lo que no tiene código.</p>
        </div>
        <button
          className="secondary"
          title="Configuración de impresora y balanza"
          aria-label="Configuración de impresora y balanza"
          onClick={() => setShowConfigPanel((v) => !v)}
          style={{ padding: "10px 12px" }}
        >
          <Settings size={18} />
        </button>
      </header>

      <SaleConfigPanel
        visible={showConfigPanel}
        branchId={branchId}
        canSeeShiftTotals={canSeeShiftTotals}
        autoPrintEnabled={autoPrintEnabled}
        onAutoPrintChange={(enabled) => {
          setAutoPrintEnabled(enabled);
          saveAutoPrintEnabled(enabled);
        }}
        thermalPaired={thermalPaired}
        thermalConnectBusy={thermalConnectBusy}
        onConnectThermal={handleConnectThermalPrinter}
        scaleConfigCalibrated={scaleConfigCalibrated}
        onScaleConfigChange={(config) => {
          setScaleConfig(config ?? DEFAULT_SCALE_CONFIG);
          setScaleConfigCalibrated(config !== null);
        }}
        mostradorPin={mostradorPin}
        onPinChange={setMostradorPinValue}
        onMessage={setMessage}
      />

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

      {shift && shift.id !== "demo-shift" && Date.now() - new Date(shift.openedAt).getTime() > STALE_SHIFT_HOURS * 3_600_000 && (
        <div className="message warning">
          <strong>Este turno está abierto desde el {formatShiftStart(shift.openedAt)}.</strong> La plata de estas ventas no llega a Tesorería hasta que lo cierres, y el arqueo de caja pierde sentido. Cerralo con el botón "Cerrar turno" de la derecha y abrí uno nuevo.
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
                      onClick={() => void addProductFromSearch(product)}
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
                            <td><button className="secondary" onClick={() => void addProductFromSearch(product)}>+ Agregar</button></td>
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
                  {!isSplit && (
                    <div className="pos-payment-methods">
                      {accounts.map((a, i) => (
                        <button
                          key={a.id}
                          type="button"
                          className={`pos-payment-method-btn${payments[0]?.accountId === a.id ? " active" : ""}`}
                          onClick={() => selectSinglePaymentAccount(a)}
                        >
                          {i < 9 && <kbd>F{i + 1}</kbd>}
                          <span>{a.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {!isSplit && singleAccount && singleAccount.paymentMethod !== "cash" && (
                    <div className="pos-payment-row">
                      <input
                        type="text"
                        placeholder="Cupón / N° de operación"
                        value={payments[0].reference}
                        onChange={(e) => updatePaymentRow(0, "reference", e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          chargeButtonRef.current?.focus();
                        }}
                      />
                    </div>
                  )}
                  {isSplit && payments.map((p, i) => (
                    <div className="pos-payment-row" key={i}>
                      <select
                        ref={(el) => { accountSelectRefs.current[i] = el; }}
                        value={p.accountId}
                        onChange={(e) => {
                          updatePaymentRow(i, "accountId", e.target.value);
                          requestAnimationFrame(() => amountInputRefs.current[i]?.focus());
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
                      {accounts.find((a) => a.id === p.accountId)?.paymentMethod !== "cash" && p.accountId && (
                        <input
                          type="text"
                          placeholder="Cupón / N° de operación"
                          value={p.reference}
                          onChange={(e) => updatePaymentRow(i, "reference", e.target.value)}
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

                {confirmCharge && (
                  <p className="pos-confirm-banner">
                    Vas a cobrar {formatMoney(total)} con{" "}
                    {isSplit
                      ? payments.map((p) => accounts.find((a) => a.id === p.accountId)?.name ?? "-").join(" + ")
                      : singleAccount?.name}
                    . Apretá Enter de nuevo (o tocá el botón) para confirmar -- Esc para elegir otro medio.
                  </p>
                )}
                <div className="pos-total-bar">
                  <div>
                    <p className="pos-total-label">Total a cobrar</p>
                    <strong className="pos-total-value">{formatMoney(total)}</strong>
                  </div>
                  <button
                    ref={chargeButtonRef}
                    className={`charge-button pos-charge-btn${confirmCharge ? " confirming" : ""}`}
                    disabled={busy}
                    onClick={checkout}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); checkout(); } }}
                  >
                    {busy ? "Cobrando…" : confirmCharge ? (<>Confirmar cobro <kbd>Enter</kbd></>) : (<>Cobrar <kbd>Enter</kbd></>)}
                  </button>
                </div>
              </>
            )}
          </section>

          <ShiftPanel
            shift={shift}
            canSeeShiftTotals={canSeeShiftTotals}
            canManageTreasury={canManageTreasury}
            busy={busy}
            accounts={accounts}
            suppliers={suppliers}
            employees={employees}
            adjust={adjust}
            activeSalesCount={activeShiftSales.length}
            shiftTotal={shiftTotal}
            shiftSales={shiftSales}
            showShiftTotals={showShiftTotals}
            onToggleShiftTotals={() => setShowShiftTotals((v) => !v)}
            showShiftMovements={showShiftMovements}
            showMovementsList={showMovementsList}
            onRequestReveal={requestReveal}
            pinPromptFor={pinPromptFor}
            mostradorPin={mostradorPin}
            onPinSuccess={handlePinSuccess}
            onPinCancel={() => setPinPromptFor(null)}
            cajaAdjustments={cajaAdjustments}
            posShiftVales={posShiftVales}
            deletingMovementId={deletingMovementId}
            onDeleteAdjustment={handleDeleteAdjustment}
            onDeleteVale={handleDeleteVale}
            onVoidSale={handleVoidSale}
            onMovementsChanged={reloadShiftMovements}
            showCajaForm={showCajaForm}
            onToggleCajaForm={() => setShowCajaForm((v) => !v)}
            showSupplierForm={showSupplierForm}
            onToggleSupplierForm={() => setShowSupplierForm((v) => !v)}
            showValeForm={showValeForm}
            onToggleValeForm={() => setShowValeForm((v) => !v)}
            showCloseConfirm={showCloseConfirm}
            onRequestClose={() => {
              if (pendingSales.length > 0) {
                setMessage("Todavía hay ventas sin subir al servidor -- sincronizalas antes de cerrar el turno para que el total esté completo.");
                return;
              }
              setShowCloseConfirm(true);
            }}
            closingCountedCashInput={closingCountedCashInput}
            onCountedCashChange={setClosingCountedCashInput}
            onConfirmClose={handleCloseShift}
            onCancelClose={() => setShowCloseConfirm(false)}
            onMessage={setMessage}
            publishReceipt={publishMovementReceipt}
          />
        </div>
      )}

      {receipt && (
        <ReceiptView
          receipt={receipt}
          branchName={currentBranchName() ?? "Patagonia OS"}
          thermalPrintBusy={thermalPrintBusy}
          onPrint={handlePrint}
          onThermalPrint={handleThermalPrint}
        />
      )}

      {movementReceipt && (
        <MovementReceiptView
          ref={movementReceiptRef}
          movementReceipt={movementReceipt}
          branchName={currentBranchName() ?? "Patagonia OS"}
          onPrint={() => handlePrint()}
          onClose={() => setMovementReceipt(null)}
        />
      )}

      {closeSummary && (
        <CloseSummaryView
          summary={closeSummary}
          accounts={accounts}
          adjustments={closeAdjustments}
          vales={closeVales}
          supplierPayments={closeSupplierPayments}
          detail={closeDetail}
          reconcileInput={accountReconcileInput}
          onReconcileChange={setAccountReconcileInput}
          thermalPrintBusy={thermalPrintBusy}
          onThermalPrint={handleCloseTicketPrint}
          onPrint={() => handlePrint()}
        />
      )}
    </>
  );
}
