import { AURA_ITEM_SCALE_CONFIG } from "../../inventory/kretz/aura-sync";
import { saveBranchScaleConfig } from "../../sale/scale-config-service";
import { KRETZ_IO, makeKretzAdapter } from "./adapters/kretz";
import { systelAdapter } from "./adapters/systel-live";
import { searchPlan, type ScaleChoice } from "./choice";
import type { ScaleAdapter } from "./types";

/** Kretz con la base real: al sincronizar una Aura, Mostrador queda leyendo sus códigos por producto (Pre-Empaque). */
const kretzSaveItemConfig = (branchId: string) => saveBranchScaleConfig(branchId, AURA_ITEM_SCALE_CONFIG);
const kretzAdapter = makeKretzAdapter({ ...KRETZ_IO, saveItemConfig: kretzSaveItemConfig });

/** Las marcas que conoce "Mi balanza", con la base real. Agregar una marca = un adaptador más acá. */
export const SCALE_ADAPTERS: ScaleAdapter[] = [systelAdapter, kretzAdapter];

/** Los adaptadores para la balanza que eligió el cliente ("auto" = todas las marcas, como antes). */
export function adaptersForChoice(choice: ScaleChoice): ScaleAdapter[] {
  const plan = searchPlan(choice);
  const kretz = plan.kretzOnly ? makeKretzAdapter({ ...KRETZ_IO, saveItemConfig: kretzSaveItemConfig }, undefined, plan.kretzOnly) : kretzAdapter;
  return plan.families.map((f) => (f === "kretz" ? kretz : systelAdapter));
}
