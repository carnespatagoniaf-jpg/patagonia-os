/**
 * Registros REALES de productos (función 62) de la Cuora Max de Los gringos, leídos el 14/10/2026 09:19
 * (reporte a soporte a24de260…), tal cual llegaron (sin dirección, función ni verificación).
 * El byte antes de la configuración EAN es 0x01 ("EAN del PLU"), no el carácter "1".
 * Solo para pruebas: no inventar ni "completar" bytes acá.
 */
const fromHex = (h: string) => String.fromCharCode(...h.split(" ").map((x) => parseInt(x, 16)));

export const REAL_PLU_2_GRINGO_CAJON = fromHex(
  "30 30 30 32 30 47 52 49 4e 47 4f 20 43 41 4a 4f 4e 20 44 45 20 20 20 30 37 32 30 30 30 30 36 38 30 30 30 30 30 30 30 32 30 31 30 30 30 30 55 30 30 30 30 30 30 30 30 4e 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 01 30 30 30 30 30 30 30 30 30 30 30 30 4e"
);
export const REAL_PLU_13_PECHUGA_SH = fromHex(
  "30 30 31 33 30 50 45 43 48 55 47 41 20 53 2f 48 20 78 31 78 33 20 20 30 30 39 32 30 30 30 30 39 30 30 30 30 30 30 31 33 30 31 30 30 30 30 50 30 30 30 30 30 30 30 30 4e 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 20 20 20 20 20 20 20 20 20 20 30 20 01 32 30 50 50 50 50 43 43 43 43 43 43 4e"
);
