import { useCallback, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listAuditLog, type AuditLogEntry, type ListAuditLogInput } from "./audit-service";

export function useAuditLog() {
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (input: ListAuditLogInput) => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await listAuditLog(input));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la auditoría.");
    } finally {
      setLoading(false);
    }
  }, []);

  return { rows, loading, error, load };
}
