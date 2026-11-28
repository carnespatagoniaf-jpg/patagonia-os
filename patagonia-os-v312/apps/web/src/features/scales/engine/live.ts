import { AURA_ITEM_SCALE_CONFIG } from "../../inventory/kretz/aura-sync";
import { listBranchScaleRefs } from "../../inventory/kretz/branch-scale-guard-service";
import type { ScaleConfig } from "../../sale/scale-barcode";
import { getBranchScaleConfig, saveBranchScaleConfig } from "../../sale/scale-config-service";
import { KRETZ_IO, makeKretzAdapter } from "./adapters/kretz";
import { allocateScalePrefix, saveScaleLabelSpec } from "../label-spec-service";
import { systelAdapter } from "./adapters/systel-live";
import { searchPlan, type ScaleChoice } from "./choice";
import type { ScaleAdapter } from "./types";

/** Kretz con la base real: al sincronizar una Aura, Mostrador queda leyendo sus códigos por producto (Pre-Empaque). */
const kretzSaveItemConfig = (branchId: string, config: ScaleConfig = AURA_ITEM_SCALE_CONFIG) => saveBranchScaleConfig(branchId, config);
// Con las balanzas de la sucursal: si hay más de una, el formato de etiqueta solo se cambia si queda igual (C1).
// 'balanzas_v2': el inicio y el perfil de etiqueta de cada balanza (migración 222).
const KRETZ_LIVE_IO = { ...KRETZ_IO, saveItemConfig: kretzSaveItemConfig, loadBranchConfig: getBranchScaleConfig, listBranchScales: listBranchScaleRefs, allocatePrefix: allocateScalePrefix, saveLabelSpec: saveScaleLabelSpec };
const kretzAdapter = makeKretzAdapter(KRETZ_LIVE_IO);

/** Las marcas que conoce "Mi balanza", con la base real. Agregar una marca = un adaptador más acá. */
export const SCALE_ADAPTERS: ScaleAdapter[] = [systelAdapter, kretzAdapter];

/** Los adaptadores para la balanza que eligió el cliente ("auto" = todas las marcas, como antes). */
export function adaptersForChoice(choice: ScaleChoice): ScaleAdapter[] {
  const plan = searchPlan(choice);
  const kretz = plan.kretzOnly ? makeKretzAdapter(KRETZ_LIVE_IO, undefined, plan.kretzOnly) : kretzAdapter;
  return plan.families.map((f) => (f === "kretz" ? kretz : systelAdapter));
}
