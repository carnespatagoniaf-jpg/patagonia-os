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

const DEMO_BRANCH_ID = "demo-branch";
const DEMO_BRANCH_NAME = "Sucursal demo";

const DEMO_USERS: CompanyUser[] = [
  { id: "demo-user", fullName: "Demo", role: "owner", branchId: DEMO_BRANCH_ID, branchName: DEMO_BRANCH_NAME, active: true, deniedPermissions: [] },
  { id: "demo-user-2", fullName: "Sofía López", role: "admin", branchId: DEMO_BRANCH_ID, branchName: DEMO_BRANCH_NAME, active: true, deniedPermissions: [] },
  { id: "demo-user-3", fullName: "Rodrigo Pérez", role: "cashier", branchId: DEMO_BRANCH_ID, branchName: DEMO_BRANCH_NAME, active: true, deniedPermissions: [] }
];

export function useUsers() {
  const [users, setUsers] = useState<CompanyUser[]>(isSupabaseConfigured ? [] : DEMO_USERS);
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
      if (!isSupabaseConfigured) {
        const user: CompanyUser = {
          id: crypto.randomUUID(),
          fullName: input.fullName,
          role: input.role,
          branchId: input.branchId,
          branchName: DEMO_BRANCH_NAME,
          active: true,
          deniedPermissions: []
        };
        setUsers((current) => [...current, user]);
        return { id: user.id, email: input.email };
      }

      const result = await createStaffUser(input);
      await reload();
      return result;
    },
    [reload]
  );

  const update = useCallback(
    async (input: UpdateStaffUserInput) => {
      if (!isSupabaseConfigured) {
        setUsers((current) => current.map((u) => (u.id === input.id ? { ...u, ...input } : u)));
        return;
      }

      await updateStaffUser(input);
      await reload();
    },
    [reload]
  );

  return { users, loading, error, reload, create, update };
}
