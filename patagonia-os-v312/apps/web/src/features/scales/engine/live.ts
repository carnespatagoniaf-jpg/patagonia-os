import { AURA_ITEM_SCALE_CONFIG } from "../../inventory/kretz/aura-sync";
import type { ScaleConfig } from "../../sale/scale-barcode";
import { getBranchScaleConfig, saveBranchScaleConfig } from "../../sale/scale-config-service";
import { KRETZ_IO, makeKretzAdapter } from "./adapters/kretz";
import { systelAdapter } from "./adapters/systel-live";
import { searchPlan, type ScaleChoice } from "./choice";
import type { ScaleAdapter } from "./types";

/** Kretz con la base real: al sincronizar una Aura, Mostrador queda leyendo sus códigos por producto (Pre-Empaque). */
const kretzSaveItemConfig = (branchId: string, config: ScaleConfig = AURA_ITEM_SCALE_CONFIG) => saveBranchScaleConfig(branchId, config);
const kretzAdapter = makeKretzAdapter({ ...KRETZ_IO, saveItemConfig: kretzSaveItemConfig, loadBranchConfig: getBranchScaleConfig });

/** Las marcas que conoce "Mi balanza", con la base real. Agregar una marca = un adaptador más acá. */
export const SCALE_ADAPTERS: ScaleAdapter[] = [systelAdapter, kretzAdapter];

/** Los adaptadores para la balanza que eligió el cliente ("auto" = todas las marcas, como antes). */
export function adaptersForChoice(choice: ScaleChoice): ScaleAdapter[] {
  const plan = searchPlan(choice);
  const kretz = plan.kretzOnly ? makeKretzAdapter({ ...KRETZ_IO, saveItemConfig: kretzSaveItemConfig, loadBranchConfig: getBranchScaleConfig }, undefined, plan.kretzOnly) : kretzAdapter;
  return plan.families.map((f) => (f === "kretz" ? kretz : systelAdapter));
}
