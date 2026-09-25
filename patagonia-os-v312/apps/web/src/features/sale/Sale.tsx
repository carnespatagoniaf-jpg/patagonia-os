import { useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
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
import { useEmployees } from "../employees/useEmployees";
import { deletePosShiftOutflow, listPosShiftVales, type PosShiftVale } from "../employees/employees-service";
import { createPosSale, type CreatePosSaleInput } from "./sale-service";
import { addPendingSale, getPendingSales, isNetworkError, markPendingSaleError, removePendingSale, type PendingSale } from "./offline-queue";
import { closePosShift, deletePosShiftAdjustment, getOpenPosShift, listPosShiftAdjustments, listPosShiftSupplierPayments, type PosShiftSupplierPayment, listPosShiftSales, openPosShift, voidPosSale, type CloseShiftResult, type PosShift, type PosShiftAdjustment, type PosShiftSale } from "./pos-shift-service";
import { formatMoney } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { buildTestTicket, getThermalPrintSettings, isThermalPrinterPaired, printBytes } from "./thermal-printer";
import { DEFAULT_SCALE_CONFIG, getBranchScaleConfig, type ScaleConfig } from "./scale-config-service";
import { CloseSummaryView, MovementReceiptView, ReceiptView } from "./SaleReceipts";
import { ShiftPanel } from "./ShiftPanel";
import { SaleConfigPanel } from "./SaleConfigPanel";
import { SaleTicketPanel } from "./SaleTicketPanel";
import { useSaleTicket } from "./useSaleTicket";
import { getMostradorPin } from "./company-settings-service";
import { buildCloseTicket as buildCloseTicketBytes, buildMovementTicket as buildMovementTicketBytes, buildReceiptTicket as buildReceiptTicketBytes } from "./sale-tickets";
import { type ReceiptLine, type ReceiptState, type MovementReceiptState, STALE_SHIFT_HOURS, formatShiftStart, getAutoPrintEnabled, saveAutoPrintEnabled, loadStoredReceipt, saveStoredReceipt } from "./sale-model";

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

  const [receipt, setReceipt] = useState<ReceiptState | null>(() => loadStoredReceipt());
  const [movementReceipt, setMovementReceipt] = useState<MovementReceiptState | null>(null);
  const movementReceiptRef = useRef<HTMLDivElement | null>(null);



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


  const ticket = useSaleTicket({ products, categories, scaleConfig, accounts, shift, busy, setMessage, setShowShiftTotals });
  const {
    cart,
    itemDiscounts,
    saleDiscount,
    saleSurcharge,
    payments,
    confirmCharge,
    setConfirmCharge,
    saleSurchargeValue,
    saleDiscountValue,
    total,
    isSplit,
    singleAccount,
    isSingleCash,
    tenderedValue,
    change,
    splitRemaining,
    clearTicket
  } = ticket;

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
          <SaleTicketPanel ticket={ticket} accounts={accounts} busy={busy} onCheckout={checkout} />

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
