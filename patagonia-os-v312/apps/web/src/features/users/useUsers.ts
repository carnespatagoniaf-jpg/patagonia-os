import { useCallback, useEffect, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import {
  createStaffUser,
  listCompanyUsers,
  updateStaffUser,
  type CompanyUser,
  type CreateStaffUserInput,
  type CreateStaffUserResult,
  type UpdateStaffUserInput
} from "./users-service";

export function useUsers() {
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setUsers(await listCompanyUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los usuarios.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: CreateStaffUserInput): Promise<CreateStaffUserResult> => {
      const result = await createStaffUser(input);
      await reload();
      return result;
    },
    [reload]
  );

  const update = useCallback(
    async (input: UpdateStaffUserInput) => {
      await updateStaffUser(input);
      await reload();
    },
    [reload]
  );

  return { users, loading, error, reload, create, update };
}
