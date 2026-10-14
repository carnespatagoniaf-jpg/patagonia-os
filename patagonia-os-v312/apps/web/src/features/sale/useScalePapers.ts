import { useEffect, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { formatMoney, localDateIso } from "../shifts/format";
import { decodeScaleCode, type DecodedScan } from "../scales/sale/profile";
import { addLibreFromPaper, addScannedItem, closePaper, describeItem, emptyPaper, paperFingerprint, setLibreAmount, type Paper } from "../scales/sale/paper";
import { loadScaleSetup, type ScaleSetup } from "../scales/sale/scale-sale-service";
import type { CreatePosSaleInput } from "./sale-service";
import type { TicketLine } from "./sale-model";

/**
 * Mostrador con balanza "artículos + TOTAL" (migración 119; lógica en features/scales/sale).
 *
 * Flujo del cajero:
 * 1. Escanea el código de cada producto del papel: queda "esperando el TOTAL".
 * 2. Escanea el TOTAL: se valida la cantidad de artículos y que la suma dé EXACTO.
 * 3. Cobra como siempre. El stock baja al cobrar, una sola vez (create_pos_scale_sale).
 *
 * Solo pregunta lo que no se puede saber del código:
 * - el importe de una venta libre;
 * - los importes del papel si hubo precio a mano;
 * - "¿es otro ticket igual?".
 *
 * Solo se activa si la sucursal tiene una balanza de venta configurada (scale_profiles).
 */

interface OpenPaper {
  id: string;
  paper: Paper;
  keys: string[];
}
interface ConfirmedPaper {
  id: string;
  fingerprint: string;
  ticketDate: string;
  total: number;
  articles: number | null;
  keys: string[];
  repeatConfirmed: boolean;
}

const newPaper = (): OpenPaper => ({ id: `papel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, paper: emptyPaper(), keys: [] });

export function useScalePapers(deps: {
  enabled: boolean;
  branchId: string | null;
  products: Product[];
  cart: TicketLine[];
  setCart: React.Dispatch<React.SetStateAction<TicketLine[]>>;
  setMessage: (m: string) => void;
}) {
  const { enabled, branchId, products, cart, setCart, setMessage } = deps;
  const [setup, setSetup] = useState<ScaleSetup | null>(null);
  const [open, setOpen] = useState<OpenPaper>(newPaper);
  const [confirmed, setConfirmed] = useState<ConfirmedPaper[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || !branchId) {
      setSetup(null);
      return;
    }
    let alive = true;
    const load = () => void loadScaleSetup(branchId).then((s) => alive && setSetup(s));
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
    if (!setup) return false;
    const d = decodeScaleCode(raw, setup.profile);
    if (d.kind === "not_scale") return false;
    if (d.kind === "error") {
      setMessage(`No se agregó: ${d.reason}.`);
      return true;
    }
    if (d.kind === "total") {
      closeOpen(d);
      return true;
    }
    const r = addScannedItem(open.paper, d, setup.links, products);
    if (!r.ok) {
      setMessage(r.reason);
      return true;
    }
    const key = lineKey();
    setCart((c) => [...c, lineFor(r.item, key, open.id)]);
    setOpen({ ...open, paper: r.paper, keys: [...open.keys, key] });
    setMessage(`Agregado: ${describeItem(r.item)}. Seguí con los demás productos de ese ticket y al final escaneá el TOTAL.`);
    return true;
  }

  function closeOpen(total: Extract<DecodedScan, { kind: "total" }>) {
    if (open.paper.items.length === 0) {
      setMessage("Ese es el TOTAL del ticket. Primero escaneá el código de cada producto (el que está debajo de cada uno) y al final el TOTAL.");
      return;
    }
    let paper = open.paper;
    const keys = [...open.keys];
    const added: TicketLine[] = [];
    let r = closePaper(paper, total);
    for (let step = 0; step < 4 && !r.ok; step++) {
      if (r.need === "fix" && total.articles !== null && total.articles > paper.items.length) {
        const missing = total.articles - paper.items.length;
        if (!window.confirm(`El ticket dice ${total.articles} artículos y escaneaste ${paper.items.length}.\n\n¿Lo que falta es VENTA LIBRE de la balanza (precio puesto a mano, sin código debajo)?\n\nAceptar = escribir su importe.\nCancelar = escaneá el producto que falta.`)) break;
        for (let i = 0; i < missing; i++) {
          const n = Math.round(parseAmount(window.prompt(`Importe de la venta libre ${missing > 1 ? `${i + 1} de ${missing} ` : ""}(está en el ticket impreso):`) ?? "") || 0);
          if (!(n > 0)) {
            setMessage("No se confirmó el ticket: falta el importe de la venta libre.");
            return;
          }
          paper = addLibreFromPaper(paper, n);
          const key = lineKey();
          keys.push(key);
          added.push(lineFor(paper.items[paper.items.length - 1], key, open.id));
        }
      } else if (r.need === "libre_amounts") {
        for (const idx of r.indexes) {
          const n = Math.round(parseAmount(window.prompt(`Importe de "${describeItem(paper.items[idx])}" (venta libre, está en el ticket impreso):`) ?? "") || 0);
          if (!(n > 0)) {
            setMessage("No se confirmó el ticket: falta el importe de la venta libre.");
            return;
          }
          paper = setLibreAmount(paper, idx, n);
        }
      } else if (r.need === "confirm_split" && window.confirm(`Mirá el ticket impreso: ${r.question}.\n\n¿Es así?\n\nAceptar = sí.\nCancelar = escribir el importe de cada uno.`)) {
        r = closePaper(paper, total, undefined, { acceptSplit: true });
        continue;
      } else if (r.need === "paper_amounts" || r.need === "confirm_split") {
        const ask = r.need === "confirm_split" ? "Escribí el IMPORTE impreso en el ticket para:" : `No se puede saber con seguridad el precio de cada producto (${r.reason}).\nEscribí el IMPORTE impreso en el ticket para:`;
        const amounts: number[] = [];
        for (const it of paper.items) {
          if (it.kind !== "product") continue;
          const n = Math.round(parseAmount(window.prompt(`${ask}\n${describeItem(it)}`) ?? "") || 0);
          if (!(n > 0)) {
            setMessage("No se confirmó el ticket: falta el importe de un producto.");
            return;
          }
          amounts.push(n);
        }
        r = closePaper(paper, total, amounts);
        continue;
      } else {
        break;
      }
      r = closePaper(paper, total);
    }
    if (!r.ok) {
      setMessage(`No se confirmó el ticket: ${r.reason}.`);
      return;
    }
    const amounts = r.amounts;
    const fingerprint = paperFingerprint(total.barcode, paper);
    // ¿El mismo papel se cobró recién en ESTA caja, o ya está en esta venta? Se pregunta solo dentro de la ventana
    // (real: con 3 minutos, 6 avisos por semana en vez de 94). Las otras cajas las controla el servidor al cobrar.
    const windowMs = (setup?.repeatWindowMinutes ?? 3) * 60_000;
    const recentHere = loadRecentPapers().find((x) => x.fp === fingerprint && Date.now() - x.at < windowMs);
    const inThisSale = confirmed.some((p) => p.fingerprint === fingerprint);
    let repeatConfirmed = false;
    if (recentHere || inThisSale) {
      const when = recentHere ? `en esta caja hace ${Math.max(1, Math.round((Date.now() - recentHere.at) / 60_000))} min` : "en esta misma venta";
      if (!window.confirm(`Este mismo ticket de la balanza ya se cobró ${when}.\n\n¿Es OTRO ticket igual (otro cliente que llevó exactamente lo mismo)?\n\nAceptar = sí, es otro.\nCancelar = es el mismo papel: no se agrega.`)) {
        const drop = new Set(keys);
        setCart((c) => c.filter((l) => !drop.has(l.key)));
        setOpen(newPaper());
        setMessage("No se agregó: ese ticket de la balanza ya estaba cobrado.");
        return;
      }
      repeatConfirmed = true;
    }
    const byKey = new Map(keys.map((k, i) => [k, i]));
    setCart((c) =>
      [...c, ...added].map((l) => {
        const i = byKey.get(l.key);
        if (i === undefined) return l;
        const it = paper.items[i];
        return it.kind === "product"
          ? { ...l, scalePending: false, scaleAmount: amounts[i], unitPrice: Math.round((amounts[i] / l.quantity) * 100) / 100, scaleTicket: `${fingerprint}#${i}` }
          : { ...l, scalePending: false, unitPrice: amounts[i] };
      })
    );
    setConfirmed((c) => [...c, { id: open.id, fingerprint, ticketDate: localDateIso(), total: total.amount, articles: total.articles, keys, repeatConfirmed }]);
    setOpen(newPaper());
    setMessage(`Ticket de la balanza confirmado: ${formatMoney(total.amount)} (${r.detail}).`);
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
    if (idx >= 0) setOpen({ ...open, paper: { items: open.paper.items.filter((_, i) => i !== idx) }, keys: open.keys.filter((k) => k !== key) });
    return [key];
  }

  function reset() {
    setOpen(newPaper());
    setConfirmed([]);
  }

  /** Datos para create_pos_scale_sale, o un motivo para no cobrar todavía. */
  function payload(lines: TicketLine[]): { scale?: CreatePosSaleInput["scale"]; error?: string } {
    if (!setup || lines.every((l) => !l.scalePaper)) return {};
    if (lines.some((l) => l.scalePending)) return { error: "Falta escanear el código del TOTAL del ticket de la balanza." };
    const papers = confirmed.map((p) => ({ fingerprint: p.fingerprint, ticketDate: p.ticketDate, total: p.total, articles: p.articles, repeatConfirmed: p.repeatConfirmed, items: p.keys.map((k) => lines.findIndex((l) => l.key === k)) }));
    if (papers.some((p) => p.items.some((i) => i < 0)) || lines.some((l) => l.scalePaper && !confirmed.some((p) => p.keys.includes(l.key)))) {
      return { error: "Un ticket de la balanza quedó incompleto: sacalo y escanealo de nuevo." };
    }
    return { scale: { scaleKey: setup.profile.scaleKey, papers } };
  }

  /** Venta cobrada (o guardada sin conexión): sus papeles quedan como "recién cobrados en esta caja". */
  function commit() {
    saveRecentPapers([...loadRecentPapers(), ...confirmed.map((p) => ({ fp: p.fingerprint, at: Date.now() }))]);
  }

  function confirmRepeat() {
    setConfirmed((c) => c.map((p) => ({ ...p, repeatConfirmed: true })));
  }

  const pendingCount = cart.filter((l) => l.scalePending).length;
  return { setup, active: !!setup, handleScan, keysToRemove, reset, payload, confirmRepeat, commit, pendingCount };
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

function lineFor(it: Paper["items"][number], key: string, paperId: string): TicketLine {
  if (it.kind === "product") {
    return { key, kind: "product", productId: it.productId!, name: it.name, unit: it.unit === "kg" ? "kg" : "unit", quantity: it.quantity, unitPrice: it.prices[0] ?? 0, source: "scale", scaleTickets: 1, scalePending: true, scalePaper: paperId, scaleCode: it.scaleCode };
  }
  const qty = it.barcode && it.unit === "kg" ? ` ${it.quantity.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : "";
  return { key, kind: "manual", name: `${it.name}${qty}`, unit: "unit", quantity: 1, unitPrice: it.amount ?? 0, scalePending: true, scalePaper: paperId, scaleCode: it.scaleCode };
}

export type ScalePapers = ReturnType<typeof useScalePapers>;
