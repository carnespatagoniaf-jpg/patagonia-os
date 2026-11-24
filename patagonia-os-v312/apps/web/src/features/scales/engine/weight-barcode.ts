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
