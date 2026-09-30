/**
 * Cruce automático entre las líneas del resumen del banco y el lado "sistema"
 * de esa cuenta del banco. Solo SUGIERE: la persona confirma. Lógica pura
 * (sin Supabase) para poder testearla.
 *
 * Diseñado con un resumen REAL (Banco Provincia, septiembre 2026, 1.227
 * líneas) contra los cobros reales de Mostrador:
 * - Transferencias: el banco trae cada una suelta y Mostrador guarda cada
 *   cobro suelto (pos_sale_payments) → uno a uno, mismo importe, de 3 días
 *   antes a 7 después. En el caso real cruzaron 258 de 321 (80%).
 * - Tarjetas: el banco acredita por lote, por marca, días hábiles después y
 *   con la comisión descontada ("PAGOS A COMERCIOS VISA - L. …"). No se
 *   cruzan venta por venta: se muestran por período (vendido vs acreditado).
 * - Pagos a proveedores, gastos, etc.: movimientos de Tesorería, uno a uno.
 */

export interface MatchLine {
  id: string;
  date: string;
  /** Positivo = entró plata, negativo = salió. */
  amount: number;
  description: string;
}

export interface SystemItem {
  id: string;
  /** "payment" = cobro de Mostrador; "movement" = movimiento de Tesorería. */
  source: "payment" | "movement";
  date: string;
  /** Con signo, como lo vería el banco: cobros y entradas positivos, salidas negativas. */
  amount: number;
  /** Cobro con tarjeta (cuenta marcada como posnet): no se cruza uno a uno. */
  isCard: boolean;
  label: string;
}

export interface MatchSuggestion {
  lineId: string;
  itemIds: string[];
  /** "exact": mismo importe al centavo. "near": mismo cobro con unos pesos de diferencia (se revisa). */
  kind: "exact" | "near";
  /** banco − sistema (0 en las exactas). Al confirmar una "near" se registra como ajuste. */
  difference: number;
}

/** Tope de diferencia para "casi igual": $500 o 2% de lo cobrado, lo que sea mayor (igual que la base, migración 105). */
export function nearTolerance(amount: number): number {
  return Math.max(500, Math.abs(amount) * 0.02);
}

export const MAX_DAYS_BEFORE = 3;
export const MAX_DAYS_AFTER = 7;

const CARD_DEPOSIT = /pagos? a comercios|liquidaci[oó]n|\bliq\b|acred.*(visa|master|cabal|amex|naranja|maestro|d[eé]bito|cr[eé]dito)|prisma|first ?data|fiserv|getnet|payway|posnet|lapos|clover/i;
const TAX = /\bimp(uesto)?\b|ley\s*25\.?413|\biibb\b|ingresos brutos|sellos|percep|retenc|\biva\b|ganancias|sircreb/i;

export function isCardDeposit(line: Pick<MatchLine, "amount" | "description">): boolean {
  return line.amount > 0 && CARD_DEPOSIT.test(line.description);
}

export function isTaxLine(line: Pick<MatchLine, "amount" | "description">): boolean {
  return line.amount < 0 && TAX.test(line.description);
}

function toDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Uno a uno: mismo importe al centavo y mismo signo. Entre varios candidatos,
 * el de fecha más cercana (a igual distancia, mejor "el banco igual o después").
 * Las acreditaciones de tarjeta y los cobros con tarjeta no participan.
 */
export function suggestMatches(lines: MatchLine[], items: SystemItem[]): MatchSuggestion[] {
  const used = new Set<string>();
  const byAmount = new Map<number, SystemItem[]>();
  for (const item of items) {
    if (item.isCard) continue;
    const key = cents(item.amount);
    const list = byAmount.get(key) ?? [];
    list.push(item);
    byAmount.set(key, list);
  }

  const suggestions: MatchSuggestion[] = [];
  const sorted = [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const line of sorted) {
    if (isCardDeposit(line)) continue;
    const candidates = byAmount.get(cents(line.amount));
    if (!candidates) continue;
    const lineDay = toDay(line.date);
    let best: SystemItem | null = null;
    let bestScore = Infinity;
    for (const item of candidates) {
      if (used.has(item.id)) continue;
      const lag = lineDay - toDay(item.date); // positivo: el banco lo muestra después
      if (lag < -MAX_DAYS_BEFORE || lag > MAX_DAYS_AFTER) continue;
      const score = lag >= 0 ? lag : 0.5 - lag;
      if (score < bestScore || (score === bestScore && best && item.date < best.date)) {
        best = item;
        bestScore = score;
      }
    }
    if (best) {
      used.add(best.id);
      suggestions.push({ lineId: line.id, itemIds: [best.id], kind: "exact", difference: 0 });
    }
  }

  // Segunda pasada, como hacen los sistemas contables grandes: "casi
  // iguales" (mismo signo, fecha cercana, diferencia chica). Se eligen las
  // parejas de menor diferencia primero, para no robarle el cobro a otra línea.
  const matchedLines = new Set(suggestions.map((s) => s.lineId));
  const pairs: { line: MatchLine; item: SystemItem; diff: number; lag: number }[] = [];
  const freeItems = items.filter((i) => !i.isCard && !used.has(i.id));
  for (const line of sorted) {
    if (matchedLines.has(line.id) || isCardDeposit(line)) continue;
    const lineDay = toDay(line.date);
    for (const item of freeItems) {
      if (Math.sign(item.amount) !== Math.sign(line.amount)) continue;
      const lag = lineDay - toDay(item.date);
      if (lag < -MAX_DAYS_BEFORE || lag > MAX_DAYS_AFTER) continue;
      const diff = Math.round((line.amount - item.amount) * 100) / 100;
      if (diff === 0 || Math.abs(diff) > nearTolerance(item.amount)) continue;
      pairs.push({ line, item, diff, lag });
    }
  }
  pairs.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || Math.abs(a.lag) - Math.abs(b.lag));
  for (const p of pairs) {
    if (matchedLines.has(p.line.id) || used.has(p.item.id)) continue;
    matchedLines.add(p.line.id);
    used.add(p.item.id);
    suggestions.push({ lineId: p.line.id, itemIds: [p.item.id], kind: "near", difference: p.diff });
  }
  return suggestions;
}

export type Channel = "transferencias" | "tarjetas" | "billeteras" | "otros";

export const CHANNEL_LABELS: Record<Channel, string> = {
  transferencias: "Transferencias",
  tarjetas: "Tarjetas",
  billeteras: "Billeteras / QR / DEBIN",
  otros: "Otras entradas"
};

/** Por dónde entró una línea del banco (según el texto del banco). */
export function bankChannel(line: Pick<MatchLine, "amount" | "description">): Channel {
  if (isCardDeposit(line)) return "tarjetas";
  if (/debin|mercado ?pago|\bmodo\b|\bqr\b|ual[aá]|naranja ?x|brubank|billetera/i.test(line.description)) return "billeteras";
  if (/transf|transferencia|\btrf\b|\bcvu\b|\bcbu\b/i.test(line.description)) return "transferencias";
  return "otros";
}

export interface ChannelRow {
  channel: Channel;
  bank: number;
  bankCount: number;
  system: number;
  systemCount: number;
  difference: number;
}

/**
 * Resumen "banco vs sistema" de lo que ENTRÓ en el período, por vía (el
 * informe que arman las empresas para explicar la diferencia). Solo entradas.
 */
export function summarizeByChannel(bankLines: MatchLine[], systemInflows: { amount: number; channel: Channel }[]): ChannelRow[] {
  const rows = new Map<Channel, ChannelRow>();
  const row = (channel: Channel) => {
    let r = rows.get(channel);
    if (!r) {
      r = { channel, bank: 0, bankCount: 0, system: 0, systemCount: 0, difference: 0 };
      rows.set(channel, r);
    }
    return r;
  };
  for (const line of bankLines) {
    if (line.amount <= 0) continue;
    const r = row(bankChannel(line));
    r.bank += line.amount;
    r.bankCount++;
  }
  for (const item of systemInflows) {
    if (item.amount <= 0) continue;
    const r = row(item.channel);
    r.system += item.amount;
    r.systemCount++;
  }
  const order: Channel[] = ["transferencias", "tarjetas", "billeteras", "otros"];
  return order
    .filter((c) => rows.has(c))
    .map((c) => {
      const r = rows.get(c)!;
      r.bank = Math.round(r.bank * 100) / 100;
      r.system = Math.round(r.system * 100) / 100;
      r.difference = Math.round((r.bank - r.system) * 100) / 100;
      return r;
    });
}

export interface CardSummary {
  sold: number;
  soldCount: number;
  deposited: number;
  depositCount: number;
  /** vendido − acreditado: comisiones y retenciones + lo que todavía no se acreditó. */
  difference: number;
  /** Diferencia sobre lo vendido (si todo ya se acreditó, es el costo de las tarjetas). */
  differencePct: number | null;
}

export function summarizeCards(cardItems: SystemItem[], depositLines: MatchLine[]): CardSummary {
  const sold = Math.round(cardItems.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const deposited = Math.round(depositLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const difference = Math.round((sold - deposited) * 100) / 100;
  return {
    sold,
    soldCount: cardItems.length,
    deposited,
    depositCount: depositLines.length,
    difference,
    differencePct: sold > 0 ? Math.round((difference / sold) * 1000) / 10 : null
  };
}

/**
 * Agrupa líneas "iguales" que están en el banco y no en el sistema (ej. los 89
 * "IMPUESTO CREDITO -LEY 25413" del mes) para cargarlas de una vez. Se agrupa
 * por las primeras palabras del texto, sin números.
 */
export function groupSimilarLines<T extends MatchLine>(lines: T[], minSize = 3): { label: string; lines: T[]; total: number }[] {
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    const label = line.description.replace(/[0-9]+/g, " ").replace(/[^\p{L}]+/gu, " ").trim().toUpperCase().split(" ").slice(0, 4).join(" ");
    if (!label) continue;
    const key = `${line.amount < 0 ? "-" : "+"}${label}`;
    const list = groups.get(key) ?? [];
    list.push(line);
    groups.set(key, list);
  }
  return Array.from(groups.entries())
    .filter(([, list]) => list.length >= minSize)
    .map(([key, list]) => ({ label: key.slice(1), lines: list, total: Math.round(list.reduce((s, l) => s + l.amount, 0) * 100) / 100 }))
    .sort((a, b) => b.lines.length - a.lines.length);
}

/** Días que lleva algo del sistema sin aparecer en el banco. */
export function daysWaiting(date: string, today: string): number {
  return Math.max(0, Math.round(toDay(today) - toDay(date)));
}

/* ------------------------------ reglas (migración 106) ------------------------------ */

export type RuleAction = "expense" | "income" | "customer" | "ignore";

export interface BankRule {
  id: string;
  /** En mayúsculas, espacios simples (así lo guarda la base). */
  matchText: string;
  direction: "in" | "out";
  action: RuleAction;
  category: string | null;
  customerId: string | null;
}

/** Igual que la base: mayúsculas y espacios simples. */
export function normalizeBankText(text: string): string {
  return text.toUpperCase().replace(/\s+/g, " ").trim();
}

/** La regla que corresponde a una línea (la de texto más largo, la más específica). */
export function findRule<R extends BankRule>(line: Pick<MatchLine, "amount" | "description">, rules: R[]): R | null {
  const text = normalizeBankText(line.description);
  const direction = line.amount > 0 ? "in" : "out";
  let best: R | null = null;
  for (const rule of rules) {
    if (rule.direction !== direction || !text.includes(rule.matchText)) continue;
    if (!best || rule.matchText.length > best.matchText.length) best = rule;
  }
  return best;
}

/**
 * Texto propuesto para una regla nueva: el CUIT si el banco lo trae (quién
 * pagó o a quién se le pagó), si no, el principio del texto hasta el primer
 * número (ej. "IMPUESTO CREDITO -LEY"). Siempre es un pedazo literal del texto.
 */
export function suggestRuleText(description: string): string {
  const text = normalizeBankText(description);
  const cuit = text.match(/(?<!\d)(\d{11})(?!\d)/);
  if (cuit) return cuit[1];
  const lead = text.replace(/\d.*$/, "").replace(/[^\p{L}]+$/u, "").trim();
  return lead.length >= 3 ? lead.slice(0, 80) : text.slice(0, 40);
}

/* ------------------------------ tarjetas por mes ------------------------------ */

const CARD_BRANDS: [RegExp, string][] = [
  [/visa/i, "Visa"],
  [/master/i, "Mastercard"],
  [/maestro/i, "Maestro"],
  [/cabal/i, "Cabal"],
  [/amex|american/i, "American Express"],
  [/naranja/i, "Naranja"],
  [/mercado ?pago/i, "Mercado Pago"],
  [/d[eé]bito/i, "Débito"]
];

export function cardBrand(description: string): string {
  for (const [re, label] of CARD_BRANDS) if (re.test(description)) return label;
  return "Otras";
}

export interface CardMonth {
  month: string;
  sold: number;
  deposited: number;
  difference: number;
  differencePct: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Vendido con tarjeta vs acreditado, por mes (el costo de las tarjetas mes a mes). */
export function cardCostByMonth(cardItems: Pick<SystemItem, "date" | "amount">[], depositLines: Pick<MatchLine, "date" | "amount">[]): CardMonth[] {
  const months = new Map<string, { sold: number; deposited: number }>();
  const get = (date: string) => {
    const key = date.slice(0, 7);
    let m = months.get(key);
    if (!m) months.set(key, (m = { sold: 0, deposited: 0 }));
    return m;
  };
  for (const i of cardItems) get(i.date).sold += i.amount;
  for (const l of depositLines) get(l.date).deposited += l.amount;
  return Array.from(months.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => {
      const sold = round2(m.sold);
      const deposited = round2(m.deposited);
      const difference = round2(sold - deposited);
      return { month, sold, deposited, difference, differencePct: sold > 0 ? Math.round((difference / sold) * 1000) / 10 : null };
    });
}

/** Acreditado por marca (según el texto del banco). */
export function depositsByBrand(depositLines: Pick<MatchLine, "amount" | "description">[]): { brand: string; total: number; count: number }[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const l of depositLines) {
    const brand = cardBrand(l.description);
    const r = map.get(brand) ?? { total: 0, count: 0 };
    r.total += l.amount;
    r.count++;
    map.set(brand, r);
  }
  return Array.from(map.entries()).map(([brand, r]) => ({ brand, total: round2(r.total), count: r.count })).sort((a, b) => b.total - a.total);
}

/* ------------------------------ cierre del período ------------------------------ */

/**
 * Saldo final del banco según el propio resumen: entre las líneas del último
 * día, la que tiene un saldo que no es el "saldo anterior" de ninguna otra
 * (el orden dentro del día no se sabe: cada banco lo exporta distinto).
 * null si no se puede saber con certeza.
 */
export function closingBalanceFromLines(lines: { date: string; amount: number; balance: number | null }[]): number | null {
  const withBalance = lines.filter((l) => l.balance !== null);
  if (withBalance.length === 0) return null;
  const lastDate = withBalance.reduce((m, l) => (l.date > m ? l.date : m), withBalance[0].date);
  const day = withBalance.filter((l) => l.date === lastDate);
  const previous = new Set(day.map((l) => cents((l.balance as number) - l.amount)));
  const finals = day.filter((l) => !previous.has(cents(l.balance as number)));
  return finals.length === 1 ? (finals[0].balance as number) : null;
}

export interface ClosingSheet {
  bankBalance: number;
  /** En el banco y no en el sistema (con signo). Se resta. */
  pendingBank: number;
  /** En el sistema y no en el banco, sin tarjetas (con signo). Se suma. */
  pendingSystem: number;
  /** Tarjetas vendidas − acreditadas en el período (comisiones y lo que falta acreditar). Se suma. */
  cardsGap: number;
  adjustedBank: number;
  systemBalance: number;
  /** Sistema − banco ajustado: lo que ninguna partida explica. */
  unexplained: number;
}

/** La planilla clásica: saldo del banco ± partidas pendientes = saldo del sistema. */
export function buildClosingSheet(input: { bankBalance: number; pendingBank: number; pendingSystem: number; cardsGap: number; systemBalance: number }): ClosingSheet {
  const adjustedBank = round2(input.bankBalance - input.pendingBank + input.pendingSystem + input.cardsGap);
  return { ...input, adjustedBank, unexplained: round2(input.systemBalance - adjustedBank) };
}
