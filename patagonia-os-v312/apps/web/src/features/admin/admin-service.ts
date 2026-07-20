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
