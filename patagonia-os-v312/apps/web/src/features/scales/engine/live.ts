import { kretzAdapter } from "./adapters/kretz";
import { systelAdapter } from "./adapters/systel-live";
import type { ScaleAdapter } from "./types";

/** Las marcas que conoce "Mi balanza", con la base real. Agregar una marca = un adaptador más acá. */
export const SCALE_ADAPTERS: ScaleAdapter[] = [systelAdapter, kretzAdapter];
