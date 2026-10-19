// Cartel de precio A4 para el mostrador (botón "Cartel A4" de Preparar
// etiqueta). Mismo tamaño y armado que los carteles que el dueño imprimió el
// 16/10 (2 por hoja, se corta por la línea punteada), pero en negro: "OFERTA"
// en la franja de arriba y el nombre del local chico abajo. Lógica pura.

export interface PricePoster {
  business: string;
  name: string;
  price: number;
  detail: string;
}

export function defaultDetail(unit: "kg" | "unit" | "box"): string {
  if (unit === "unit") return "la unidad";
  if (unit === "box") return "la caja";
  return "el kilo";
}

/** "$14.400" (sin espacio, como el cartel); con centavos "$1.234,50". */
export function formatPosterPrice(value: number): string {
  const cents = Math.round(Math.abs(value) * 100);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  const thousands = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const sign = value < 0 ? "-" : "";
  return `${sign}$${thousands}${rest ? `,${String(rest).padStart(2, "0")}` : ""}`;
}

/** Tamaño del nombre en mm: los nombres largos bajan para entrar en una línea. */
export function nameSizeMm(name: string): number {
  const length = name.trim().length;
  if (length > 20) return 10;
  if (length > 14) return 12;
  return 15;
}

/** El precio de los carteles reales es de 40 mm; con 8+ caracteres no entra. */
export function priceSizeMm(priceText: string): number {
  if (priceText.length >= 10) return 28;
  if (priceText.length >= 8) return 34;
  return 40;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const POSTER_CSS = `@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;height:297mm;display:flex;flex-direction:column;overflow:hidden;background:#fff}
.c{flex:1;margin:8mm;border:2.5mm solid #1a1a1a;border-radius:6mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:4mm 8mm;position:relative;overflow:hidden}
.blank{border-color:transparent}
.top{position:absolute;top:0;left:0;right:0;background:#1a1a1a;color:#fff;font-weight:900;font-size:13mm;letter-spacing:3mm;padding:1.5mm 0}
.n{font-weight:900;color:#1a1a1a;margin-top:14mm;line-height:1.05}
.p{font-weight:900;color:#1a1a1a;line-height:1;margin:4mm 0;letter-spacing:-1mm;white-space:nowrap}
.s{font-size:9mm;font-weight:700;color:#333;max-width:170mm;margin-bottom:6mm}
.b{position:absolute;bottom:3mm;left:0;right:0;font-size:5mm;color:#888;letter-spacing:1mm;white-space:nowrap;overflow:hidden}
.cut{height:0;border-top:1mm dashed #bbb;margin:0 6mm}`;

/** Hoja A4 con el cartel en la mitad de arriba (la de abajo queda libre, se corta). */
export function buildPosterHtml(poster: PricePoster): string {
  const business = poster.business.trim().toUpperCase();
  const name = poster.name.trim().toUpperCase();
  const price = formatPosterPrice(poster.price);
  const card =
    `<div class="c">` +
    `<div class="top">OFERTA</div>` +
    `<div class="n" style="font-size:${nameSizeMm(name)}mm">${escapeHtml(name)}</div>` +
    `<div class="p" style="font-size:${priceSizeMm(price)}mm">${escapeHtml(price)}</div>` +
    (poster.detail.trim() ? `<div class="s">${escapeHtml(poster.detail.trim())}</div>` : "") +
    (business ? `<div class="b">${escapeHtml(business)}</div>` : "") +
    `</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cartel</title><style>${POSTER_CSS}</style></head><body><div class="page">${card}<div class="cut"></div><div class="c blank"></div></div></body></html>`;
}
