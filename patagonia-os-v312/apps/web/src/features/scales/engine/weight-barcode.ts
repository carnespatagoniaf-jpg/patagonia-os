/**
 * Empresas cuya Kretz Report imprime el PESO en el código de barras de los productos por kilo (no el importe):
 * Mostrador cobra kilos × precio de Patagonia del momento. Pedido de Carplat (18/11/2026): envasan con días de
 * anticipación y quieren que el precio lo ponga el sistema. Se aplica al tocar "Mandar productos" en Mi balanza.
 */
export const REPORT_WEIGHT_BARCODE_COMPANIES = new Set<string>([
  "ded6465d-2d7d-43d2-97df-0945e1871dbf" // Carplat S.A.
]);

/**
 * Empresas cuya Kretz Report imprime el IMPORTE en PESOS ENTEROS con el formato 2-5-5 ("20" + producto 5 + importe 5),
 * y que tienen además una Kretz Aura (2-3-7 en centavos) en el mismo local. REAL El Abastero 24/11/2026: con las dos
 * en 2-3-7 la Report imprimía pesos y la Aura centavos con el mismo código, y Mostrador cobraba la Report 100 veces
 * menos ($23 por $2.291,63). Al tocar "Mandar productos", la Report vuelve a su formato de fábrica y la sucursal
 * queda leyendo 1-6-5 en pesos (mismos dígitos que el 2-5-5); el TOTAL de la Aura se reconoce por su código 998.
 */
export const REPORT_PESOS_BARCODE_COMPANIES = new Set<string>([
  "b3269949-1e03-4509-bc35-2608e6ec4bfc" // El Abastero
]);

/**
 * Empresas cuya Kretz Report por USB/Bluetooth imprime IGUAL que la Report por red: "21" + producto de 5 + gramos de 5
 * (1070 "2112001"), y la sucursal lee ese formato (KRETZ_PLU5_WEIGHT_CONFIG). REAL Oliem 25/11/2026: tiene una Report
 * por red y otra por USB en el mismo local, y productos por kilo con código 6000-6xxx (asado, vacío, matambre). Con el
 * 2-3-7 de la USB esos códigos no entraban ("inexistente" en esa balanza) y cada sincronización de una balanza le
 * cambiaba a Mostrador el formato de la otra.
 */
export const REPORT_PLU5_WEIGHT_COMPANIES = new Set<string>([
  "9c810ff0-e945-41d7-9c0c-921626a83694" // Oliem minimarket
]);

/**
 * Sucursales cuya Kretz Aura imprime con inicio "22" (1070 "2202205") porque comparten local con una Report de
 * etiquetas "20": El Abastero, 25/11/2026. La sincronización de la Aura manda ese formato y Mostrador lee los "22…" como
 * Aura (producto 3 + importe en centavos 7; producto 998 = TOTAL del ticket). Ver ScaleConfig.auraPrefix22.
 */
export const AURA_PREFIX_22_BRANCHES = new Set<string>([
  "b92aa128-3062-43ea-91f0-97f99469a173" // El Abastero (sucursal EL ABASTERO)
]);
