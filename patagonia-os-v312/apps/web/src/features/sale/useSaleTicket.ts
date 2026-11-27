import { useEffect, useMemo, useRef, useState } from "react";
import type { Product, TreasuryAccount } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { formatMoney, localDateIso } from "../shifts/format";
import type { ProductCategory } from "../inventory/product-categories-service";
import { parseTicketTotalBarcode, parseWeightBarcode, TICKET_TOTAL_CONFIRM_FROM, type ScaleConfig } from "./scale-config-service";
import { isWeightScaleEnabled, readScaleWeight } from "./scale-weight";
import { labelWeightProblem, MAX_COUNTER_SCALE_KG, resolveScan, type ScanResolution } from "./scan-resolve";
import { scanChoiceOptions, type LabelChoiceOption } from "./scale-label-choice";
import { resolveScaleLabel } from "./scale-label-resolver";
import type { ScaleConfigStatus } from "./scale-config-cache";
import { boxProblem, boxTicket, resolveBoxScan } from "./box-label";
import { useBoxLabelFormats } from "./box-label-service";
import { noteLabelRead } from "../scales/label-read";
import { closeSystelTicketSession, readSystelTicketFromScale, refreshSystelLabelFormat, systelTicketReadConfigured } from "../inventory/systel/systel-ticket-from-scale";
import { loadSystelLabelTemplates, mergedPerPlu, systelConfigForCodeAcross, templatesFromSetups, type SystelLabelTemplates } from "./systel-label-format";
import { settleTicket, type ScalePrices } from "./systel-ticket-settle";
import { sameProductName } from "../inventory/systel/systel-sales";
import { decodeSumCode } from "../inventory/systel/systel-sales";
import type { TicketCandidate } from "../inventory/systel/systel-ticket-detail";
import type { SystelTicket } from "../inventory/systel/systel-sales";
import { chargedScaleTickets } from "./sale-service";
import { useScalePapers } from "./useScalePapers";
import { submitScaleSupportReport } from "../scales/support-service";
import { systelTicketSupportReport } from "./scale-support-redact";
import type { PosShift } from "./pos-shift-service";
import { keepCurrentLists, lineGross, lineListFor, roundToPeso, withPriceList, type PaymentRow, type TicketLine } from "./sale-model";
import { isSupabaseConfigured } from "../../lib/supabase";
import { findScaleTicketSale, findScaleTicketVoid, undoScaleTicketVoid } from "./scale-control-service";
import { chargedTicketQuestion, detailedTotalKey, SAME_SALE_LABEL_QUESTION, type ChargedHit } from "./scale-repeat";
import { hourAr, undoVoidQuestion, voidedTicketQuestion } from "./scale-void-warning";
import { parseQuantity } from "./quantity";
import { addDetailLine, detailGroupKeys, detailRemaining } from "./ticket-detail";
import { addDetailScan, scanTotal } from "./scale-total-detail";
import { productPrice } from "../pricing/price-lists";
import { isPackageCode, normalizePackageCode, saleScanProblem } from "../planta/planta-logic";
import { findPackage } from "../planta/planta-service";
import { freezerTicket, matchFreezerScan, type FreezerStored } from "../freezer/freezer-logic";
import { cachedFreezerStored, loadFreezerStored } from "../freezer/freezer-service";

// Estado y acciones del ticket que se está armando en Mostrador: búsqueda,
// carrito, descuentos y recargos, medios de pago y sus totales. Es la parte
// "de la venta en curso" de Sale.tsx; el cobro en sí (checkout) sigue en la
// pantalla porque toca turno, comprobantes y cola sin conexión.

export interface SaleTicketDeps {
  products: Product[];
  categories: ProductCategory[];
  scaleConfig: ScaleConfig;
  /** La sucursal tiene su formato de etiquetas guardado (no el de fábrica): cuenta como lectura frente a la Systel. */
  scaleCalibrated?: boolean;
  /** C5: "loading"/"unknown" = todavía no se conoce el formato de la balanza: no se lee ninguna etiqueta. */
  scaleConfigStatus?: ScaleConfigStatus;
  accounts: TreasuryAccount[];
  shift: PosShift | null;
  busy: boolean;
  setMessage: (message: string) => void;
  setShowShiftTotals: (show: boolean) => void;
  /** Leer el detalle del TOTAL de una Systel desde la balanza: solo empresas de la prueba piloto. */
  systelTicketPilot?: boolean;
  /** Sucursal activa: para la balanza "artículos + TOTAL" configurada en ella (migración 119). */
  scaleBranchId?: string | null;
  /** Zona de precios del local (plan Empresa, migración 192): el precio de cada renglón si no se eligió otra lista.
   * Las etiquetas de la balanza con importe se cobran por lo que dicen (la balanza ya tiene los precios de la zona). */
  zoneListId?: string | null;
  /** Pantalla a pedido 'etiquetas_caja' (migración 198): leer etiquetas de cajas del frigorífico. */
  boxLabels?: boolean;
  /** Pantalla a pedido 'freezer' (migración 214): una etiqueta guardada en el freezer del local sale de ahí al venderla. */
  freezer?: boolean;
}

export function useSaleTicket({ products, categories, scaleConfig, scaleCalibrated = false, scaleConfigStatus = "ready", accounts, shift, busy, setMessage, setShowShiftTotals, systelTicketPilot = false, scaleBranchId = null, zoneListId = null, boxLabels = false, freezer = false }: SaleTicketDeps) {
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [showProductTable, setShowProductTable] = useState(false);
  const [baseCart, setCart] = useState<TicketLine[]>([]);
  /** Lista de precios de lo que se agrega (botón Minorista / Mayorista, migración 167); null = minorista. */
  const [priceListId, setPriceListId] = useState<string | null>(null);
  /** Minorista y mayorista en el mismo ticket (dueño, 2026-11-10: "tendría que estar todo junto"): la lista
   * propia de cada línea (null = minorista). Una línea sin entrada sigue al botón de arriba. */
  const [lineLists, setLineLists] = useState<Record<string, string | null>>({});
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // El ticket que se ve y se cobra: cada línea con su lista (withPriceList no pierde el precio minorista,
  // así volver a Minorista deja todo como estaba). Minorista en un local con zona = precio de la zona.
  const cart = useMemo(
    () =>
      baseCart.map((l) => {
        const chosen = lineListFor(l.key, lineLists, priceListId);
        return withPriceList(l, l.productId ? productById.get(l.productId) : undefined, chosen ?? (zoneListId && l.scaleAmount === undefined ? zoneListId : null));
      }),
    [baseCart, lineLists, productById, priceListId, zoneListId]
  );
  /** El carrito de este momento, para lo que corre después de una consulta (escanear no espera a la pantalla). */
  const cartRef = useRef(cart);
  cartRef.current = cart;
  // Una línea que se quitó no deja su lista guardada (si vuelve a entrar, sigue al botón de arriba).
  useEffect(() => {
    setLineLists((prev) => {
      const keys = new Set(baseCart.map((l) => l.key));
      const kept = Object.entries(prev).filter(([k]) => keys.has(k));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [baseCart]);
  /** Botón de arriba: cambia el precio de lo que se agregue desde ahora; lo que ya está en el ticket queda como estaba. */
  function choosePriceList(listId: string | null) {
    if (listId === priceListId) return;
    setLineLists((prev) => keepCurrentLists(prev, baseCart, priceListId));
    setPriceListId(listId);
  }
  /** "Cobrar todo a …": todas las líneas al precio del botón de arriba. */
  function applyPriceListToAll() {
    setLineLists({});
  }
  /** Cambiar una sola línea: a Minorista, o a la lista del botón de arriba. */
  function setLinePriceList(key: string, listId: string | null) {
    setLineLists((prev) => ({ ...prev, [key]: listId }));
  }
  const mixedPrices = baseCart.some((l) => l.kind === "product" && lineListFor(l.key, lineLists, priceListId) !== priceListId);
  /** Varios tickets de la balanza con el mismo total: la persona elige cuál (nunca a ciegas). */
  const [scaleTicketChoices, setScaleTicketChoices] = useState<{ amount: number; candidates: TicketCandidate[]; charged: SystelTicket[] } | null>(null);
  const [readingScaleTicket, setReadingScaleTicket] = useState(false);
  // Cualquier sucursal con una balanza "artículos + TOTAL" sincronizada desde Mi balanza (scale_profiles activo).
  // Sin perfil (todas las Kretz y quien no tiene balanza), useScalePapers no hace nada: Mostrador sigue igual.
  const papers = useScalePapers({ enabled: !!scaleBranchId, branchId: scaleBranchId, products, cart, setCart, setMessage });
  // Formatos de etiqueta de las balanzas Systel ACTIVAS de la sucursal, de la base (por balanza; auditoría 29/10).
  // Sin datos en la base (sucursal sin balanza registrada), la copia guardada en esta PC, como antes.
  const dbSystelTemplates = useMemo(() => templatesFromSetups(papers.setups), [papers.setups]);
  const systelTemplatesList = (): SystelLabelTemplates[] => {
    if (dbSystelTemplates.length > 0) return dbSystelTemplates;
    const local = loadSystelLabelTemplates();
    return local ? [local] : [];
  };
  /** Etiqueta ambigua esperando que la persona elija qué es (regla de oro, 26/11). */
  const [labelChoice, setLabelChoice] = useState<{ raw: string; options: LabelChoiceOption[]; note?: string; systelConfig: ScaleConfig | null } | null>(null);
  function pickLabelChoice(index: number) {
    const c = labelChoice;
    setLabelChoice(null);
    const option = c?.options[index];
    if (!c || !option) return;
    if (option.pick.type === "systel") {
      papers.handleScan(c.raw);
      searchInputRef.current?.focus();
      return;
    }
    handleResolved(c.raw, option.pick, c.systelConfig);
  }
  function dismissLabelChoice() {
    setLabelChoice(null);
    setMessage("No se agregó nada: buscá el producto por nombre y cargá lo que dice el papel.");
    searchInputRef.current?.focus();
  }
  /** Clave del TOTAL de balanza que se está detallando (ticket-detail.ts), o null. */
  const [detailing, setDetailing] = useState<string | null>(null);
  /** Etiquetas de balanza escaneadas en ESTA venta (para avisar si se escanea dos veces la misma). */
  const scannedLabels = useRef<Set<string>>(new Set());
  const { formats: boxFormats } = useBoxLabelFormats(boxLabels);
  // Freezer (migración 214): las etiquetas guardadas en el freezer del local. Primero la última lista guardada (así
  // anda sin conexión), después la de la base: al abrir, cada 2 minutos y cuando se vacía el ticket (después de cobrar).
  const [freezerStored, setFreezerStored] = useState<FreezerStored[]>(() => (freezer && scaleBranchId ? cachedFreezerStored(scaleBranchId) : []));
  const cartEmpty = baseCart.length === 0;
  useEffect(() => {
    if (!freezer || !scaleBranchId) {
      setFreezerStored([]);
      return;
    }
    let cancelled = false;
    const load = () => void loadFreezerStored(scaleBranchId).then((list) => !cancelled && setFreezerStored(list)).catch(() => undefined);
    setFreezerStored(cachedFreezerStored(scaleBranchId));
    load();
    const timer = window.setInterval(load, 2 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [freezer, scaleBranchId]);
  useEffect(() => {
    if (!cartEmpty || !freezer || !scaleBranchId) return;
    void loadFreezerStored(scaleBranchId).then(setFreezerStored).catch(() => undefined);
  }, [cartEmpty, freezer, scaleBranchId]);
  const [itemDiscounts, setItemDiscounts] = useState<Record<string, string>>({});
  const [saleDiscount, setSaleDiscount] = useState("");
  const [saleDiscountMode, setSaleDiscountMode] = useState<"amount" | "percent" | "final">("amount");
  const [saleSurcharge, setSaleSurcharge] = useState("");
  const [saleSurchargeMode, setSaleSurchargeMode] = useState<"amount" | "percent">("amount");
  const [showDiscountForm, setShowDiscountForm] = useState(false);

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

  const grossTotal = cart.reduce((sum, line) => sum + lineGross(line), 0);

  // La conexión con la balanza Systel queda abierta mientras se está en Mostrador; se cierra al salir.
  useEffect(() => {
    // Empresas piloto con la Systel por cable: al entrar se lee con qué formato imprime los códigos.
    if (systelTicketPilot && systelTicketReadConfigured()) void refreshSystelLabelFormat();
    return () => void closeSystelTicketSession();
  }, [systelTicketPilot]);
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
  // Mismo redondeo que el servidor (roundToPeso): con Math.round, 1,035 kg × $14.300 quedaba $1 abajo.
  const total = roundToPeso(Math.max(grossTotal - itemDiscountTotal - saleDiscountValue + saleSurchargeValue, 0));
  const hasAdjustment = itemDiscountTotal > 0 || saleDiscountValue > 0 || saleSurchargeValue > 0;

  const isSplit = payments.length > 1;
  const singleAccount = !isSplit ? accounts.find((a) => a.id === payments[0]?.accountId) ?? null : null;
  const isSingleCash = !isSplit && singleAccount?.paymentMethod === "cash";
  const tenderedValue = cashTendered ? parseAmount(cashTendered) : null;
  const change = isSingleCash && tenderedValue !== null && Number.isFinite(tenderedValue) ? tenderedValue - total : null;
  const splitPaymentsTotal = payments.reduce((sum, p) => sum + (parseAmount(p.amount || "0") || 0), 0);
  const splitRemaining = total - splitPaymentsTotal;

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

  function quickAdd(product: Product, quantity = 1, source?: "scale") {
    // Detallando un TOTAL de la balanza: el producto elegido sale de ese total (con su importe del papel).
    if (detailing && !source) {
      detailProduct(product);
      return;
    }
    setMessage("");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setMessage("La cantidad debe ser mayor que cero.");
      return;
    }
    // Lo escaneado de un ticket de la balanza va en su propia línea (no se
    // mezcla con lo buscado a mano) y cuenta cuántos tickets son, para el
    // control de balanza del cierre.
    const key = source ? `${product.id}|scale` : product.id;
    setCart((current) => {
      const existing = current.find((l) => l.key === key);
      if (existing) {
        return current.map((l) =>
          l.key === key ? { ...l, quantity: l.quantity + quantity, ...(source ? { scaleTickets: (l.scaleTickets ?? 1) + 1 } : {}) } : l
        );
      }
      return [
        ...current,
        { key, kind: "product", productId: product.id, name: product.name, unit: product.unit, quantity, unitPrice: product.priceRetail, ...(source ? { source, scaleTickets: 1 } : {}) }
      ];
    });
    setSearch("");
    setHighlightedIndex(-1);
    // Después de agregar (con el mouse o el teclado) el foco vuelve solo al
    // buscador, para poder escanear o tipear el siguiente producto seguido.
    searchInputRef.current?.focus();
  }

  /** Paquete de la planta escaneado: una línea propia (cada paquete es uno) con el código, que la venta guarda y la
   * base usa para marcarlo vendido. Sin conexión no se puede leer: se carga el producto a mano. */
  async function addPackage(code: string) {
    if (cart.some((l) => l.packageCode === code)) {
      setMessage(`El paquete ${code} ya está en esta venta.`);
      return;
    }
    let pkg: Awaited<ReturnType<typeof findPackage>>;
    try {
      pkg = await findPackage(code);
    } catch {
      setMessage("No se pudo leer el paquete (¿sin internet?). Buscá el producto y escribí los kilos de la etiqueta.");
      return;
    }
    const problem = saleScanProblem(pkg ? { code, status: pkg.status } : undefined);
    const product = pkg ? products.find((p) => p.id === pkg.productId) : undefined;
    if (problem || !pkg) {
      setMessage(problem ?? "");
      return;
    }
    if (!product) {
      setMessage(`El producto del paquete ${code} no está a la venta en este local. Revisalo en Stock.`);
      return;
    }
    const quantity = pkg.quantity;
    setCart((current) => current.some((l) => l.packageCode === code)
      ? current
      : [...current, { key: `${product.id}|${code}`, kind: "product", productId: product.id, name: product.name, unit: product.unit, quantity, unitPrice: product.priceRetail, packageCode: code }]);
    setMessage(`Agregado: ${product.name}, ${quantity.toLocaleString("es-AR", { maximumFractionDigits: 3 })} ${product.unit === "kg" ? "kg" : "u."} (paquete ${code}).`);
    searchInputRef.current?.focus();
  }

  /** Agregar un producto elegido por nombre o código. Si hay balanza por cable
   * activada y el producto es por kg, el peso lo trae la balanza; si no se
   * puede leer, NO se agrega nada (mejor que vender 1 kg por error). */
  async function addProductFromSearch(product: Product) {
    if (detailing) {
      detailProduct(product);
      return;
    }
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
    if (manualUnit === "kg" && !manualQty.trim()) { setMessage("Ingresá los kilos."); return; }
    const qty = manualQty.trim() ? parseQuantity(manualQty) : 1;
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
    // Una elección pendiente (etiqueta ambigua) se descarta al escanear otra cosa: nunca se elige sola.
    if (labelChoice) setLabelChoice(null);

    // Paquete envasado en la planta (plan Planta, migración 194): su producto con sus kilos, al precio de hoy.
    if (isPackageCode(raw) && !products.some((p) => p.code === raw)) {
      setSearch("");
      setHighlightedIndex(-1);
      void addPackage(normalizePackageCode(raw));
      return;
    }

    // Bolsa del freezer (migración 214): la etiqueta de la balanza que se escaneó al guardarla. Entra en su propia línea
    // con los kilos que se guardaron, al precio de hoy, y viaja como scale_ticket "FRZ-" + código (sin importe): la base
    // la saca del freezer. Cada escaneo de la misma etiqueta es otra bolsa (dos bolsas del mismo peso), hasta que no quedan.
    if (freezerStored.length > 0 && !products.some((p) => (p.active ?? true) && p.code === raw)) {
      const inCart = cart.filter((l) => l.packageCode === freezerTicket(raw)).length;
      const bag = matchFreezerScan(raw, freezerStored, inCart);
      const product = bag ? products.find((p) => p.id === bag.productId) : undefined;
      if (bag && product) {
        // Si la misma etiqueta se vuelve a escanear y ya no quedan bolsas iguales, el camino común pregunta si va de nuevo.
        scannedLabels.current.add(raw);
        setSearch("");
        setHighlightedIndex(-1);
        setCart((current) => [
          ...current,
          { key: `${product.id}|freezer:${raw}#${inCart}`, kind: "product", productId: product.id, name: product.name, unit: product.unit, quantity: bag.quantity, unitPrice: product.priceRetail, packageCode: freezerTicket(raw) }
        ]);
        const qty = product.unit === "kg" ? `${bag.quantity.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : `${bag.quantity} u.`;
        setMessage(`Agregado: ${product.name} ${qty} (del freezer).`);
        searchInputRef.current?.focus();
        return;
      }
    }

    // Caja envasada al vacío con etiqueta del frigorífico (migración 198): su producto con los kilos de la caja, en su
    // propia línea (cada caja pesa distinto). Solo si la empresa cargó el formato, el código no es un producto, el
    // número de caja tiene producto (si no, null y sigue como siempre) y no es una etiqueta de la balanza de un
    // producto que existe (con los números del medio libres, una etiqueta "20…" también tiene forma de caja).
    const box = boxFormats.length > 0 && !products.some((p) => (p.active ?? true) && p.code === raw) ? resolveBoxScan(raw, boxFormats, products) : null;
    if (box && resolveScan(raw, products, scaleConfig).type !== "label") {
      setSearch("");
      setHighlightedIndex(-1);
      const key = `${box.product.id}|caja:${box.code}`;
      if (cart.some((l) => l.key === key)) {
        setMessage("Esa caja ya está en esta venta.");
        return;
      }
      setCart((current) => current.some((l) => l.key === key)
        ? current
        // packageCode viaja como pos_sale_items.scale_ticket (como los paquetes de Planta, sin importe): con eso la base
        // sabe que es una caja y le resta 1 a las cajas del producto (migración 201).
        : [...current, { key, kind: "product", productId: box.product.id, name: box.product.name, unit: box.product.unit, quantity: box.quantity, unitPrice: box.product.priceRetail, packageCode: boxTicket(box.code) }]);
      setMessage(`Agregado: ${box.detail}.`);
      searchInputRef.current?.focus();
      return;
    }

    // Qué es el código: UN resolvedor (scale-label-resolver.ts, puro y probado con etiquetas reales) junta la lectura
    // de las balanzas "artículos + TOTAL" de la sucursal (useScalePapers) y la del formato de la sucursal
    // (scan-resolve.ts). Con una sola lectura posible se carga; con dos distintas, la persona elige (regla de oro).
    // Systel piloto: el código de cada producto se lee con el formato que informó la balanza (no con el
    // de la sucursal, que puede haber quedado viejo: real Los gringos 09/10 → 13/10).
    const pilotConfig = systelTicketPilot ? systelConfigForCodeAcross(raw, systelTemplatesList()) : null;
    const systelConfig = pilotConfig === "no_soportado" ? null : pilotConfig;
    // Con el formato de la balanza, un producto sin precio en Patagonia se carga con el precio de lista 1 de la
    // balanza (provisorio: el importe real sale del TOTAL del ticket).
    const scanProducts = systelTicketPilot && systelConfig ? withScalePrices(products, mergedPerPlu(systelTemplatesList())) : products;
    const label = resolveScaleLabel(raw, { products: scanProducts, config: systelConfig ?? scaleConfig, calibrated: scaleCalibrated || !!systelConfig, setups: papers.setups, branchFormatCompetes: papers.otherBrand !== false, zoneListId, configStatus: systelConfig ? "ready" : scaleConfigStatus });
    if (label.type === "systel") {
      // La lee useScalePapers (avisos de etiqueta repetida, precio, carrito).
      papers.handleScan(raw);
      setSearch("");
      setHighlightedIndex(-1);
      return;
    }
    if (label.type === "not_ready") {
      setMessage(label.message);
      setSearch("");
      setHighlightedIndex(-1);
      return;
    }
    if (label.type === "systel_message") {
      setMessage(label.message);
      setSearch("");
      setHighlightedIndex(-1);
      return;
    }
    if (label.type === "ambiguous") {
      setSearch("");
      setHighlightedIndex(-1);
      setLabelChoice({ raw, options: label.options, note: label.note, systelConfig });
      setMessage("No se agregó nada: la etiqueta se puede leer de dos maneras. Elegí cuál es mirando el papel, o cargalo a mano.");
      return;
    }
    if (pilotConfig === "no_soportado") {
      setMessage("La balanza imprime el código de los productos con un formato que Patagonia no puede leer sin riesgo de cargar mal los kilos. No se agregó nada: buscá el producto y escribí los kilos del ticket, y avisá a soporte.");
      setSearch("");
      setHighlightedIndex(-1);
      return;
    }
    handleResolved(raw, label.resolution, systelConfig);
  }

  /** Lo que se hace con una lectura ya resuelta (al escanear, o al elegir una opción de una etiqueta ambigua). */
  function handleResolved(raw: string, resolved: ScanResolution, systelConfig: ScaleConfig | null) {
    const done = () => {
      setSearch("");
      setHighlightedIndex(-1);
    };

    // Regla de oro: dos lecturas válidas distintas → no se agrega nada; la persona elige (sin opción por defecto).
    if (resolved.type === "ambiguous") {
      done();
      setLabelChoice({ raw, options: scanChoiceOptions(resolved.options), note: resolved.note, systelConfig });
      setMessage("No se agregó nada: la etiqueta se puede leer de dos maneras. Elegí cuál es mirando el papel, o cargalo a mano.");
      return;
    }
    if (resolved.type === "error") {
      setMessage(resolved.message);
      done();
      return;
    }
    if (resolved.type === "systel_total") {
      done();
      // Si hay etiquetas de ese ticket esperando, el TOTAL confirma sus importes (no se vuelve a cargar nada).
      // No necesita la balanza conectada.
      if (systelTicketPilot && cart.some((l) => l.scalePending)) {
        void settlePendingWithTotal(raw, resolved.amount);
        return;
      }
      if (!systelTicketPilot || !systelTicketReadConfigured()) {
        setMessage(resolved.message);
        return;
      }
      void loadSystelTicket(raw, resolved.amount);
      return;
    }
    if (resolved.type === "ticket_without_amount") {
      setMessage(resolved.message);
      done();
      return;
    }
    // Paso 5 de la instalación de la balanza: Mostrador leyó bien una etiqueta (producto + cantidad).
    if (resolved.type === "label" && scaleBranchId) noteLabelRead(scaleBranchId, resolved.detail);
    // 125: un papel que ya está anulado en el control de la balanza se pregunta antes de cobrarlo
    // (real Haedo 13/10: anulado 14:14 y cobrado 14:24; el control lo restaba igual).
    if (resolved.type === "ticket_total" || resolved.type === "label") {
    const scan = resolved;
    const applyScaleScan = () => {
    const resolved = scan;
    if (resolved.type === "ticket_total") {
      const ticketTotal = resolved.amount;
      if (
        ticketTotal >= TICKET_TOTAL_CONFIRM_FROM &&
        !cart.some((l) => l.key === resolved.key || l.detailOf === resolved.key) &&
        !window.confirm(`El ticket de la balanza indica ${formatMoney(ticketTotal)}. ¿Coincide con el TOTAL impreso en el ticket?`)
      ) {
        setMessage("Ticket de la balanza no cargado. Revisá el importe o cargá los productos a mano.");
        done();
        return;
      }
      // C7 (dueño, 26/11): un TOTAL solo nunca se cobra sin productos. Se detalla, o confirma las etiquetas ya cargadas.
      // El carrito de AHORA (esto corre después de consultar si el papel ya se cobró o se anuló).
      const now = cartRef.current;
      const r = scanTotal(now, resolved.key, ticketTotal);
      if (r.kind === "detail" || r.kind === "confirmed") applyTotalScan(now, r.cart);
      if (r.kind === "detail") setDetailing(resolved.key);
      setMessage(r.message);
      done();
      searchInputRef.current?.focus();
      return;
    }
    if (resolved.type === "label") {
      if (scannedLabels.current.has(raw) && !window.confirm(SAME_SALE_LABEL_QUESTION)) {
        setMessage("No se agregó: esa etiqueta ya estaba en esta venta.");
        done();
        return;
      }
      scannedLabels.current.add(raw);
      if (
        !detailing &&
        cart.some((l) => l.source === "scale_total") &&
        !window.confirm("En esta venta hay un TOTAL de la balanza sin detallar. Si este producto es de ese ticket, tocá Cancelar, después \"Seguir detallando\" en esa línea y escanealo de nuevo (si no, se cobraría dos veces). ¿Agregarlo aparte?")
      ) {
        setMessage("No se agregó el producto.");
        done();
        return;
      }
      if (systelTicketPilot && systelConfig) {
        // Que el producto de la balanza sea el MISMO de Patagonia (nombre y forma de venta): real Los gringos,
        // los códigos 96-103 son otros productos y 29 se venden por unidad en la balanza y figuran por kg.
        const problem = scaleProductMismatch(resolved.product, resolved.plu, mergedPerPlu(systelTemplatesList()));
        if (problem) {
          setMessage(`No se agregó: ${problem}`);
          done();
          return;
        }
        // Una Cuora pesa hasta 31 kg: más que eso es un código mal leído (real El Dorado 29/10: $99.934 leído como 99,934 kg).
        if (resolved.product.unit === "kg" && !(resolved.quantity > 0 && resolved.quantity <= 31)) {
          setMessage(`No se agregó: la etiqueta se leyó como ${resolved.quantity.toLocaleString("es-AR")} kg, que no puede pesar una balanza. Conectá la balanza en "Balanza" para que Mostrador tome el formato de etiqueta que usa hoy, o cargá el producto a mano.`);
          done();
          return;
        }
        addPendingLabel(resolved.product, resolved.quantity);
        return;
      }
      // Fuera del piloto Systel (Kretz, formato de fábrica, El Dorado): una etiqueta de más de 31 kg casi seguro es un
      // formato mal leído (real El Dorado 29/10: $99.934 leído como 99,934 kg). Se pregunta mostrando el importe.
      const weightProblem = labelWeightProblem(resolved.product.unit, resolved.quantity);
      if (weightProblem === "invalido") {
        setMessage("No se agregó: la etiqueta no trae un peso válido. Cargá el producto a mano.");
        done();
        return;
      }
      if (weightProblem === "excesivo") {
        const charged = resolved.amount ?? resolved.quantity * resolved.product.priceRetail;
        if (!window.confirm(`La etiqueta se leyó como ${resolved.quantity.toLocaleString("es-AR")} kg de ${resolved.product.name} (${formatMoney(charged)}). Una balanza de mostrador pesa hasta ${MAX_COUNTER_SCALE_KG} kg: casi seguro el formato de la etiqueta está mal configurado. ¿Agregarlo igual?`)) {
          setMessage(`No se agregó: revisá que el peso del papel sea ${resolved.quantity.toLocaleString("es-AR")} kg, o cargá el producto a mano.`);
          done();
          return;
        }
      }
      // Detallando un TOTAL: la etiqueta es un producto de ese ticket (sus kilos y su importe salen de ese total).
      const detailKey = detailing;
      if (detailKey && cartRef.current.some((l) => l.key === detailKey)) {
        const scalePrice = productPrice(resolved.product, zoneListId);
        const amount = resolved.amount ?? Math.round(resolved.quantity * scalePrice * 100) / 100;
        const priced = { ...resolved.product, priceRetail: scalePrice };
        const r = addDetailScan(cartRef.current, detailKey, priced, resolved.quantity, amount);
        done();
        if (!r.ok) {
          scannedLabels.current.delete(raw);
          setMessage(`No se agregó: ${r.reason}.`);
          return;
        }
        setCart((current) => {
          const now = addDetailScan(current, detailKey, priced, resolved.quantity, amount);
          return now.ok ? now.cart : current;
        });
        finishDetailStep(r);
        return;
      }
      if (resolved.amount !== undefined) {
        // La etiqueta trae el importe (Kretz Aura en Pre-Empaque): se cobra el importe del papel, exacto, en su propia
        // línea (dos papeles del mismo producto son dos líneas). Mismo camino que el ticket leído de una Systel.
        const amount = resolved.amount;
        const product = resolved.product;
        const stamp = `${raw}@${Date.now()}`;
        setCart((current) => [
          ...current,
          { key: `${product.id}|${stamp}`, kind: "product", productId: product.id, name: product.name, unit: product.unit, quantity: resolved.quantity, unitPrice: amount / resolved.quantity, source: "scale", scaleTickets: 1, scaleAmount: amount, scaleTicket: stamp }
        ]);
        setMessage(`Agregado: ${resolved.detail}, ${formatMoney(amount)}.`);
        done();
        return;
      }
      quickAdd(resolved.product, resolved.quantity, "scale");
      setMessage(`Agregado: ${resolved.detail}.`);
      return;
    }
    };
    if (!shift || !isSupabaseConfigured || (scan.type === "label" && systelTicketPilot && systelConfig)) {
      applyScaleScan();
      return;
    }
    done();
    // Las dos consultas (¿anulado? ¿ya cobrado?) salen juntas: escanear no se hace más lento.
    const charged = findAlreadyCharged(shift.id, scan);
    void scanUnlessVoided(shift.id, raw, () => void unlessAlreadyCharged(charged, applyScaleScan));
    return;
    }
    if (resolved.type === "product") {
      void addProductFromSearch(resolved.product);
      return;
    }

    const picked = searchMatches[activeMatchIndex];
    if (picked) {
      void addProductFromSearch(picked);
      return;
    }

    // Una caja cuyo número todavía no tiene producto: se dice cómo asociarlo (en vez de "no se encontró").
    setMessage((boxFormats.length > 0 && boxProblem(raw, boxFormats, products)) || "No se encontró ningún producto con ese código.");
  }

  /**
   * ¿Ese papel de la balanza ya se cobró en los turnos del control (otra venta, otra caja)? Se pregunta, nunca se
   * bloquea (find_scale_ticket_sale, migración 125). Sin conexión o con error, no frena la venta.
   */
  async function findAlreadyCharged(shiftId: string, scan: { type: "label"; product: Product; quantity: number; amount?: number } | { type: "ticket_total"; amount: number; key: string }): Promise<ChargedHit | null> {
    let hit: ChargedHit | null = null;
    try {
      if (scan.type === "label") {
        hit = await findScaleTicketSale(shiftId, { productId: scan.product.id, weightKg: scan.quantity, amount: scan.amount ?? scan.quantity * scan.product.priceRetail });
      } else {
        hit = await findScaleTicketSale(shiftId, { productId: null, weightKg: null, amount: scan.amount });
        // Un TOTAL que se detalló se guarda como productos: se busca por su clave.
        if (!hit) {
          const charged = await chargedScaleTickets([detailedTotalKey(scan.key)]);
          if (charged?.size) hit = { createdAt: null, amount: scan.amount, by: null };
        }
      }
    } catch {
      hit = null;
    }
    return hit;
  }

  async function unlessAlreadyCharged(found: Promise<ChargedHit | null>, apply: () => void) {
    const hit = await found;
    if (hit && !window.confirm(chargedTicketQuestion(hit))) {
      setMessage("No se agregó: ese ticket de la balanza ya estaba cobrado.");
      searchInputRef.current?.focus();
      return;
    }
    apply();
  }

  /** Si el papel ya está anulado en los turnos del control: "¿Cobrarlo igual?" y, si sí, ofrece deshacer
   * la anulación. Sin conexión no frena la venta (findScaleTicketVoid devuelve null enseguida). */
  async function scanUnlessVoided(shiftId: string, barcode: string, apply: () => void) {
    const hit = await findScaleTicketVoid(shiftId, barcode);
    if (!hit) {
      apply();
      return;
    }
    if (!window.confirm(voidedTicketQuestion(hit))) {
      setMessage("No se cargó: ese ticket estaba anulado.");
      searchInputRef.current?.focus();
      return;
    }
    const undo = window.confirm(undoVoidQuestion(hit));
    apply();
    if (!undo) return;
    try {
      await undoScaleTicketVoid(shiftId, hit.id);
      setMessage(`Se deshizo la anulación de las ${hourAr(hit.createdAt)}: el control de la balanza ya no resta ese ticket.`);
    } catch (err) {
      setMessage(`Se cargó el ticket, pero no se pudo deshacer la anulación: ${err instanceof Error ? err.message : "error"}. Avisá al encargado.`);
    }
  }

  function removeFromCart(key: string) {
    // Un ticket de la balanza ya confirmado se saca entero (sus artículos van juntos).
    const keys = new Set(cart.find((l) => l.key === key)?.scalePaper ? papers.keysToRemove(key) : detailGroupKeys(cart, key));
    if (detailing && keys.has(detailing)) setDetailing(null);
    setCart((current) => current.filter((l) => !keys.has(l.key)));
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
        // Cantidad e importe de un ticket leído de la balanza: no se cambian a mano (sacá la línea si no va).
        if (l.scaleTicket) return l;
        // Los productos por kg se cargan con precisión de gramos (0.001); los
        // que son por unidad o caja no tienen sentido en fracciones.
        const quantity = l.unit === "kg" ? parsed : Math.round(parsed);
        return { ...l, quantity };
      })
    );
  }

  /**
   * TOTAL de una Systel con la balanza conectada por cable: se lee el detalle del ticket de la balanza
   * (función 72, solo lectura) y se carga cada artículo con los gramos o unidades que ella registró.
   * Si no se puede leer o algo no coincide, NO se carga nada (ni el total sin stock).
   */
  /**
   * Systel con código por producto: cada etiqueta trae producto + cantidad, pero no el precio que se cobró
   * (lista 1, lista 2 o manual). El artículo queda "esperando el TOTAL" hasta que se escanea el código del TOTAL
   * del ticket, y ahí se calcula el importe de cada uno (systel-ticket-settle.ts). Sin conexión con la balanza.
   */
  function addPendingLabel(product: Product, quantity: number) {
    const p1 = mergedPerPlu(systelTemplatesList())[product.code]?.p1 ?? 0;
    const unitPrice = product.priceRetail > 0 ? product.priceRetail : p1;
    setCart((current) => [
      ...current,
      { key: `${product.id}|etiqueta|${Date.now()}|${current.length}`, kind: "product", productId: product.id, name: product.name, unit: product.unit, quantity, unitPrice, source: "scale", scaleTickets: 1 }
    ]);
    // Como cualquier etiqueta de balanza: entra con su precio y listo, sin esperar el TOTAL (dueño, 2026-11-03).
    const qty = product.unit === "kg" ? `${quantity.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : `${quantity} u.`;
    setMessage(`Agregado: ${product.name} ${qty}.`);
    setSearch("");
    setHighlightedIndex(-1);
    searchInputRef.current?.focus();
  }

  /** TOTAL escaneado con artículos de etiqueta esperando: se reparte el total entre ellos (precio de la balanza). */
  async function settlePendingWithTotal(code: string, amount: number) {
    const pending = cart.filter((l) => l.scalePending);
    const templateList = systelTemplatesList();
    const perPlu = mergedPerPlu(templateList);
    const decoded = decodeSumCode(code, templateList.find((t) => t.sums)?.sums ?? null);
    const prices = new Map<number, ScalePrices>();
    const settleLines = pending.map((l) => {
      const product = products.find((p) => p.id === l.productId);
      const entry = product ? perPlu[product.code] : undefined;
      const plu = Number(product?.code ?? 0);
      if (entry && (entry.p1 ?? 0) > 0) prices.set(plu, { p1: entry.p1 ?? 0, p2: entry.p2 ?? 0 });
      return { plu, quantity: l.quantity };
    });
    let r = settleTicket(settleLines, amount, prices, decoded.ok ? decoded.articles : null);
    if (!r.ok && r.needsPaper) {
      // No se adivina: el importe de cada artículo se copia del ticket impreso y tiene que sumar el TOTAL.
      const typed: number[] = [];
      for (const l of pending) {
        const qty = l.unit === "kg" ? `${l.quantity.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : `${l.quantity} u.`;
        const v = window.prompt(`No se puede saber con seguridad el precio de cada artículo (${r.reason}).
Escribí el IMPORTE impreso en el ticket para:
${l.name} ${qty}`);
        const n = v === null ? NaN : parseAmount(v);
        if (!(n > 0)) {
          setMessage("No se confirmaron los importes (falta el importe de un artículo).");
          return;
        }
        typed.push(Math.round(n));
      }
      const sum = typed.reduce((x, y) => x + y, 0);
      if (Math.abs(sum - Math.round(amount)) > 1) {
        setMessage(`No se confirmaron los importes: los que escribiste suman ${formatMoney(sum)} y el TOTAL del ticket es ${formatMoney(amount)}.`);
        return;
      }
      r = { ok: true, method: "exacto", amounts: typed, detail: "importes copiados del ticket impreso" };
    }
    if (!r.ok) {
      setMessage(`No se confirmaron los importes: ${r.reason}. Revisá que hayas escaneado todos los artículos de ese ticket (y ninguno de otro).`);
      return;
    }
    const day = localDateIso();
    const keys = pending.map((_, i) => `systel-total:${day}:${code}:${i}`);
    const charged = await chargedScaleTickets(keys).catch(() => null);
    if (charged && charged.size > 0 && !window.confirm(`Hoy ya se cobró un ticket con este mismo TOTAL (${formatMoney(amount)}) y los mismos artículos. ¿Es OTRO ticket igual? (Si es el mismo papel, tocá Cancelar.)`)) {
      setMessage("No se confirmó: ese ticket ya estaba cobrado.");
      return;
    }
    const suffix = charged && charged.size > 0 ? `:${Date.now()}` : "";
    const byKey = new Map(pending.map((l, i) => [l.key, i]));
    setCart((current) =>
      current.map((l) => {
        const i = byKey.get(l.key);
        if (i === undefined) return l;
        return { ...l, scalePending: false, scaleAmount: r.amounts[i], unitPrice: r.amounts[i] / l.quantity, scaleTicket: `${keys[i]}${suffix}` };
      })
    );
    setMessage(`Importes confirmados con el TOTAL (${formatMoney(amount)}): ${r.detail}.`);
  }

  async function loadSystelTicket(code: string, amount: number) {
    if (readingScaleTicket) return;
    setReadingScaleTicket(true);
    setScaleTicketChoices(null);
    setMessage(`Leyendo en la balanza el detalle del ticket de ${formatMoney(amount)}… no desenchufes el cable.`);
    // Tickets ya cargados en esta venta (por identidad) + cobrados en una venta NO anulada (base, cualquier PC).
    // Sin conexión con la base vale lo cobrado en esta computadora.
    const usedKeys = cart.flatMap((l) => (l.scaleTicket ? [l.scaleTicket] : []));
    const charged = async (keys: string[]) => (await chargedScaleTickets(keys)) ?? new Set(loadChargedSystelTickets().filter((k) => keys.includes(k)));
    const read = await readSystelTicketFromScale({ code, amount, products, usedKeys, charged });
    setReadingScaleTicket(false);
    const r = read.result;
    if (!r.ok) {
      setMessage(
        r.stage === "lectura"
          ? `No se cargó nada: no se pudo leer el ticket en la balanza (${r.reason}). Escaneá el TOTAL de nuevo en unos segundos.`
          : r.stage === "sin_ventas"
            ? `No se cargó nada: ${r.reason}. Cargá cada producto buscándolo y escribiendo los kilos que dice el ticket.`
            : `No se cargó nada: ${r.reason}.`
      );
    } else if (r.candidates.length === 1 && r.charged.length === 0) {
      addScaleTicket(r.candidates[0]);
    } else {
      // Mismo total (y misma cantidad de artículos): NO se elige a ciegas. Y si hay uno igual ya cobrado,
      // el papel escaneado puede ser ese mismo (reescaneo): se pide confirmar aunque quede uno solo.
      setScaleTicketChoices({ amount, candidates: r.candidates, charged: r.charged });
      setMessage(
        r.charged.length > 0
          ? `Hay ${r.charged.length === 1 ? "otro ticket" : `${r.charged.length} tickets`} de ${formatMoney(amount)} igual${r.charged.length === 1 ? "" : "es"} ya cobrado${r.charged.length === 1 ? "" : "s"}. Confirmá con la hora y el N.º de operación impresos si el papel que tenés es uno sin cobrar.`
          : `Hoy hay ${r.candidates.length} tickets de ${formatMoney(amount)} sin cobrar en la balanza. Elegí cuál es mirando la hora y el N.º de operación impresos en el ticket.`
      );
    }
    // A soporte le llega cómo fue la lectura (sin pedirle nada al cliente). C26: solo códigos, formatos y el resultado;
    // nunca los renglones de venta ni las respuestas de la balanza, que traen los importes de los clientes.
    const report = systelTicketSupportReport({ code, result: r, context: read.context, log: read.log, events: read.events });
    void submitScaleSupportReport({
      note: report.note,
      logText: report.logText,
      connections: [{ displayName: "Systel (Mostrador)", driverId: "systel-cuora_max", status: "lectura", settings: {}, confirmedCapabilities: [], pairedAt: "", connectedNow: true, diagnosticRecord: report.diagnosticRecord } as never],
      branchId: null
    }).catch(() => {});
  }

  /** Carga los artículos de UN ticket de la balanza: cantidad e importe de la balanza, una línea por artículo. */
  function addScaleTicket(c: TicketCandidate) {
    setScaleTicketChoices(null);
    if (!c.lines) {
      setMessage(`No se cargó nada: ${c.problem}.`);
      return;
    }
    if (c.lines.some((l) => cart.some((x) => x.scaleTicket === l.lineKey))) {
      setMessage("Ese ticket de la balanza ya está cargado en esta venta.");
      return;
    }
    const lines = c.lines;
    setCart((current) => [
      ...current,
      ...lines.map((l, i) => ({
        key: `${l.product.id}|${c.key}|${i}`,
        kind: "product" as const,
        productId: l.product.id,
        name: l.product.name,
        unit: l.product.unit,
        quantity: l.quantity,
        unitPrice: l.amount / l.quantity,
        source: "scale" as const,
        scaleTickets: 1,
        scaleAmount: l.amount,
        scaleTicket: l.lineKey
      }))
    ]);
    const detail = lines.map((l) => `${l.product.name} ${l.product.unit === "kg" ? `${l.quantity.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : `${l.quantity} u.`} ${formatMoney(l.amount)}`).join(" + ");
    setMessage(`Ticket N.º ${Number(c.ticket.ticketId)} de la balanza (${c.ticket.firstTime}): ${detail}.`);
    searchInputRef.current?.focus();
  }

  /** Después de cobrar (o encolar) la venta: esos tickets de la balanza ya no se pueden volver a cargar. */
  function commitScaleTickets() {
    const keys = cart.flatMap((l) => (l.scaleTicket ? [l.scaleTicket] : []));
    if (keys.length) saveChargedSystelTickets([...loadChargedSystelTickets(), ...new Set(keys)]);
  }

  /** Empezar a detallar un TOTAL de balanza: los próximos productos que se elijan salen de ese total. */
  function startTicketDetail(key: string) {
    const left = detailRemaining(cart, key);
    if (left === null) return;
    setDetailing(key);
    setMessage(`Detallando el ticket: escaneá la etiqueta de cada producto, o buscalo y escribí el importe impreso. Faltan ${formatMoney(left)}.`);
    searchInputRef.current?.focus();
  }

  function stopTicketDetail() {
    setDetailing(null);
    setMessage("Detalle en pausa. El TOTAL sigue sin detallar: hasta que lo detalles entero (o lo saques) no se puede cobrar.");
  }

  function detailProduct(product: Product) {
    if (!detailing) return;
    const left = detailRemaining(cart, detailing);
    if (left === null) {
      setDetailing(null);
      return;
    }
    const typed = window.prompt(`Importe de "${product.name}" impreso en el ticket de la balanza.\nFaltan ${formatMoney(left)}.`);
    setSearch("");
    setHighlightedIndex(-1);
    if (typed === null) return;
    const r = addDetailLine(cart, detailing, { ...product, priceRetail: productPrice(product, zoneListId) }, parseAmount(typed) || 0);
    if (!r.ok) {
      setMessage(`No se agregó: ${r.reason}.`);
      return;
    }
    setCart(r.cart);
    finishDetailStep(r);
  }

  function finishDetailStep(r: { cart: TicketLine[]; done: boolean; remaining: number; line: TicketLine }) {
    const key = r.line.detailOf ?? detailing;
    if (r.done) {
      const n = r.cart.filter((l) => l.detailOf === key).length;
      setDetailing(null);
      setMessage(`Ticket detallado: ${n} ${n === 1 ? "producto" : "productos"}, suma exacto el TOTAL. Descuentan stock al cobrar.`);
    } else {
      setMessage(`Agregado: ${r.line.name}, ${formatMoney(r.line.scaleAmount ?? 0)}. Faltan ${formatMoney(r.remaining)} para el TOTAL.`);
    }
    searchInputRef.current?.focus();
  }

  /** Aplica lo que devolvió scanTotal sobre el carrito real (sin perder lo que se haya agregado mientras tanto). */
  function applyTotalScan(before: TicketLine[], after: TicketLine[]) {
    const changed = new Map<string, TicketLine>();
    before.forEach((l, i) => {
      if (after[i] && after[i] !== l) changed.set(l.key, after[i]);
    });
    const added = after.slice(before.length);
    setCart((current) => [
      ...current.map((l) => {
        const c = changed.get(l.key);
        return c ? { ...l, key: c.key, detailOf: c.detailOf, scaleTickets: c.scaleTickets, scaleTicket: c.scaleTicket } : l;
      }),
      ...added.filter((x) => !current.some((l) => l.key === x.key))
    ]);
  }

  function clearTicket() {
    setDetailing(null);
    setLabelChoice(null);
    scannedLabels.current = new Set();
    setScaleTicketChoices(null);
    papers.reset();
    setCart([]);
    setPriceListId(null);
    setLineLists({});
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

  /** Lista con la que se muestran los precios al buscar: la elegida o la zona del local. */
  const displayListId = priceListId ?? zoneListId;
  return { priceListId, setPriceListId: choosePriceList, applyPriceListToAll, setLinePriceList, mixedPrices, displayListId, search, setSearch, highlightedIndex, setHighlightedIndex, showProductTable, setShowProductTable, cart, setCart, itemDiscounts, setItemDiscounts, saleDiscount, setSaleDiscount, saleDiscountMode, setSaleDiscountMode, saleSurcharge, setSaleSurcharge, saleSurchargeMode, setSaleSurchargeMode, showDiscountForm, setShowDiscountForm, showManualForm, setShowManualForm, weighing, setWeighing, manualDesc, setManualDesc, manualPrice, setManualPrice, manualQty, setManualQty, manualUnit, setManualUnit, payments, setPayments, confirmCharge, setConfirmCharge, cashTendered, setCashTendered, focusRowIndex, setFocusRowIndex, searchInputRef, accountSelectRefs, amountInputRefs, cashTenderedRef, chargeButtonRef, grossTotal, itemDiscountTotal, saleSurchargeRaw, saleSurchargeValue, saleDiscountRaw, saleDiscountValue, total, hasAdjustment, isSplit, singleAccount, isSingleCash, tenderedValue, change, splitPaymentsTotal, splitRemaining, filteredProducts, CATEGORY_LESS_LABEL, productGroups, searchMatches, activeMatchIndex, quickAdd, addProductFromSearch, addManualItem, handleSearchKeyDown, removeFromCart, updateCartQuantity, clearTicket, detailing, startTicketDetail, stopTicketDetail, commitScaleTickets, papers, scaleConfigStatus, labelChoice, pickLabelChoice, dismissLabelChoice, readingScaleTicket, scaleTicketChoices, setScaleTicketChoices, addScaleTicket, addPaymentRow, removePaymentRow, updatePaymentRow, selectSinglePaymentAccount };
}

export type SaleTicket = ReturnType<typeof useSaleTicket>;

const CHARGED_SYSTEL_TICKETS_KEY = "patagonia-systel-charged-tickets";

function loadChargedSystelTickets(): string[] {
  try {
    const raw = localStorage.getItem(CHARGED_SYSTEL_TICKETS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveChargedSystelTickets(keys: string[]): void {
  try {
    localStorage.setItem(CHARGED_SYSTEL_TICKETS_KEY, JSON.stringify(keys.slice(-1000)));
  } catch {
    // sin localStorage: el control queda solo dentro de la venta
  }
}

/** Productos con el precio de lista 1 de la balanza donde Patagonia no tiene precio (solo para leer etiquetas). */
function withScalePrices(products: Product[], perPlu: NonNullable<SystelLabelTemplates["perPlu"]>): Product[] {
  return products.map((p) => (p.priceRetail > 0 || !(perPlu[p.code]?.p1 ?? 0) ? p : { ...p, priceRetail: perPlu[p.code]!.p1! }));
}

/** ¿El producto de la etiqueta (según lo leído de la balanza) es el mismo de Patagonia? null si sí; si no, el motivo. */
function scaleProductMismatch(product: Product, plu: string, perPlu: NonNullable<SystelLabelTemplates["perPlu"]>): string | null {
  const e = perPlu[String(Number(plu))];
  if (!e || !e.name || !e.saleType) return `el producto ${plu} todavía no se leyó de la balanza (hacé el "Diagnóstico completo" en Stock → Balanza).`;
  if (!sameProductName(e.name, product.name)) return `en la balanza el producto ${plu} es "${e.name}" y en Patagonia es "${product.name}": son productos distintos.`;
  const weighed = e.saleType === "P" || e.saleType === "C";
  if (weighed !== (product.unit === "kg")) return `"${product.name}" se vende ${weighed ? "por peso" : "por unidad"} en la balanza y ${product.unit === "kg" ? "por kg" : "por unidad"} en Patagonia: hay que corregirlo en Stock.`;
  return null;
}
