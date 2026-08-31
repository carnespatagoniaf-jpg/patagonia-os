import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { can } from "../auth/permissions";
import { createBranch, listBranches, setBranchSalesMode, type Branch, type SalesMode } from "./branches-service";

const DEMO_BRANCH_ID = "demo-branch";

interface BranchContextValue {
  branchId: string | null;
  branches: Branch[];
  activeBranch: Branch | null;
  canSwitch: boolean;
  loading: boolean;
  setBranchId(id: string): void;
  addBranch(name: string): Promise<Branch>;
  setSalesMode(branchId: string, mode: SalesMode): Promise<void>;
}

const BranchContext = createContext<BranchContextValue | null>(null);

function storageKey(companyId: string) {
  return `patagonia_active_branch_${companyId}`;
}

export function BranchProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const canSwitch = can(profile, "branches.manage");

  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    try {
      setBranches(await listBranches());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!profile) return;
    if (!canSwitch) {
      // Roles que no pueden cambiar de sucursal quedan siempre atados a la suya.
      setSelectedId(profile.branch_id);
      return;
    }
    const stored = window.localStorage.getItem(storageKey(profile.company_id));
    setSelectedId(stored ?? profile.branch_id);
  }, [profile, canSwitch]);

  const branchId = useMemo(() => {
    if (!isSupabaseConfigured) return DEMO_BRANCH_ID;
    if (!canSwitch) return profile?.branch_id ?? null;
    return selectedId ?? profile?.branch_id ?? branches[0]?.id ?? null;
  }, [canSwitch, selectedId, profile, branches]);

  function setBranchId(id: string) {
    setSelectedId(id);
    if (profile) window.localStorage.setItem(storageKey(profile.company_id), id);
  }

  async function addBranch(name: string) {
    const result = await createBranch(name);
    await reload();
    setBranchId(result.id);
    return { id: result.id, name, sales_mode: null };
  }

  async function setSalesMode(id: string, mode: SalesMode) {
    await setBranchSalesMode(id, mode);
    await reload();
  }

  const activeBranch = branches.find((b) => b.id === branchId) ?? null;

  const value: BranchContextValue = { branchId, branches, activeBranch, canSwitch, loading, setBranchId, addBranch, setSalesMode };

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useActiveBranch() {
  const value = useContext(BranchContext);
  if (!value) throw new Error("useActiveBranch debe usarse dentro de BranchProvider");
  return value;
}
