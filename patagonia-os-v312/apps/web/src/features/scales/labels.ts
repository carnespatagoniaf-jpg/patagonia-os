import type { ScaleCapability, ScaleDriverStatus } from "./types";

/** Textos en criollo para lo que un driver declara -- nunca se muestra el
 * nombre técnico de la capacidad ni del protocolo en la pantalla principal. */
export const CAPABILITY_LABELS: Record<ScaleCapability, string> = {
  readWeight: "Lectura de peso en vivo",
  readPlu: "Lectura de productos ya cargados",
  writePlu: "Envío de un producto",
  bulkSync: "Sincronización masiva del catálogo",
  readCatalog: "Lectura del catálogo completo",
  ping: "Estado / conectividad"
};

export const STATUS_LABELS: Record<ScaleDriverStatus, string> = {
  certified: "Certificada",
  experimental: "Experimental"
};

export const STATUS_DESCRIPTIONS: Record<ScaleDriverStatus, string> = {
  certified: "Probamos esta balanza físicamente -- podés confiar en las lecturas y sincronizaciones sin verificarlas cada vez.",
  experimental: "Todavía no la probamos contra una balanza física real. Funciona según la documentación, pero conviene confirmar cada lectura contra la pantalla de la balanza antes de usarla para cobrar."
};
