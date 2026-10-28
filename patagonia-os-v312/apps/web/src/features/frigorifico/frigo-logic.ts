// Frigorífico (migración 160): lógica pura, sin Supabase, para poder probarla.

export type DtStatus = "pendiente" | "faenado";
export type SalidaKind = "cliente" | "sucursal";

export interface FrigoCamara {
  id: string;
  number: number;
  name: string;
  capacity: number | null;
  active: boolean;
}

export interface FrigoDt {
  id: string;
  branchId: string;
  dtNumber: string;
  dtDate: string;
  producer: string;
  renspa: string | null;
  origin: string | null;
  category: string;
  heads: number;
  tropa: number | null;
  slaughterDate: string | null;
  status: DtStatus;
  notes: string | null;
}

export interface FrigoMedia {
  id: string;
  dtId: string;
  tropa: number;
  garron: number;
  slaughterDate: string;
  animal: number;
  side: 1 | 2;
  kg: number;
  camaraId: string;
  salidaId: string | null;
}

export interface FrigoSalida {
  id: string;
  number: number;
  salidaDate: string;
  kind: SalidaKind;
  customerId: string | null;
  customerName: string | null;
  destBranchName: string | null;
  productName: string | null;
  pricePerKg: number | null;
  totalKg: number;
  total: number;
  notes: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
}

export const CATEGORIES = ["Novillo", "Novillito", "Vaquillona", "Vaca", "Toro", "Ternero"];

/** Las medias de una faena en orden: 2 por animal (la 1 y la 2 del animal 1, después el 2…). */
export function slaughterRows(heads: number): { animal: number; side: 1 | 2 }[] {
  const rows: { animal: number; side: 1 | 2 }[] = [];
  for (let animal = 1; animal <= heads; animal++) {
    rows.push({ animal, side: 1 }, { animal, side: 2 });
  }
  return rows;
}

/** Próximo garrón del día: el garrón arranca en 1 cada día de faena. */
export function nextGarron(medias: FrigoMedia[], slaughterDate: string): number {
  return medias.filter((m) => m.slaughterDate === slaughterDate).reduce((max, m) => Math.max(max, m.garron), 0) + 1;
}

export function nextTropa(dts: FrigoDt[]): number {
  return dts.reduce((max, d) => Math.max(max, d.tropa ?? 0), 0) + 1;
}

export function sumKg(medias: { kg: number }[]): number {
  return Math.round(medias.reduce((t, m) => t + m.kg, 0) * 10) / 10;
}

export function inStock(medias: FrigoMedia[]): FrigoMedia[] {
  return medias.filter((m) => !m.salidaId);
}

export function byOldest(a: FrigoMedia, b: FrigoMedia): number {
  return a.slaughterDate.localeCompare(b.slaughterDate) || a.garron - b.garron;
}

export function stockByCamara(camaras: FrigoCamara[], medias: FrigoMedia[]) {
  const stock = inStock(medias);
  return camaras.map((camara) => {
    const inside = stock.filter((m) => m.camaraId === camara.id);
    return { camara, count: inside.length, kg: sumKg(inside) };
  });
}

/** Garrón escaneado o tipeado: la media en cámara más vieja con ese número que no esté elegida. */
export function pickByGarron(medias: FrigoMedia[], garron: number, selected: string[]): FrigoMedia | null {
  const taken = new Set(selected);
  return inStock(medias).filter((m) => m.garron === garron && !taken.has(m.id)).sort(byOldest)[0] ?? null;
}

export type TrazaQuery =
  | { kind: "tropa"; n: number }
  | { kind: "garron"; n: number }
  | { kind: "number"; n: number }
  | { kind: "text"; text: string }
  | { kind: "empty" };

/** "T101" busca la tropa, "G14" el garrón, un número solo busca los dos, y el resto busca DT o productor. */
export function parseTrazaQuery(raw: string): TrazaQuery {
  const q = raw.trim().toLowerCase();
  if (!q) return { kind: "empty" };
  const prefixed = /^(t|tropa|g|garr[oó]n)\s*(\d+)$/.exec(q);
  if (prefixed) return { kind: prefixed[1].startsWith("t") ? "tropa" : "garron", n: Number(prefixed[2]) };
  if (/^\d+$/.test(q)) return { kind: "number", n: Number(q) };
  return { kind: "text", text: q };
}

export function searchMedias(medias: FrigoMedia[], dts: FrigoDt[], raw: string): FrigoMedia[] {
  const query = parseTrazaQuery(raw);
  const dtById = new Map(dts.map((d) => [d.id, d]));
  let found: FrigoMedia[];
  switch (query.kind) {
    case "empty":
      return [];
    case "tropa":
      found = medias.filter((m) => m.tropa === query.n);
      break;
    case "garron":
      found = medias.filter((m) => m.garron === query.n);
      break;
    case "number":
      found = medias.filter((m) => m.tropa === query.n || m.garron === query.n || (dtById.get(m.dtId)?.dtNumber ?? "").includes(String(query.n)));
      break;
    case "text":
      found = medias.filter((m) => {
        const dt = dtById.get(m.dtId);
        return (dt?.producer ?? "").toLowerCase().includes(query.text) || (dt?.dtNumber ?? "").toLowerCase().includes(query.text);
      });
      break;
  }
  return found.sort(byOldest);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00`) - Date.parse(`${fromIso}T12:00:00`)) / 86_400_000);
}

export function formatKg(kg: number): string {
  return kg.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function formatDay(iso: string | null): string {
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";
}

export function remitoNumber(n: number): string {
  return `0001-${String(n).padStart(8, "0")}`;
}

/** Código de barras de la etiqueta: fecha de faena + tropa (4) + garrón (4). */
export function labelCode(m: Pick<FrigoMedia, "slaughterDate" | "tropa" | "garron">): string {
  return m.slaughterDate.replace(/-/g, "") + String(m.tropa).padStart(4, "0") + String(m.garron).padStart(4, "0");
}

/** Lee el código de la etiqueta (o un garrón suelto) y devuelve la media en cámara. */
export function findByCode(medias: FrigoMedia[], raw: string, selected: string[]): FrigoMedia | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 16) {
    const taken = new Set(selected);
    return inStock(medias).find((m) => !taken.has(m.id) && labelCode(m) === digits) ?? null;
  }
  if (digits.length > 0 && digits.length <= 5) return pickByGarron(medias, Number(digits), selected);
  return null;
}

export function sideLabel(side: 1 | 2): string {
  return `Media ${side} de 2`;
}
