import { useEffect, useRef, useState } from "react";
import type { Product, TreasuryAccount } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import type { ProductCategory } from "../inventory/product-categories-service";
import { parseTicketTotalBarcode, parseWeightBarcode, TICKET_TOTAL_CONFIRM_FROM, type ScaleConfig } from "./scale-config-service";
import { isWeightScaleEnabled, readScaleWeight } from "./scale-weight";
import { resolveScan } from "./scan-resolve";
import { closeSystelTicketSession, readSystelTicketFromScale, refreshSystelLabelFormat, systelTicketReadConfigured } from "../inventory/systel/systel-ticket-from-scale";
import { loadSystelLabelTemplates, systelConfigForCode } from "./systel-label-format";
import type { TicketCandidate } from "../inventory/systel/systel-ticket-detail";
import type { SystelTicket } from "../inventory/systel/systel-sales";
import { chargedScaleTickets } from "./sale-service";
import { submitScaleSupportReport } from "../scales/support-service";
import type { PosShift } from "./pos-shift-service";
import { lineGross, type PaymentRow, type TicketLine } from "./sale-model";
import { parseQuantity } from "./quantity";

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
  /** Leer el detalle del TOTAL de una Systel desde la balanza: solo empresas de la prueba piloto. */
  systelTicketPilot?: boolean;
}

export function useSaleTicket({ products, categories, scaleConfig, accounts, shift, busy, setMessage, setShowShiftTotals, systelTicketPilot = false }: SaleTicketDeps) {
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [showProductTable, setShowProductTable] = useState(false);
  const [cart, setCart] = useState<TicketLine[]>([]);
  /** Varios tickets de la balanza con el mismo total: la persona elige cuál (nunca a ciegas). */
  const [scaleTicketChoices, setScaleTicketChoices] = useState<{ amount: number; candidates: TicketCandidate[]; charged: SystelTicket[] } | null>(null);
  const [readingScaleTicket, setReadingScaleTicket] = useState(false);
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

  function quickAdd(product: Product, quantity = 1, source?: "scale") {
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

    // Qué es el código (producto, ticket de total, etiqueta de balanza o error): scan-resolve.ts,
    // lógica pura y probada con etiquetas reales. Acá solo quedan los avisos y el carrito.
    // Systel piloto: el código de cada producto se lee con el formato que informó la balanza (no con el
    // de la sucursal, que puede haber quedado viejo: real Los gringos 09/10 → 13/10).
    const systelConfig = systelTicketPilot ? systelConfigForCode(raw, loadSystelLabelTemplates()) : null;
    if (systelConfig === "no_soportado") {
      setMessage("La balanza imprime el código de los productos con un formato que Patagonia no puede leer sin riesgo de cargar mal los kilos. No se agregó nada: buscá el producto y escribí los kilos del ticket, y avisá a soporte.");
      setSearch("");
      setHighlightedIndex(-1);
      return;
    }
    const resolved = resolveScan(raw, products, systelConfig ?? scaleConfig);
    const done = () => {
      setSearch("");
      setHighlightedIndex(-1);
    };

    if (resolved.type === "error") {
      setMessage(resolved.message);
      done();
      return;
    }
    if (resolved.type === "systel_total") {
      done();
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
    if (resolved.type === "ticket_total") {
      const ticketTotal = resolved.amount;
      if (cart.some((l) => l.key === resolved.key)) {
        setMessage("Ese ticket de la balanza ya está cargado en esta venta.");
      } else if (
        // Con la balanza imprimiendo un código por producto, el ticket trae también el del total:
        // si ya se escanearon los productos, cargar el total los cobraría dos veces.
        cart.some((l) => l.source === "scale") &&
        !window.confirm("Ya escaneaste productos de la balanza en esta venta. Si son de este mismo ticket, NO cargues también el total (se cobraría dos veces). ¿Cargar el total igual?")
      ) {
        setMessage("No se cargó el total del ticket.");
      } else if (
        ticketTotal >= TICKET_TOTAL_CONFIRM_FROM &&
        !window.confirm(`El ticket de la balanza indica ${formatMoney(ticketTotal)}. ¿Coincide con el TOTAL impreso en el ticket?`)
      ) {
        setMessage("Ticket de la balanza no cargado. Revisá el importe o cargá los productos a mano.");
      } else {
        setCart((current) => [...current, { key: resolved.key, kind: "manual", name: "Ticket de balanza", unit: "unit", quantity: 1, unitPrice: ticketTotal, source: "scale_total", scaleTickets: 1 }]);
        setMessage(`Ticket de balanza cargado: ${formatMoney(ticketTotal)}. Ojo: el total no dice qué productos son, así que no descuenta stock.`);
      }
      done();
      return;
    }
    if (resolved.type === "label") {
      if (
        cart.some((l) => l.source === "scale_total") &&
        !window.confirm("En esta venta ya está cargado el TOTAL de un ticket de la balanza. Si este producto es de ese mismo ticket, se cobraría dos veces. ¿Agregarlo igual?")
      ) {
        setMessage("No se agregó el producto.");
        done();
        return;
      }
      quickAdd(resolved.product, resolved.quantity, "scale");
      setMessage(`Agregado: ${resolved.detail}.`);
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
    // Todo lo que fue y vino por el cable le llega a soporte (sin pedirle nada al cliente).
    void submitScaleSupportReport({
      note: `Systel · Mostrador: detalle del ticket ${code} ($${amount}) · ${r.ok ? `OK: ${r.candidates.length} ticket(s) posible(s)` : `${r.stage}: ${r.reason}`}`,
      logText: JSON.stringify({ context: read.context, result: r.ok ? r.candidates.map((c) => ({ key: c.key, lines: c.ticket.lines, problem: c.problem })) : r }),
      connections: [{ displayName: "Systel (Mostrador)", driverId: "systel-cuora_max", status: "lectura", settings: {}, confirmedCapabilities: [], pairedAt: "", connectedNow: true, diagnosticRecord: { log: read.log.slice(-200), linkEvents: read.events.slice(-600) } } as never],
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

  function clearTicket() {
    setScaleTicketChoices(null);
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

  return { search, setSearch, highlightedIndex, setHighlightedIndex, showProductTable, setShowProductTable, cart, setCart, itemDiscounts, setItemDiscounts, saleDiscount, setSaleDiscount, saleDiscountMode, setSaleDiscountMode, saleSurcharge, setSaleSurcharge, saleSurchargeMode, setSaleSurchargeMode, showDiscountForm, setShowDiscountForm, showManualForm, setShowManualForm, weighing, setWeighing, manualDesc, setManualDesc, manualPrice, setManualPrice, manualQty, setManualQty, manualUnit, setManualUnit, payments, setPayments, confirmCharge, setConfirmCharge, cashTendered, setCashTendered, focusRowIndex, setFocusRowIndex, searchInputRef, accountSelectRefs, amountInputRefs, cashTenderedRef, chargeButtonRef, grossTotal, itemDiscountTotal, saleSurchargeRaw, saleSurchargeValue, saleDiscountRaw, saleDiscountValue, total, hasAdjustment, isSplit, singleAccount, isSingleCash, tenderedValue, change, splitPaymentsTotal, splitRemaining, filteredProducts, CATEGORY_LESS_LABEL, productGroups, searchMatches, activeMatchIndex, quickAdd, addProductFromSearch, addManualItem, handleSearchKeyDown, removeFromCart, updateCartQuantity, clearTicket, commitScaleTickets, readingScaleTicket, scaleTicketChoices, setScaleTicketChoices, addScaleTicket, addPaymentRow, removePaymentRow, updatePaymentRow, selectSinglePaymentAccount };
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
