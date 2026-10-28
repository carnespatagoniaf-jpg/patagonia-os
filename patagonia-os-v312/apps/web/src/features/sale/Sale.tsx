import { cachedScaleConfig, scaleConfigLoaded, scaleConfigOnError, SCALE_CONFIG_UNKNOWN_MESSAGE, type ScaleConfigState } from "./scale-config-cache";
import { useEffect, useMemo, useRef, useState } from "react";
import { Settings } from "lucide-react";
import * as Sentry from "@sentry/react";
import type { Product } from "@patagonia/domain";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuth } from "../auth/AuthProvider";
import { SYSTEL_PILOT_COMPANIES } from "../inventory/systel/systel-pilot";
import { can, planAllows } from "../auth/permissions";
import { getScaleControl, type ScaleControlState } from "./scale-control-service";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listProductCategories, type ProductCategory } from "../inventory/product-categories-service";
import { useTreasury } from "../shifts/useTreasury";
import { useSuppliers } from "../purchases/useSuppliers";
import { useEmployees } from "../employees/useEmployees";
import { deletePosShiftOutflow, listPosShiftVales, type PosShiftVale } from "../employees/employees-service";
import { createPosSale, type CreatePosSaleInput } from "./sale-service";
import { repeatedPaperTime } from "../scales/sale/scale-sale-service";
import { authorizeInvoices, getFiscalSettings, getInvoice, invoicePrintFrom, requestInvoice, type FiscalSettings } from "../invoicing/invoicing-service";
import { emptyInvoiceDraft, invoiceDraftError, type InvoiceDraft } from "../invoicing/invoicing-view";
import { InvoiceRequestFields } from "../invoicing/InvoiceRequestFields";
import { addPendingSale, getPendingSales, isRetryableError, isShiftClosedError, markPendingSaleError, removePendingSale, resetPendingSaleErrors, updatePendingSale, type PendingSale } from "./offline-queue";
import { closePosShift, deletePosShiftAdjustment, getOpenPosShift, listPosCashiers, listPosShiftAdjustments, listPosShiftSupplierPayments, type PosShiftSupplierPayment, listPosShiftSales, openPosShift, voidPosSale, hasPosVoidPin, type CloseShiftResult, type PosCashier, type PosShift, type PosShiftAdjustment, type PosShiftSale, type SafeDepositResult } from "./pos-shift-service";
import { CashControlPanel } from "./CashControlPanel";
import { formatMoney } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { buildTestTicket, getThermalPrintSettings, isThermalPrinterPaired, printBytes } from "./thermal-printer";
import { pingPrintAgent } from "./printer-agent";
import { DEFAULT_SCALE_CONFIG, getBranchScaleConfig, type ScaleConfig } from "./scale-config-service";
import { CloseSummaryView, MovementReceiptView, ReceiptView } from "./SaleReceipts";
import { ShiftPanel } from "./ShiftPanel";
import { SaleConfigPanel } from "./SaleConfigPanel";
import { SaleTicketPanel } from "./SaleTicketPanel";
import { useSaleTicket } from "./useSaleTicket";
import { applySoldToStock } from "./sale-stock";
import { getMostradorPin } from "./company-settings-service";
import { buildCloseTicket as buildCloseTicketBytes, buildMovementTicket as buildMovementTicketBytes, buildReceiptTicket as buildReceiptTicketBytes } from "./sale-tickets";
import { type ReceiptLine, type ReceiptState, type MovementReceiptState, STALE_SHIFT_HOURS, formatShiftStart, getAutoPrintEnabled, saveAutoPrintEnabled, loadStoredReceipt, saveStoredReceipt } from "./sale-model";

export function Sale() {
  const { branchId, branches } = useActiveBranch();
  const { profile } = useAuth();
  const { accounts: allAccounts, adjust } = useTreasury();
  // La caja fuerte (migración 117) no es un medio de cobro: recibe los
  // retiros desde "Guardar en caja fuerte".
  const accounts = useMemo(() => allAccounts.filter((a) => !a.isSafe), [allAccounts]);
  const [cashiers, setCashiers] = useState<PosCashier[]>([]);
  const [openCashierId, setOpenCashierId] = useState("");
  const [openCashierPin, setOpenCashierPin] = useState("");
  const { suppliers, create: createSupplier } = useSuppliers();
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
  const [voidPinRequired, setVoidPinRequired] = useState(false);
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
  const [closeSummary, setCloseSummary] = useState<CloseShiftResult | null>(null);
  // "Controlar la balanza al cerrar" (migración 164): de la empresa; el dueño lo cambia en "Control de caja".
  const [scaleCloseOverride, setScaleCloseOverride] = useState<boolean | null>(null);
  const scaleCloseControl = scaleCloseOverride ?? (profile?.features?.includes("control_balanza") ?? false);
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
  const [closeScaleControl, setCloseScaleControl] = useState<ScaleControlState | null>(null);
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

  // Factura electrónica (migración 113): solo si el negocio la tiene activa.
  const [fiscal, setFiscal] = useState<FiscalSettings | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceDraft>(emptyInvoiceDraft());
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void getFiscalSettings().then(setFiscal);
  }, []);

  const [thermalPrintBusy, setThermalPrintBusy] = useState(false);
  const [thermalConnectBusy, setThermalConnectBusy] = useState(false);
  const [thermalPaired, setThermalPaired] = useState(false);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [autoPrintEnabled, setAutoPrintEnabled] = useState<boolean>(() => getAutoPrintEnabled());
  const [pendingSales, setPendingSales] = useState<PendingSale[]>(() => getPendingSales());
  const [syncingOffline, setSyncingOffline] = useState(false);
  const syncingRef = useRef(false);
  /**
   * Clave de la venta que se está confirmando, atada a su contenido. Si el cobro falla y el cajero
   * vuelve a tocar "Cobrar" con la MISMA venta, se reusa la clave: si la primera vez el servidor sí
   * la había guardado (y se perdió la respuesta), devuelve esa misma venta y el stock no se descuenta
   * dos veces. Si la venta cambió, es otra clave.
   */
  const saleKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const [scaleConfig, setScaleConfig] = useState<ScaleConfig>(DEFAULT_SCALE_CONFIG);
  const [scaleConfigCalibrated, setScaleConfigCalibrated] = useState(false);


  const ticket = useSaleTicket({ products, categories, scaleConfig, accounts, shift, busy, setMessage, setShowShiftTotals, systelTicketPilot: SYSTEL_PILOT_COMPANIES.has(profile?.company_id ?? ""), scaleBranchId: branchId ?? null });
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
      // El turno se muestra aunque después falle traer sus ventas (nunca "Abrir turno" con uno abierto).
      setShift(open);
      if (open) {
        const [sales, adjustments, vales] = await Promise.all([listPosShiftSales(open.id), listPosShiftAdjustments(open.id), listPosShiftVales(open.id)]);
        setShiftSales(sales);
        setCajaAdjustments(adjustments);
        setPosShiftVales(vales);
      } else {
        setShiftSales([]);
        setCajaAdjustments([]);
        setPosShiftVales([]);
      }
    } finally {
      setShiftLoading(false);
    }
  }

  /**
   * Después de cobrar: el stock ya se descontó en pantalla (applySoldToStock)
   * y el botón ya quedó libre, así que esto corre de fondo, todo en paralelo
   * y sin mostrar "cargando". Si mientras tanto empezó otro cobro, el
   * resultado se descarta (traería datos de antes de esa venta); la recarga
   * de esa otra venta lo pone al día.
   */
  const refreshSeqRef = useRef(0);
  async function refreshAfterSale(shiftId: string) {
    if (!branchId) return;
    const seq = ++refreshSeqRef.current;
    const span = Sentry.startInactiveSpan({ name: "Mostrador: recarga después de cobrar", op: "mostrador.recarga", forceTransaction: true });
    try {
      const [freshProducts, open, sales, adjustments, vales] = await Promise.all([
        listProductsForBranch(branchId),
        getOpenPosShift(branchId),
        listPosShiftSales(shiftId),
        listPosShiftAdjustments(shiftId),
        listPosShiftVales(shiftId)
      ]);
      if (seq !== refreshSeqRef.current) return;
      setProducts(freshProducts);
      if (open?.id !== shiftId) {
        // El turno se cerró o cambió desde otra caja: recarga completa.
        await reloadShift();
        return;
      }
      setShift(open);
      setShiftSales(sales);
      setCajaAdjustments(adjustments);
      setPosShiftVales(vales);
    } catch {
      // no crítico -- la venta y el ticket ya están hechos; se refresca en la próxima venta.
    } finally {
      span.end();
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void listProductCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;
    // Nunca el formato de fábrica a ciegas: mientras carga, el último de esta computadora; si falla y no hay, no se
    // leen etiquetas y se avisa (auditoría 28/10: con el de fábrica una etiqueta 1-6-5 se leía como otro producto).
    const apply = (s: ScaleConfigState) => {
      setScaleConfig(s.config);
      setScaleConfigCalibrated(s.calibrated);
    };
    const cached = cachedScaleConfig(branchId);
    if (cached) apply(cached);
    void getBranchScaleConfig(branchId)
      .then((config) => apply(scaleConfigLoaded(branchId, config)))
      .catch(() => {
        const s = scaleConfigOnError(branchId);
        apply(s);
        if (s.unknown) setMessage(SCALE_CONFIG_UNKNOWN_MESSAGE);
      });
  }, [branchId]);

  useEffect(() => {
    void reloadProducts();
    void reloadShift();
    setCloseSummary(null);
    setCloseScaleControl(null);
    setCloseDetail([]);
    setCloseAdjustments([]);
    setCloseVales([]);
    setCloseSupplierPayments([]);
    setAccountReconcileInput({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  useEffect(() => {
    void getMostradorPin().then(setMostradorPinValue);
    void hasPosVoidPin().then(setVoidPinRequired).catch(() => setVoidPinRequired(false));
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;
    setOpenCashierId("");
    setOpenCashierPin("");
    void listPosCashiers(branchId).then(setCashiers).catch(() => setCashiers([]));
  }, [branchId]);


  useEffect(() => {
    saveStoredReceipt(receipt);
  }, [receipt]);

  useEffect(() => {
    if (movementReceipt) movementReceiptRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [movementReceipt]);

  /** Sube una venta guardada. Si su turno ya se cerró (p. ej. desde otra
   * PC antes de que llegara), la sube al turno abierto de esa sucursal --
   * la plata ya se cobró y tiene que figurar en algún lado. La clave de
   * idempotencia se chequea en el servidor ANTES que el turno, así que si
   * la venta sí había llegado la primera vez, no se duplica. Si no hay
   * ningún turno abierto, queda pendiente hasta que se abra uno. */
  async function uploadPendingSale(sale: PendingSale) {
    try {
      await createPosSale(sale.input);
    } catch (err) {
      if (!isShiftClosedError(err)) throw err;
      const open = await getOpenPosShift(sale.input.branchId);
      if (!open) {
        updatePendingSale(sale.localId, { note: "su turno ya se cerró; se sube sola apenas abras un turno nuevo" });
        return;
      }
      const input = { ...sale.input, posShiftId: open.id };
      updatePendingSale(sale.localId, { input });
      await createPosSale(input);
    }
    removePendingSale(sale.localId);
  }

  /** Descarta a mano una venta que el servidor rechaza por un motivo real
   * (producto borrado, cuenta de cobro desactivada...), para que no trabe
   * el cierre del turno para siempre. Queda avisado en Sentry. */
  function discardPendingSale(sale: PendingSale) {
    const when = new Date(sale.createdAt).toLocaleString("es-AR");
    const amount = sale.total != null ? ` de $${sale.total.toLocaleString("es-AR")}` : "";
    if (!window.confirm(`¿Descartar la venta${amount} de las ${when}?\n\nNo va a quedar registrada en el sistema. Si la cobraste, cargala de nuevo a mano para que el stock y la caja den bien.`)) return;
    Sentry.captureMessage("Venta offline descartada a mano", { level: "warning", extra: { sale } });
    removePendingSale(sale.localId);
    setPendingSales(getPendingSales());
  }

  /** Reintenta mandar al servidor las ventas que quedaron guardadas
   * localmente por falta de conexión. Se corta apenas vuelve a fallar por
   * red (quedan las demás para el próximo intento); si el servidor
   * rechaza una por un motivo real (no de red) se marca como error y se
   * sigue con el resto, para que una venta rara no trabe a las demás. */
  async function syncPendingSales(manual = false) {
    // Ref y no el state: el intervalo y el listener "online" llaman a una
    // copia vieja de esta función, que vería syncingOffline siempre false.
    if (syncingRef.current) return;
    // A mano ("Sincronizar ahora") se reintentan también las que quedaron
    // con error; solas, solo las que fallaron por sesión vencida.
    resetPendingSaleErrors(!manual);
    const queue = getPendingSales();
    if (queue.length === 0) return;
    syncingRef.current = true;
    setSyncingOffline(true);
    try {
      // Si el token venció mientras no había internet, renovarlo ANTES de
      // mandar nada -- si no, la venta sale como "anon" y el servidor la
      // rechaza (ver isAuthError en offline-queue.ts).
      const { data: sessionData } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
      if (!sessionData.session) return;
      const companyId = profileRef.current?.company_id;
      for (const sale of queue) {
        if (sale.status === "error") continue;
        // Cobrada con otra empresa logueada en esta PC: se espera a que
        // vuelva a entrar alguien de esa empresa, nunca se manda con otra.
        if (sale.companyId && companyId && sale.companyId !== companyId) continue;
        try {
          await uploadPendingSale(sale);
        } catch (err) {
          if (isRetryableError(err)) break;
          const message = err instanceof Error ? err.message : "No se pudo subir esta venta.";
          markPendingSaleError(sale.localId, message);
          Sentry.captureMessage(`Venta offline rechazada por el servidor: ${message}`, { level: "error", extra: { localId: sale.localId, createdAt: sale.createdAt } });
        }
      }
    } finally {
      syncingRef.current = false;
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
    const onOnline = () => void syncPendingSales();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
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
    // Cerrar la pestaña no borra la cola, pero avisar igual: mientras haya
    // ventas sin subir, esta PC es el único lugar donde existen.
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pendingSales.length]);

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

  /** Papelito del retiro de dinero: se imprime SIEMPRE (aunque "Imprimir
   * automáticamente" esté apagado), porque va junto con la plata y es lo que
   * el dueño compara al contar los retiros. */
  async function publishSafeDeposit(deposit: SafeDepositResult) {
    const data: MovementReceiptState = {
      title: `RETIRO DE DINERO N.º ${deposit.number}`,
      date: deposit.createdAt,
      amount: deposit.amount,
      accountName: deposit.safeAccountName ? `${deposit.fromAccountName} -> ${deposit.safeAccountName}` : deposit.fromAccountName,
      detail: "Guardar este papel junto con la plata retirada.",
      counterpartLabel: "Cajera",
      counterpartName: deposit.employeeName ?? profile?.full_name ?? "-"
    };
    setReceipt(null);
    setMovementReceipt(data);
    setMessage(`Retiro N.º ${deposit.number} anotado: ${formatMoney(deposit.amount)}. Guardá el papelito con la plata.`);
    await autoPrintMovementReceipt(data, true);
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

  /** Devuelve el error para mostrar al lado del botón, o null si se borró. */
  async function handleDeleteAdjustment(id: string, authPin: string | null): Promise<string | null> {
    setDeletingMovementId(id);
    try {
      await deletePosShiftAdjustment(id, authPin);
      await reloadShiftMovements();
      setMessage("Movimiento borrado.");
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "No se pudo borrar el movimiento.";
    } finally {
      setDeletingMovementId(null);
    }
  }

  async function handleDeleteVale(id: string, authPin: string | null): Promise<string | null> {
    setDeletingMovementId(id);
    try {
      await deletePosShiftOutflow(id, authPin);
      await reloadShiftMovements();
      setMessage("Vale borrado.");
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "No se pudo borrar el vale.";
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
    const cashier = cashiers.find((c) => c.employeeId === openCashierId) ?? null;
    if (cashiers.length > 0 && (!cashier || !openCashierPin.trim())) {
      setMessage("Elegí quién atiende la caja y poné su PIN.");
      return;
    }
    setBusy(true);
    try {
      setShift(await openPosShift(branchId, openingCash, cashier ? { employeeId: cashier.employeeId, pin: openCashierPin.trim(), fullName: cashier.fullName } : null));
      setShiftSales([]);
      setOpeningCashInput("");
      setOpenCashierPin("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo abrir el turno.");
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    if (cart.length === 0 || !shift) return;
    // Etiquetas de una Systel sin su TOTAL: todavía no se sabe qué precio cobró la balanza.
    if (cart.some((l) => l.scalePending)) {
      setMessage("Falta escanear el código del TOTAL del ticket de la balanza: confirma el importe de cada artículo.");
      return;
    }

    // Factura pedida: se valida antes de cobrar (CUIT para la A, etc.), así nunca
    // queda una venta cobrada con una factura imposible de pedir.
    const wantsInvoice = Boolean(fiscal?.enabled && invoiceDraft.wanted);
    if (wantsInvoice && fiscal) {
      const invoiceError = invoiceDraftError(fiscal.taxCondition, invoiceDraft, total);
      if (invoiceError) {
        setMessage(invoiceError);
        return;
      }
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
    // Una recarga de fondo de la venta anterior traería datos de antes de esta: se descarta.
    refreshSeqRef.current++;
    // Lo que espera la cajera: de "Cobrar" a poder empezar la próxima venta (se ve en Sentry → Performance).
    const chargeSpan = Sentry.startInactiveSpan({ name: "Mostrador: cobrar", op: "mostrador.cobro", forceTransaction: true });
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
        discountAmount: itemDiscountsSnapshot[l.key],
        source: l.source,
        scaleTickets: l.scaleTickets,
        scaleAmount: l.scaleAmount,
        scaleTicket: l.scaleTicket,
        ...(l.scalePaper ? { scaleCode: l.scaleCode ?? null } : {})
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
        idempotencyKey: ""
      };
      // Tickets de la balanza "artículos + TOTAL": van con sus papeles (el servidor los valida y evita cobrarlos dos veces).
      const scalePapers = ticket.papers.payload(cart);
      if (scalePapers.error) throw new Error(scalePapers.error);
      if (scalePapers.scale) salePayload.scale = scalePapers.scale;
      const fingerprint = JSON.stringify([salePayload.branchId, salePayload.posShiftId, salePayload.items, salePayload.payments, salePayload.discountAmount, salePayload.surchargeAmount]);
      if (saleKeyRef.current?.fingerprint !== fingerprint) saleKeyRef.current = { fingerprint, key: crypto.randomUUID() };
      salePayload.idempotencyKey = saleKeyRef.current.key;

      // Si no hay conexión, createPosSale rechaza por una falla de red (no
      // un rechazo real del servidor) -- en vez de cortar la venta, queda
      // guardada tal cual para reintentar sola (ver offline-queue.ts) y el
      // cajero sigue como si hubiera salido bien, con el total calculado
      // acá mismo ya que no hay respuesta del servidor todavía.
      let saleTotal = total;
      let queuedOffline = false;
      let saleId: string | null = null;
      const invoiceSnapshot = invoiceDraft;
      try {
        let result;
        try {
          result = await createPosSale(salePayload);
        } catch (err) {
          const repeatedAt = repeatedPaperTime(err);
          if (repeatedAt === null || !salePayload.scale) throw err;
          // El mismo papel ya se cobró hoy: puede ser otro cliente con exactamente lo mismo, o el mismo papel otra vez.
          if (!window.confirm(`Ese mismo ticket de la balanza ya se cobró hoy${repeatedAt ? ` a las ${repeatedAt}` : ""}.

¿Es OTRO ticket igual (otro cliente que llevó exactamente lo mismo)?

Aceptar = sí, cobrar este.
Cancelar = es el mismo papel: no cobrar.`)) {
            // Con `code`: no es una falla de red, así que NO va a la cola sin conexión (isRetryableError).
            throw Object.assign(new Error("No se cobró: ese ticket de la balanza ya estaba cobrado."), { code: "TICKET_BALANZA_REPETIDO" });
          }
          ticket.papers.confirmRepeat();
          salePayload.scale = { ...salePayload.scale, papers: salePayload.scale.papers.map((p) => ({ ...p, repeatConfirmed: true })) };
          result = await createPosSale(salePayload);
        }
        saleTotal = result.total;
        saleId = result.saleId;
      } catch (err) {
        if (!isRetryableError(err)) throw err;
        addPendingSale(salePayload, { companyId: profile?.company_id, total });
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
      // Venta guardada (o en la cola con su clave): la próxima es otra venta, con otra clave.
      saleKeyRef.current = null;
      // La factura se pide recién con la venta guardada (necesita su número de venta)
      // y antes de imprimir: si ARCA la autoriza, el papel sale como factura con CAE y QR.
      let invoiceText = "";
      if (wantsInvoice) {
        if (queuedOffline || !saleId) {
          invoiceText = " La factura NO se pidió (sin conexión): cuando vuelva internet, pedila en Facturas → Ventas sin factura.";
        } else {
          try {
            const inv = await requestInvoice(saleId, invoiceSnapshot);
            const result = (await authorizeInvoices(inv.invoiceId)).find((r) => r.id === inv.invoiceId);
            if (result?.status === "autorizada" && fiscal) {
              const full = await getInvoice(inv.invoiceId);
              const print = full ? invoicePrintFrom(full, fiscal) : null;
              if (print) newReceipt.invoice = print;
              invoiceText = ` Factura ${inv.letter} autorizada por ARCA (CAE ${result.cae}).`;
            } else if (result?.status === "rechazada") {
              invoiceText = ` La venta se cobró, pero ARCA rechazó la factura: ${result.message ?? "sin motivo"} Pedila de nuevo en Facturas → Ventas sin factura.`;
            } else {
              invoiceText = ` Factura ${inv.letter} pedida, pero ARCA todavía no respondió${result?.message ? ` (${result.message})` : ""}. Se reintenta desde Facturas; ahí la reimprimís.`;
            }
          } catch (err) {
            invoiceText = ` La venta se cobró, pero la factura no se pudo pedir (${err instanceof Error ? err.message : "error"}). Pedila en Facturas → Ventas sin factura.`;
          }
        }
      }
      setReceipt(newReceipt);
      // Si quedó un comprobante de caja/proveedor/vale de antes en pantalla,
      // sacarlo -- las dos secciones son .print-area, y si las dos quedan
      // montadas a la vez, imprimir la venta nueva puede terminar sacando
      // el papel viejo en vez del ticket de esta venta (bug real reportado
      // en producción).
      setMovementReceipt(null);
      // Los tickets de la balanza Systel de esta venta ya no se pueden volver a cargar en otra.
      ticket.commitScaleTickets();
      ticket.papers.commit();
      clearTicket();
      setInvoiceDraft(emptyInvoiceDraft());
      // El ticket tiene que salir sí o sí -- se imprime antes de refrescar
      // stock/turno, y esos dos refrescos van en su propio try/catch para
      // que un problema de red ahí (la venta ya está guardada, o ya quedó
      // en la cola offline) no tape el ticket ni dispare el mensaje de "no
      // se pudo registrar la venta" sobre una venta que en realidad sí se
      // cobró.
      await autoPrintReceipt(newReceipt);
      // El stock se descuenta en pantalla con lo cobrado (también si quedó en
      // la cola sin conexión: se va a descontar cuando suba) y el botón queda
      // libre ya. Stock y turno reales se traen de fondo, sin hacer esperar
      // a la cajera (antes eran ~6 pedidos seguidos con "Cobrando…").
      setProducts((current) => applySoldToStock(current, itemsPayload));
      setBusy(false);
      if (queuedOffline) {
        setMessage("Sin conexión: la venta se guardó en este equipo y se sube sola apenas vuelva internet." + invoiceText);
      } else {
        if (invoiceText) setMessage(invoiceText.trim());
        void refreshAfterSale(shift.id);
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
      chargeSpan.end();
    }
  }

  /** Devuelve el error para mostrar en el formulario de anular, o null si anuló. */
  async function handleVoidSale(saleId: string, reason: string, authPin: string | null): Promise<string | null> {
    setMessage("");
    setBusy(true);
    try {
      if (!isSupabaseConfigured) {
        setShiftSales((current) => current.map((s) => (s.id === saleId ? { ...s, voidedAt: new Date().toISOString() } : s)));
        return null;
      }
      const result = await voidPosSale(saleId, reason, authPin);
      if (!result.ok) return result.error ?? "No se pudo anular la venta.";
      setMessage("Venta anulada. El stock volvió y el dueño la ve en Control de caja.");
      // Si estaba facturada, la base dejó su nota de crédito pendiente: se pide ya.
      if (fiscal?.enabled) {
        try {
          const credit = (await authorizeInvoices()).find((r) => r.kind === "nota_credito");
          if (credit?.status === "autorizada") setMessage(`Venta anulada. Nota de crédito ${credit.letter} autorizada por ARCA (CAE ${credit.cae}); se reimprime desde Facturas.`);
          else if (credit) setMessage(`Venta anulada. La nota de crédito quedó ${credit.status}${credit.message ? `: ${credit.message}` : ""}. Revisala en Facturas.`);
        } catch (err) {
          setMessage(`Venta anulada. La nota de crédito no se pudo pedir todavía (${err instanceof Error ? err.message : "error"}); se reintenta desde Facturas.`);
        }
      }
      // Se marca anulada en pantalla ya; turno y stock reales (el stock volvió) se traen de fondo.
      setShiftSales((current) => current.map((s) => (s.id === saleId ? { ...s, voidedAt: new Date().toISOString() } : s)));
      if (shift) void refreshAfterSale(shift.id);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "No se pudo anular la venta.";
    } finally {
      setBusy(false);
    }
  }

  async function handleCloseShift(countedCash: number, declaredAccounts: Record<string, string>) {
    if (!shift) return;
    setBusy(true);
    setMessage("");
    try {
      if (!isSupabaseConfigured) {
        const cashSalesDemo = activeShiftSales.reduce((sum, s) => sum + s.total, 0);
        const expectedCash = shift.openingCash + cashSalesDemo;
        setCloseSummary({
          total: shiftTotal,
          byAccount: [],
          expectedCash,
          countedCash,
          difference: countedCash - expectedCash,
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
        return;
      }
      const detailSnapshot = activeShiftSales;
      const adjustmentsSnapshot = cajaAdjustments;
      const valesSnapshot = posShiftVales;
      const closingShiftId = shift.id;
      const result = await closePosShift(shift.id, countedCash);
      setCloseSummary(result);
      // Los dos son informativos y van en paralelo: si fallan no tapan el cierre, que ya está hecho.
      const [control, supplierPayments] = await Promise.all([
        getScaleControl(closingShiftId).catch(() => null), // base sin la migración 104
        listPosShiftSupplierPayments(closingShiftId).catch(() => null)
      ]);
      setCloseScaleControl(control?.saved ? control : null);
      if (supplierPayments) setCloseSupplierPayments(supplierPayments);
      setCloseDetail(detailSnapshot);
      setCloseAdjustments(adjustmentsSnapshot);
      setCloseVales(valesSnapshot);
      // Lo que la cajera declaró por cada posnet/transferencia queda en la tabla del cierre.
      setAccountReconcileInput(declaredAccounts);
      setShowCloseConfirm(false);
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
          `No se pudo conectar directo por USB (detalle técnico: ${raw}). Es normal si Windows ya tiene instalado el driver de esta impresora para el diálogo de impresión normal -- en ese caso este camino 100% automático no va a funcionar para este equipo. No hace falta insistir con este botón: instalá el "programa de impresión" (arriba, en esta misma Configuración, dice "Impresora de tickets") -- funciona con cualquier térmica y cualquier driver de Windows.`
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
      } catch (err) {
        // Con el programa de impresión instalado no se cae al diálogo: si el
        // driver de Windows es el equivocado ese diálogo imprime metros de
        // basura. Se avisa el motivo real y el comprobante queda en pantalla.
        if (await pingPrintAgent()) {
          setMessage(err instanceof Error ? err.message : "No se pudo imprimir el ticket.");
          return;
        }
        // térmica emparejada por USB pero falló el envío -- cae al diálogo de abajo.
      }
    }
    // Pequeña espera para que el DOM termine de pintar el comprobante nuevo
    // antes de que el navegador lo capture para imprimir.
    setTimeout(() => window.print(), 150);
  }

  /** Mismo criterio que autoPrintReceipt, para el comprobante de caja/pago
   * a proveedor/vale a empleado. */
  async function autoPrintMovementReceipt(mov: MovementReceiptState, force = false) {
    if (!autoPrintEnabled && !force) return;
    if (await isThermalPrinterPaired()) {
      try {
        await printBytes(buildMovementTicket(mov));
        return;
      } catch (err) {
        if (await pingPrintAgent()) {
          setMessage(err instanceof Error ? err.message : "No se pudo imprimir el ticket.");
          return;
        }
        // térmica emparejada por USB pero falló el envío -- cae al diálogo de abajo.
      }
    }
    setTimeout(() => window.print(), 150);
  }

  return (
    <>
      <header className="page-header pos-page-header">
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
          if (branchId) scaleConfigLoaded(branchId, config);
        }}
        mostradorPin={mostradorPin}
        onPinChange={setMostradorPinValue}
        onMessage={setMessage}
      />

      {message && <div className="message">{message}</div>}

      {pendingSales.length > 0 && (
        <div className="message warning" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span>
            <strong>
              {pendingSales.length === 1 ? "1 venta" : `${pendingSales.length} ventas`} guardada{pendingSales.length === 1 ? "" : "s"} solo en esta computadora, pendiente{pendingSales.length === 1 ? "" : "s"} de subir al servidor.
            </strong>{" "}
            Se sube{pendingSales.length === 1 ? "" : "n"} sola{pendingSales.length === 1 ? "" : "s"} cuando hay internet. Hasta entonces no borres los datos del navegador ni cambies de navegador en esta PC.
            {pendingSales
              .filter((s) => s.status === "error" || s.note)
              .map((s) => (
                <span key={s.localId} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: "0.9em", marginTop: 6 }}>
                  <span>
                    Venta de las {new Date(s.createdAt).toLocaleTimeString("es-AR")}
                    {s.total != null && ` ($${s.total.toLocaleString("es-AR")})`}:{" "}
                    {s.status === "error" ? `no se pudo subir — ${s.errorMessage ?? "error desconocido"}. Tocá "Sincronizar ahora" para reintentar.` : s.note}
                  </span>
                  {s.status === "error" && (
                    <button className="secondary" style={{ padding: "2px 8px" }} onClick={() => discardPendingSale(s)}>
                      Descartar
                    </button>
                  )}
                </span>
              ))}
          </span>
          <button className="secondary" disabled={syncingOffline} onClick={() => void syncPendingSales(true)}>
            {syncingOffline ? "Sincronizando…" : "Sincronizar ahora"}
          </button>
        </div>
      )}

      {shift && shift.id !== "demo-shift" && Date.now() - new Date(shift.openedAt).getTime() > STALE_SHIFT_HOURS * 3_600_000 && (
        <div className="message warning">
          <strong>Este turno está abierto desde el {formatShiftStart(shift.openedAt)}.</strong> La plata de estas ventas no llega a Tesorería hasta que lo cierres, y el arqueo de caja pierde sentido. Cerralo con el botón "Cerrar caja" de la derecha y abrí uno nuevo.
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
            {cashiers.length > 0 && (
              <>
                <select value={openCashierId} onChange={(e) => setOpenCashierId(e.target.value)}>
                  <option value="">¿Quién atiende la caja?</option>
                  {cashiers.map((c) => (
                    <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>
                  ))}
                </select>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="PIN"
                  value={openCashierPin}
                  onChange={(e) => setOpenCashierPin(e.target.value.replace(/\D/g, ""))}
                  style={{ width: 80 }}
                />
              </>
            )}
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
        <div className="pos-grid">
          <SaleTicketPanel
            ticket={ticket}
            accounts={accounts}
            busy={busy}
            onCheckout={checkout}
            invoiceSlot={
              fiscal?.enabled && cart.length > 0 ? (
                <InvoiceRequestFields issuer={fiscal.taxCondition} draft={invoiceDraft} total={total} onChange={setInvoiceDraft} />
              ) : null
            }
          />

          <ShiftPanel
            shift={shift}
            canSeeShiftTotals={canSeeShiftTotals}
            canManageTreasury={canManageTreasury}
            canUseEmployees={planAllows(profile, "estandar")}
            products={products}
            scaleConfig={scaleConfig}
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
            voidPinRequired={voidPinRequired}
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
            cashiers={cashiers}
            onConfirmClose={(countedCash, declared) => void handleCloseShift(countedCash, declared)}
            onCancelClose={() => setShowCloseConfirm(false)}
            onSalesChanged={async () => {
              if (shift && isSupabaseConfigured) setShiftSales(await listPosShiftSales(shift.id));
            }}
            onSafeDeposit={publishSafeDeposit}
            scaleCloseControl={scaleCloseControl}
            onCreateSupplier={async (name) => (await createSupplier({ name, category: "" })).id}
            onMessage={setMessage}
            publishReceipt={publishMovementReceipt}
          />
        </div>
      )}

      {canSeeShiftTotals && isSupabaseConfigured && branchId && (
        <CashControlPanel
          branchId={branchId}
          onMessage={setMessage}
          adjust={adjust}
          onVoidPinChange={setVoidPinRequired}
          refreshKey={shiftSales.length - activeShiftSales.length}
          scaleCloseControl={scaleCloseControl}
          onScaleCloseControlChange={setScaleCloseOverride}
        />
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

      {closeSummary && !canSeeShiftTotals && (
        <section className="panel" style={{ marginTop: 18 }}>
          <h2 style={{ marginTop: 0 }}>Caja cerrada</h2>
          {closeSummary.difference === null ? (
            <p className="muted">Se cerró sin contar el efectivo.</p>
          ) : Math.abs(closeSummary.difference) < 1 ? (
            <p className="num-positive" style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Dio bien</p>
          ) : (
            <p className={closeSummary.difference < 0 ? "num-negative" : "num-positive"} style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>
              {closeSummary.difference < 0 ? `Faltan ${formatMoney(-closeSummary.difference)}` : `Sobran ${formatMoney(closeSummary.difference)}`}
            </p>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>El dueño ve el detalle en "Control de caja".</p>
        </section>
      )}

      {closeSummary && canSeeShiftTotals && (
        <CloseSummaryView
          summary={closeSummary}
          accounts={accounts}
          adjustments={closeAdjustments}
          vales={closeVales}
          supplierPayments={closeSupplierPayments}
          scaleControl={closeScaleControl}
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
