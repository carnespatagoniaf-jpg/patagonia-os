import { takeSystelBackup, type SystelBackup } from "./systel-backup";
import type { SystelClient, WriteOutcome } from "./systel-client";
import { LAYOUT_INFO, priceToRaw } from "./systel-plu";

/**
 * Prueba controlada con una Cuora real (una sola visita). Pasos:
 * 1. Respaldo completo (solo lectura). Sin respaldo completo no sigue.
 * 2. Elige 2 números de PLU LIBRES (los más altos que entren en la balanza).
 * 3. Crea un producto de prueba por kilo y otro por unidad (función 61/4), los relee y compara.
 * 4. Le cambia el precio al de kilo (función 33), relee y compara (todo lo demás igual).
 * 5. Relee la lista y TODOS los productos del cliente: tienen que estar idénticos al respaldo.
 * Frena en el primer problema. No borra nada: los 2 productos de prueba quedan
 * en la balanza y el cliente los borra a mano si quiere.
 */

export const SYSTEL_WRITE_TEST_VERSION = "2026-10-04a";

export interface SystelWriteTestStep {
  label: string;
  ok: boolean;
  detail: string;
  outcome?: WriteOutcome;
}

export interface SystelWriteTestResult {
  version: string;
  verdict: "ok" | "sin_respaldo" | "sin_lugar" | "fallo" | "clientes_cambiaron";
  detail: string;
  backup: SystelBackup | null;
  steps: SystelWriteTestStep[];
  testNumbers: number[];
}

export async function runSystelWriteTest(client: SystelClient, onProgress: (text: string) => void = () => {}): Promise<SystelWriteTestResult> {
  const result: SystelWriteTestResult = { version: SYSTEL_WRITE_TEST_VERSION, verdict: "fallo", detail: "", backup: null, steps: [], testNumbers: [] };
  const step = (label: string, ok: boolean, detail: string, outcome?: WriteOutcome) => result.steps.push({ label, ok, detail, outcome });

  const backup = await takeSystelBackup(client, onProgress);
  result.backup = backup;
  step("Respaldo (solo lectura)", backup.complete && !!backup.layout, backup.detail);
  if (!backup.complete || !backup.layout || !backup.signature) {
    result.verdict = "sin_respaldo";
    result.detail = !backup.signature ? "la balanza no mandó su firma digital (modelo y decimales): no se escribe nada" : `sin respaldo completo no se escribe nada (${backup.detail})`;
    return result;
  }
  const layout = backup.layout;
  const decimals = backup.signature.priceDecimals;
  const info = LAYOUT_INFO[layout];
  const top = Math.min(backup.signature.pluCapacity || info.maxPlu, info.maxPlu, info.maxCode);
  const used = new Set(backup.list.map((e) => e.number));
  const free: number[] = [];
  for (let n = top; n >= 1 && free.length < 2; n--) if (!used.has(n)) free.push(n);
  if (free.length < 2) {
    result.verdict = "sin_lugar";
    result.detail = "no hay 2 números de PLU libres";
    return result;
  }
  result.testNumbers = free;
  const kilo = priceToRaw(25000, decimals);
  const unidad = priceToRaw(1500, decimals);
  const kiloNuevo = priceToRaw(26000, decimals);
  if (kilo === null || unidad === null || kiloNuevo === null) {
    // Con 2 decimales $25.000 no entra en 6 números: se prueba con valores que sí entran.
    return finishSmall();
  }
  return run(kilo, unidad, kiloNuevo);

  async function finishSmall(): Promise<SystelWriteTestResult> {
    return run(priceToRaw(2500, decimals)!, priceToRaw(150, decimals)!, priceToRaw(2600, decimals)!);
  }

  async function run(kiloRaw: number, unidadRaw: number, kiloNuevoRaw: number): Promise<SystelWriteTestResult> {
    const [nKilo, nUnidad] = free;
    onProgress(`Creando el producto de prueba por kilo (PLU ${nKilo})…`);
    const a = await client.createPlu(layout, { number: nKilo, name: "PRUEBA PATAGONIA K", code: nKilo, saleType: "P", priceRaw: kiloRaw }, used);
    step(`Crear PLU ${nKilo} por kilo`, a.ok, a.detail || a.verdict, a);
    if (!a.ok) return fail(a.detail);
    used.add(nKilo);
    onProgress(`Creando el producto de prueba por unidad (PLU ${nUnidad})…`);
    const b = await client.createPlu(layout, { number: nUnidad, name: "PRUEBA PATAGONIA U", code: nUnidad, saleType: "U", priceRaw: unidadRaw }, used);
    step(`Crear PLU ${nUnidad} por unidad`, b.ok, b.detail || b.verdict, b);
    if (!b.ok) return fail(b.detail);
    onProgress(`Cambiando el precio del PLU ${nKilo}…`);
    const c = await client.changePrice(a.readBack!, kiloNuevoRaw);
    step(`Cambio de precio del PLU ${nKilo}`, c.ok, c.detail || c.verdict, c);
    if (!c.ok) return fail(c.detail);

    onProgress("Comprobando que los productos del cliente siguen iguales…");
    const list = await client.list();
    const now = new Set(list?.entries.map((e) => e.number) ?? []);
    const missing = backup.list.filter((e) => !now.has(e.number)).map((e) => e.number);
    if (!list || missing.length) {
      result.verdict = "clientes_cambiaron";
      result.detail = !list ? "no se pudo releer la lista al final" : `faltan PLU del cliente: ${missing.join(", ")}`;
      step("Productos del cliente", false, result.detail);
      return result;
    }
    const changed: number[] = [];
    for (const [i, plu] of backup.plus.entries()) {
      if (i % 20 === 0) onProgress(`Comprobando productos del cliente: ${i} de ${backup.plus.length}…`);
      const back = await client.readPlu(layout, plu.number);
      if (!back || back.raw.slice(LAYOUT_INFO[layout].pluDigits + 1) !== plu.raw.slice(LAYOUT_INFO[layout].pluDigits + 1)) changed.push(plu.number);
    }
    if (changed.length) {
      result.verdict = "clientes_cambiaron";
      result.detail = `cambiaron PLU del cliente: ${changed.slice(0, 20).join(", ")}`;
      step("Productos del cliente", false, result.detail);
      return result;
    }
    step("Productos del cliente", true, `${backup.plus.length} productos idénticos al respaldo`);
    result.verdict = "ok";
    result.detail = `funcionó: alta por kilo y por unidad, cambio de precio y los ${backup.plus.length} productos del cliente intactos (${info.label}, precio con ${decimals} decimales)`;
    return result;
  }

  function fail(detail: string): SystelWriteTestResult {
    result.verdict = "fallo";
    result.detail = `${detail}: se frenó`;
    return result;
  }
}
