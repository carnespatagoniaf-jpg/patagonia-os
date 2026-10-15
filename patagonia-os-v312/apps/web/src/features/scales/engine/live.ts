import { AURA_ITEM_SCALE_CONFIG } from "../../inventory/kretz/aura-sync";
import { saveBranchScaleConfig } from "../../sale/scale-config-service";
import { KRETZ_IO, makeKretzAdapter } from "./adapters/kretz";
import { systelAdapter } from "./adapters/systel-live";
import type { ScaleAdapter } from "./types";

/** Kretz con la base real: al sincronizar una Aura, Mostrador queda leyendo sus códigos por producto (Pre-Empaque). */
const kretzAdapter = makeKretzAdapter({ ...KRETZ_IO, saveItemConfig: (branchId) => saveBranchScaleConfig(branchId, AURA_ITEM_SCALE_CONFIG) });

/** Las marcas que conoce "Mi balanza", con la base real. Agregar una marca = un adaptador más acá. */
export const SCALE_ADAPTERS: ScaleAdapter[] = [systelAdapter, kretzAdapter];
