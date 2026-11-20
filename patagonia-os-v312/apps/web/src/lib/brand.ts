/**
 * Nombre y datos de la marca, en UN solo lugar (pedido del dueño 19/11/2026: el nombre "Patagonia System" va a
 * cambiar). Todo texto nuevo que nombre al sistema (mensajes de WhatsApp, encabezados, archivos bajados) sale de acá.
 * Para cambiar de marca: cambiar estos valores y el logo de `BrandMark` (features/admin/ui/BrandMark.tsx).
 */
export const BRAND = {
  /** Nombre comercial, como lo ve un cliente. */
  name: "Patagonia System",
  /** Versión corta para lugares chicos (pestaña del navegador, encabezado en el celular). */
  shortName: "Patagonia",
  /** Dirección de la app que se manda a los clientes. */
  appUrl: "https://app.patagoniasystem.com.ar",
  /** Prefijo de los archivos que se bajan (Excel/CSV). Sin espacios ni acentos. */
  filePrefix: "patagonia"
} as const;
