import { supabase } from "../../lib/supabase";

export interface AuditLogEntry {
  id: number;
  branchId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  oldData: unknown;
  newData: unknown;
  createdAt: string;
}

export interface ListAuditLogInput {
  from: string;
  to: string;
  userId?: string;
}

export async function listAuditLog(input: ListAuditLogInput): Promise<AuditLogEntry[]> {
  if (!supabase) return [];

  let query = supabase
    .from("audit_log")
    .select("id,branch_id,user_id,action,entity_type,entity_id,old_data,new_data,created_at")
    .gte("created_at", `${input.from}T00:00:00`)
    .lte("created_at", `${input.to}T23:59:59.999`)
    .order("created_at", { ascending: false })
    .limit(300);

  if (input.userId) query = query.eq("user_id", input.userId);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    branchId: row.branch_id,
    userId: row.user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    oldData: row.old_data,
    newData: row.new_data,
    createdAt: row.created_at
  }));
}
