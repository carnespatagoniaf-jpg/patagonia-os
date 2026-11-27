import { useEffect, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { initialLabelProfiles, labelProfilesLoaded, labelProfilesOnError, type LabelProfilesState } from "./label-spec-cache";
import { loadBranchLabelSpecRows } from "./label-spec-service";

const REFRESH_MS = 2 * 60 * 1000;

/**
 * 'balanzas_v2': los perfiles de etiqueta de las balanzas de la sucursal, con copia en esta PC (sin conexión se lee
 * con la última copia). Apagado (o sin base): null, y Mostrador/Clientes leen como siempre.
 */
export function useScaleLabelProfiles(branchId: string | null, enabled: boolean): LabelProfilesState | null {
  const on = enabled && isSupabaseConfigured && !!branchId;
  const [state, setState] = useState<LabelProfilesState | null>(() => (on ? initialLabelProfiles(branchId) : null));
  useEffect(() => {
    if (!on || !branchId) {
      setState(null);
      return;
    }
    let alive = true;
    setState(initialLabelProfiles(branchId));
    const load = () =>
      void loadBranchLabelSpecRows(branchId)
        .then((rows) => alive && setState(labelProfilesLoaded(branchId, rows)))
        .catch(() => alive && setState(labelProfilesOnError(branchId)));
    load();
    // Otra caja puede haber registrado una balanza o cambiado su inicio.
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [branchId, on]);
  return state;
}
