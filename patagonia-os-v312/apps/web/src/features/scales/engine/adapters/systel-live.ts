import { loadScaleSetup, saveScaleCatalog, setScaleLinks, setScaleProfileActive } from "../../sale/scale-sale-service";
import { loadSavedSystelLink, saveSystelLink } from "../../../inventory/systel/systel-discovery";
import { makeSystelAdapter, saveProductBackupLocally, type SystelDeps } from "./systel";

/** Systel con la base real de Patagonia (migración 119). Separado para que systel.ts se pruebe sin base. */
export const SYSTEL_DEPS: SystelDeps = {
  loadSetup: (branchId, scaleKey) => loadScaleSetup(branchId, { includeInactive: true, scaleKey }),
  saveCatalog: (branchId, profile, catalog) => saveScaleCatalog(branchId, profile, catalog),
  setLinks: setScaleLinks,
  setActive: setScaleProfileActive,
  saveLocalBackup: saveProductBackupLocally,
  // Si la balanza atendió con otras señales o a otro número, se guarda junto a su conexión (la próxima vez y Mostrador).
  onConnectionHints: (hints) => {
    const saved = loadSavedSystelLink();
    if (saved) saveSystelLink({ settings: saved.settings, address: saved.address, ...hints });
  },
  // Build de laboratorio para la prueba controlada en una balanza real (nunca en producción).
  forceWritable: import.meta.env.VITE_SYSTEL_PUSH_LAB === "1"
};

export const systelAdapter = makeSystelAdapter(SYSTEL_DEPS);
