import { useEffect, useRef, useState } from "react";
import type { Product, TreasuryAccount } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import type { ProductCategory } from "../inventory/product-categories-service";
import { parseTicketTotalBarcode, parseWeightBarcode, TICKET_TOTAL_CONFIRM_FROM, type ScaleConfig } from "./scale-config-service";
import { isWeightScaleEnabled, readScaleWeight } from "./scale-weight";
import type { PosShift } from "./pos-shift-service";
import type { PaymentRow, TicketLine } from "./sale-model";

// Estado y acciones del ticket que se está armando en Mostrador: búsqueda,
// carrito, descuentos y recargos, medios de pago y sus totales. Es la parte
// "de la venta en curso" de Sale.tsx; el cobro en sí (checkout) sigue en la
// pantalla porque toca turno, comprobantes y cola sin conexión.

export interface SaleTicketDeps {
  products: Product[];
  categories: ProductCategory[];
  scaleConfig: ScaleConfig;
  accounts: TreasuryAccount[];
  shift: PosShift | null;
  busy: boolean;
  setMessage: (message: string) => void;
  setShowShiftTotals: (show: boolean) => void;
}

export function useSaleTicket({ products, categories, scaleConfig, accounts, shift, busy, setMessage, setShowShiftTotals }: SaleTicketDeps) {
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

  return { search, setSearch, highlightedIndex, setHighlightedIndex, showProductTable, setShowProductTable, cart, setCart, itemDiscounts, setItemDiscounts, saleDiscount, setSaleDiscount, saleDiscountMode, setSaleDiscountMode, saleSurcharge, setSaleSurcharge, saleSurchargeMode, setSaleSurchargeMode, showDiscountForm, setShowDiscountForm, showManualForm, setShowManualForm, weighing, setWeighing, manualDesc, setManualDesc, manualPrice, setManualPrice, manualQty, setManualQty, manualUnit, setManualUnit, payments, setPayments, confirmCharge, setConfirmCharge, cashTendered, setCashTendered, focusRowIndex, setFocusRowIndex, searchInputRef, accountSelectRefs, amountInputRefs, cashTenderedRef, chargeButtonRef, grossTotal, itemDiscountTotal, saleSurchargeRaw, saleSurchargeValue, saleDiscountRaw, saleDiscountValue, total, hasAdjustment, isSplit, singleAccount, isSingleCash, tenderedValue, change, splitPaymentsTotal, splitRemaining, filteredProducts, CATEGORY_LESS_LABEL, productGroups, searchMatches, activeMatchIndex, quickAdd, addProductFromSearch, addManualItem, handleSearchKeyDown, removeFromCart, updateCartQuantity, clearTicket, addPaymentRow, removePaymentRow, updatePaymentRow, selectSinglePaymentAccount };
}
