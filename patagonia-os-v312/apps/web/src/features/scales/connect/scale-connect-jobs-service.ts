import { supabase } from "../../../lib/supabase";
import { isMissingFunction } from "../job-log";
import { parseConnectStatus, parseJobItems, parseJobRow, type ScaleConnectPort } from "./scale-connect-jobs";

/**
 * ScaleConnectPort con la base real (migraciones 226 y 227):
 * - scale_connect_status / bind_scale_to_connector (227), queue_scale_job (226): RPC.
 * - El trabajo y sus productos se leen directo (scale_jobs / scale_job_items: RLS por empresa, migración 220).
 * Sin la 227 (o en modo demostración) status devuelve null y Mis balanzas sigue como siempre (Web Serial).
 */
export const scaleConnectPort: ScaleConnectPort = {
  async status(branchId) {
    if (!supabase) return null;
    const { data, error } = await supabase.rpc("scale_connect_status", { p_branch_id: branchId });
    if (error) {
      if (isMissingFunction(error)) return null;
      throw new Error(error.message);
    }
    return parseConnectStatus(data);
  },

  async queue(input) {
    if (!supabase) throw new Error("En modo demostración no se puede usar Scale Connect.");
    const { data, error } = await supabase.rpc("queue_scale_job", {
      p_scale_key: input.scaleKey,
      p_kind: input.kind,
      p_payload: input.payload,
      p_branch_id: input.branchId,
      p_connector_id: input.connectorId
    });
    if (error) throw new Error(error.message);
    return String(data);
  },

  async job(id) {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("scale_jobs")
      .select("id, status, progress, error_code, requested_count, confirmed_count, failed_count, skipped_count")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const job = parseJobRow(data);
    if (!job) return null;
    if (job.status === "queued" || job.status === "running") return { job, items: [] };
    const items = await supabase
      .from("scale_job_items")
      .select("product_id, plu, action, status, reason, sent, read_back")
      .eq("job_id", id)
      .limit(10000);
    if (items.error) throw new Error(items.error.message);
    return { job, items: parseJobItems(items.data) };
  },

  async bind(branchId, scaleKey, connectorId, device) {
    if (!supabase) throw new Error("En modo demostración no se puede usar Scale Connect.");
    const { error } = await supabase.rpc("bind_scale_to_connector", {
      p_branch_id: branchId,
      p_scale_key: scaleKey,
      p_connector_id: connectorId,
      p_device: device
    });
    if (error) throw new Error(error.message);
  }
};
