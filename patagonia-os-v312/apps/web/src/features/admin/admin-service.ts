import { supabase } from "../../lib/supabase";

export interface CreateClientInput {
  companyName: string;
  branchName: string;
  ownerFullName: string;
  ownerEmail: string;
}

export interface CreateClientResult {
  companyId: string;
  branchId: string;
  ownerId: string;
  email: string;
  tempPassword: string;
}

export async function createClient(input: CreateClientInput): Promise<CreateClientResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.functions.invoke("create-client", { body: input });
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
    throw new Error((data as { error?: string })?.error ?? "No se pudo crear el cliente.");
  }
  return data as CreateClientResult;
}

export interface CompanySummary {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  branchCount: number;
  userCount: number;
}

export async function listCompanies(): Promise<CompanySummary[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("list_companies_for_admin");
  if (error) throw error;

  interface Row { id: string; name: string; active: boolean; created_at: string; branch_count: number; user_count: number }
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    createdAt: row.created_at,
    branchCount: Number(row.branch_count),
    userCount: Number(row.user_count)
  }));
}

export async function setCompanyActive(companyId: string, active: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_company_active", { p_company_id: companyId, p_active: active });
  if (error) throw error;
}
