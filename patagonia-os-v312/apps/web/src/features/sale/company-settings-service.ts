import { supabase } from "../../lib/supabase";

/** PIN de 4 dígitos para revelar "Ver movimientos" y "Ver movimientos de
 * caja" en Mostrador -- ver 078_mostrador_pin.sql. No es una barrera dura
 * (companies ya es legible por cualquier usuario de la empresa vía RLS),
 * es un freno para que no se vea "sin querer" al pasar frente al
 * mostrador con la pantalla abierta. null = todavía no se configuró
 * ningún PIN, así que no hay nada que pedir. */
export async function getMostradorPin(): Promise<string | null> {
  if (!supabase) return null;

  const { data, error } = await supabase.from("companies").select("mostrador_pin").single();
  if (error) return null;
  return data?.mostrador_pin ?? null;
}

export async function setMostradorPin(pin: string | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_mostrador_pin", { p_pin: pin });
  if (error) throw error;
}
