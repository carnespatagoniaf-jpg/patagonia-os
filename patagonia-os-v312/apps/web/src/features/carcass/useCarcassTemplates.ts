import { useCallback, useEffect, useState } from "react";
import type { CarcassCutTemplate } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import {
  deleteCarcassCutTemplate,
  listCarcassCutTemplates,
  saveCarcassCutTemplate,
  type SaveCarcassCutTemplateInput
} from "./carcass-templates-service";

export function useCarcassTemplates() {
  const [templates, setTemplates] = useState<CarcassCutTemplate[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  // Devuelve la lista nueva, para usarla enseguida (ej. repartir una res recién copiados los cortes típicos).
  const reload = useCallback(async (): Promise<CarcassCutTemplate[]> => {
    if (!isSupabaseConfigured) return [];
    setLoading(true);
    setError(null);
    try {
      const list = await listCarcassCutTemplates();
      setTemplates(list);
      return list;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las plantillas.");
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (input: SaveCarcassCutTemplateInput) => {
      const result = await saveCarcassCutTemplate(input);
      await reload();
      return result;
    },
    [reload]
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteCarcassCutTemplate(id);
      await reload();
    },
    [reload]
  );

  return { templates, loading, error, reload, save, remove };
}
