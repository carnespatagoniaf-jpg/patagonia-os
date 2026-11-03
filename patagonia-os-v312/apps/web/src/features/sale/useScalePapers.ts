import { useEffect, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { formatMoney } from "../shifts/format";
import { decodeAcross } from "../scales/sale/multi-decode";
import { addScannedItem, describeItem, emptyPaper, type Paper } from "../scales/sale/paper";
import { loadScaleSetups, type ScaleSetup } from "../scales/sale/scale-sale-service";
import type { CreatePosSaleInput } from "./sale-service";
import type { TicketLine } from "./sale-model";
import { SAME_SALE_LABEL_QUESTION } from "./scale-repeat";

/**
 * Mostrador con balanza "artículos + TOTAL" (migración 119; lógica en features/scales/sale).
 *
 * Flujo del cajero (2026-11-03, dueño: "igual que todas las balanzas: escanea cada producto y listo"):
 * escanea el código de cada producto (de uno o de varios tickets) y cada uno entra con el precio de Patagonia,
 * como una etiqueta de Kretz. El TOTAL del ticket ya no hace falta y no se pregunta nada: antes cada producto
 * quedaba "esperando el TOTAL" y al cerrar el papel se pedían importes a mano (Los gringos, muy lento con gente).
 * Una venta libre de la balanza (sin producto de Patagonia) no se puede cobrar sola: se carga a mano.
 * El precio de la balanza puede ser distinto al de Patagonia: manda el de Patagonia (mantener la balanza al día).
 *
 * Solo se activa si la sucursal tiene una balanza de venta configurada (scale_profiles). Con varias (migración
 * 133), cada código se lee con la balanza que lo imprimió (multi-decode.ts) y un papel es siempre de UNA balanza.
 */

interface OpenPaper {
  id: string;
  paper: Paper;
  keys: string[];
  /** Balanza del papel (la del primer artículo escaneado). */
  scaleKey: string | null;
}
interface ConfirmedPaper {
  id: string;
  fingerprint: string;
  ticketDate: string;
  total: number;
  articles: number | null;
  keys: string[];
  repeatConfirmed: boolean;
  scaleKey: string;
}

const newPaper = (): OpenPaper => ({ id: `papel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, paper: emptyPaper(), keys: [], scaleKey: null });

export function useScalePapers(deps: {
  enabled: boolean;
  branchId: string | null;
  products: Product[];
  cart: TicketLine[];
  setCart: React.Dispatch<React.SetStateAction<TicketLine[]>>;
  setMessage: (m: string) => void;
}) {
  const { enabled, branchId, products, cart, setCart, setMessage } = deps;
  const [setups, setSetups] = useState<ScaleSetup[]>([]);
  const [open, setOpen] = useState<OpenPaper>(newPaper);
  const [confirmed, setConfirmed] = useState<ConfirmedPaper[]>([]);
  const seq = useRef(0);
  /** Códigos escaneados en esta venta: el mismo papel dos veces (la pistola leyó doble) se pregunta, como en Kretz. */
  const scanned = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled || !branchId) {
      setSetups([]);
      return;
    }
    let alive = true;
    const load = () => void loadScaleSetups(branchId).then((s) => alive && setSetups(s));
    load();
    // Si el dueño cambió un vínculo en Stock, la caja lo toma al volver a esta pestaña.
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, branchId]);

  const lineKey = () => `${open.id}|${++seq.current}`;

  /** true si el código era de la balanza (se agregó, o se explicó por qué no). false = sigue el camino normal. */
  function handleScan(raw: string): boolean {
    if (setups.length === 0) return false;
    const m = decodeAcross(raw, setups, open.paper.items.length ? open.scaleKey : null, undefined, open.paper.items.length || null);
    if (m.kind === "not_scale") return false;
    if (m.kind === "ambiguous") {
      setMessage("No se agregó: dos balanzas de esta sucursal imprimen ese mismo código y no se puede saber de cuál es. Avisale a soporte de Patagonia.");
      return true;
    }
    const { setup, decoded: d } = m;
    // Un artículo que dos balanzas leen igual queda con la primera; el TOTAL dice de cuál es (no es "otra balanza").
    if (d.kind !== "total" && open.paper.items.length > 0 && open.scaleKey && open.scaleKey !== setup.profile.scaleKey) {
      setMessage("Ese código es de otra balanza. Primero terminá el ticket que estás cargando: escaneá su TOTAL.");
      return true;
    }
    if (d.kind === "not_scale") return false;
    if (d.kind === "error") {
      setMessage(`No se agregó: ${d.reason}.`);
      return true;
    }
    if (d.kind === "total") {
      setMessage(cart.some((l) => l.source === "scale")
        ? "El TOTAL del ticket no hace falta: los productos ya están cargados con su precio."
        : "Ese es el TOTAL del ticket. Escaneá el código de cada producto (el que está debajo de cada uno): el TOTAL no hace falta.");
      return true;
    }
    const r = addScannedItem(emptyPaper(), d, setup.links, products);
    if (!r.ok) {
      setMessage(r.reason);
      return true;
    }
    const it = r.item;
    if (it.kind !== "product" || !it.productId) {
      setMessage(`No se agregó: ${describeItem(it)} es venta libre de la balanza (sin producto de Patagonia). Cargala a mano con su importe.`);
      return true;
    }
    if (scanned.current.has(raw) && !window.confirm(SAME_SALE_LABEL_QUESTION)) {
      setMessage("No se agregó: esa etiqueta ya estaba en esta venta.");
      return true;
    }
    scanned.current.add(raw);
    const product = products.find((p) => p.id === it.productId);
    const unitPrice = product && product.priceRetail > 0 ? product.priceRetail : it.prices[0] ?? 0;
    const key = lineKey();
    setCart((c) => [...c, { key, kind: "product", productId: it.productId!, name: it.name, unit: it.unit === "kg" ? "kg" : "unit", quantity: it.quantity, unitPrice, source: "scale", scaleTickets: 1 }]);
    setMessage(`Agregado: ${describeItem(it)}.`);
    return true;
  }

  /** Claves que hay que sacar junto con esta línea (un papel confirmado va entero). */
  function keysToRemove(key: string): string[] {
    const paper = confirmed.find((p) => p.keys.includes(key));
    if (paper) {
      setConfirmed((c) => c.filter((p) => p.id !== paper.id));
      setMessage(`Se sacó el ticket de la balanza de ${formatMoney(paper.total)} entero: sus artículos van juntos.`);
      return paper.keys;
    }
    const idx = open.keys.indexOf(key);
    if (idx >= 0) {
      const keys = open.keys.filter((k) => k !== key);
      setOpen({ ...open, paper: { items: open.paper.items.filter((_, i) => i !== idx) }, keys, scaleKey: keys.length ? open.scaleKey : null });
    }
    return [key];
  }

  function reset() {
    scanned.current = new Set();
    setOpen(newPaper());
    setConfirmed([]);
  }

  /** Datos para create_pos_scale_sale, o un motivo para no cobrar todavía. */
  function payload(lines: TicketLine[]): { scale?: CreatePosSaleInput["scale"]; error?: string } {
    if (setups.length === 0 || lines.every((l) => !l.scalePaper)) return {};
    if (lines.some((l) => l.scalePending)) return { error: "Falta escanear el código del TOTAL del ticket de la balanza." };
    const papers = confirmed.map((p) => ({ fingerprint: p.fingerprint, ticketDate: p.ticketDate, total: p.total, articles: p.articles, repeatConfirmed: p.repeatConfirmed, items: p.keys.map((k) => lines.findIndex((l) => l.key === k)) }));
    if (papers.some((p) => p.items.some((i) => i < 0)) || lines.some((l) => l.scalePaper && !confirmed.some((p) => p.keys.includes(l.key)))) {
      return { error: "Un ticket de la balanza quedó incompleto: sacalo y escanealo de nuevo." };
    }
    // create_pos_scale_sale recibe UNA balanza: los tickets de dos balanzas distintas van en ventas separadas.
    const keysUsed = [...new Set(confirmed.map((p) => p.scaleKey))];
    if (keysUsed.length > 1) return { error: "Esta venta tiene tickets de dos balanzas distintas. Cobrá los de cada balanza en una venta aparte." };
    return { scale: { scaleKey: keysUsed[0], papers } };
  }

  /** Venta cobrada (o guardada sin conexión): sus papeles quedan como "recién cobrados en esta caja". */
  function commit() {
    saveRecentPapers([...loadRecentPapers(), ...confirmed.map((p) => ({ fp: p.fingerprint, at: Date.now() }))]);
  }

  function confirmRepeat() {
    setConfirmed((c) => c.map((p) => ({ ...p, repeatConfirmed: true })));
  }

  const pendingCount = cart.filter((l) => l.scalePending).length;
  return { setups, active: setups.length > 0, handleScan, keysToRemove, reset, payload, confirmRepeat, commit, pendingCount };
}

const RECENT_KEY = "patagonia-scale-papers-recent";
function loadRecentPapers(): Array<{ fp: string; at: number }> {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Array<{ fp: string; at: number }>;
  } catch {
    return [];
  }
}
function saveRecentPapers(list: Array<{ fp: string; at: number }>) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.filter((x) => Date.now() - x.at < 86_400_000).slice(-500)));
  } catch {
    // sin localStorage: queda el control del servidor
  }
}

export type ScalePapers = ReturnType<typeof useScalePapers>;
