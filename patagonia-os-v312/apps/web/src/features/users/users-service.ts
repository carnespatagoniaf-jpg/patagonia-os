import { supabase } from "../../lib/supabase";

export type StaffRole = "owner" | "admin" | "manager" | "cashier" | "production" | "readonly";

export interface CompanyUser {
  id: string;
  fullName: string;
  role: StaffRole;
  branchId: string | null;
  branchName: string | null;
  active: boolean;
}

export async function listCompanyUsers(): Promise<CompanyUser[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("profiles")
    .select("id,full_name,role,active,branch_id,branches(name)")
    .order("full_name");
  if (error) throw error;

  return (data ?? []).map((row) => {
    const branch = row.branches as unknown as { name: string } | { name: string }[] | null;
    const branchName = Array.isArray(branch) ? (branch[0]?.name ?? null) : (branch?.name ?? null);
    return {
      id: row.id,
      fullName: row.full_name,
      role: row.role,
      branchId: row.branch_id,
      branchName,
      active: row.active
    };
  });
}

export interface CreateStaffUserInput {
  email: string;
  fullName: string;
  role: StaffRole;
  branchId: string;
}

export interface CreateStaffUserResult {
  id: string;
  email: string;
  tempPassword: string;
}

export async function createStaffUser(input: CreateStaffUserInput): Promise<CreateStaffUserResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.functions.invoke("create-staff-user", { body: input });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // keep default message
      }
    }
    throw new Error(message);
  }
  if (!data || (data as { error?: string }).error) {
    throw new Error((data as { error?: string })?.error ?? "No se pudo crear el usuario.");
  }
  return data as CreateStaffUserResult;
}

export interface UpdateStaffUserInput {
  id: string;
  fullName: string;
  role: StaffRole;
  branchId: string;
  active: boolean;
}

export async function updateStaffUser(input: UpdateStaffUserInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_staff_user", {
    p_profile_id: input.id,
    p_full_name: input.fullName,
    p_role: input.role,
    p_branch_id: input.branchId,
    p_active: input.active
  });
  if (error) throw error;
}
