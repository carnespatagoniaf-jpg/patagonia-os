/**
 * Empresas con la integración Systel por cable habilitada (prueba piloto autorizada por el dueño).
 * Los gringos (Cuora Max): panel de Stock → Balanza desde 2026-10-09; en Mostrador, leer el detalle
 * del ticket de TOTAL desde la balanza (función 72) desde 2026-10-13, mientras se valida con su balanza.
 */
export const SYSTEL_PILOT_COMPANIES = new Set([
  "a2660765-99a4-4945-84a1-803b8913a71f", // Los gringos (producción)
  "0295a76b-acc0-4d62-8e6b-9065bd1647ca" // Carnicería Don Julio: empresa de prueba de STAGING (no existe en producción), para las pruebas de pantalla
]);
