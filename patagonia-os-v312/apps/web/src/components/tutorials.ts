import type { Page } from "../features/auth/permissions";

/**
 * Videos tutoriales del canal de YouTube (pedido del dueño, 26/11): cada pantalla muestra arriba "Ver video" con el
 * tutorial que le corresponde, así el cliente nuevo aprende solo. Los videos están en la lista de abajo; un video
 * todavía sin subir lleva id vacío y no se muestra.
 */
export const TUTORIALS_PLAYLIST = "https://www.youtube.com/playlist?list=PLVvQnvV-cGWE";

export type Tutorial = { title: string; youtubeId: string };

const V = {
  primerosPasos: { title: "Primeros pasos", youtubeId: "LQP6QDcHL08" },
  mostrador: { title: "Cómo cobrar una venta", youtubeId: "uEIsjkZ7fX8" },
  cajaCorta: { title: "La caja en un minuto", youtubeId: "rmXNFCOcgXw" },
  cajaCompleta: { title: "La caja, paso a paso", youtubeId: "9uimzLdC7pY" },
  stock: { title: "Stock, costos y márgenes", youtubeId: "lObY29Fp-Dg" },
  compras: { title: "Compras y proveedores", youtubeId: "JSm_8iNZrZU" },
  despiece: { title: "Cuánto te deja cada media res", youtubeId: "6_bGdMsVaVU" },
  clientes: { title: "Clientes y fiado", youtubeId: "tXC6SE9QWQ0" },
  factura: { title: "Factura electrónica", youtubeId: "5sfZH67zwqA" },
  recetas: { title: "Recetas y combos", youtubeId: "dUzCQci0qJ4" },
  empleados: { title: "Sueldos y vales", youtubeId: "dLXKmlVTA6U" },
  tesoreria: { title: "Tesorería", youtubeId: "PzrbbCSwbxs" },
  sucursales: { title: "Sucursales", youtubeId: "3alD9sUfdJk" },
  reportes: { title: "Inicio y reportes", youtubeId: "ksIWG1PUIOQ" },
  contable: { title: "Lo que te pide el contador", youtubeId: "oyn9qe7V_IE" },
  balanza: { title: "Pasar productos a la balanza", youtubeId: "nVD1_VplnbU" },
  activarFactura: { title: "Activar la factura electrónica", youtubeId: "T12TXS7jwbk" },
  impresora: { title: "Impresora de tickets", youtubeId: "5X9X_n2qDXE" },
  importarExcel: { title: "Cargar productos desde Excel", youtubeId: "TmOSTQIpJ1M" },
  bancos: { title: "Bancos: conciliación y cheques", youtubeId: "7uknOHEodXw" },
  // Todavía sin subir (límite diario de YouTube): se completan cuando estén.
  deudas: { title: "Deudas", youtubeId: "" },
  pedidos: { title: "Pedidos de clientes", youtubeId: "" },
  usuarios: { title: "Usuarios", youtubeId: "" },
  productos: { title: "Productos y etiquetas", youtubeId: "" },
  cerrarCaja: { title: "Cerrar la caja", youtubeId: "" }
} satisfies Record<string, Tutorial>;

/** El primero de cada lista es el principal de la pantalla. */
const BY_PAGE: Partial<Record<Page, Tutorial[]>> = {
  dashboard: [V.primerosPasos, V.reportes],
  sale: [V.mostrador, V.cerrarCaja, V.cajaCompleta, V.impresora],
  orders: [V.pedidos],
  customers: [V.clientes],
  products: [V.productos],
  inventory: [V.stock, V.balanza, V.importarExcel],
  recipes: [V.recetas],
  purchases: [V.compras],
  carcass: [V.despiece],
  transfers: [V.sucursales],
  treasury: [V.tesoreria],
  reconciliation: [V.bancos],
  cheques: [V.bancos],
  accounting: [V.contable, V.activarFactura],
  invoicing: [V.factura, V.activarFactura],
  creditors: [V.deudas],
  branches: [V.sucursales],
  employees: [V.empleados],
  users: [V.usuarios],
  reports: [V.reportes],
  import: [V.importarExcel]
};

export function tutorialsFor(page: Page): Tutorial[] {
  return (BY_PAGE[page] ?? []).filter((t) => t.youtubeId !== "");
}

export const youtubeUrl = (t: Tutorial) => `https://www.youtube.com/watch?v=${t.youtubeId}&list=PLVvQnvV-cGWE`;
