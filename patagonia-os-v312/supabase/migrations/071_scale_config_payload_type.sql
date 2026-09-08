-- Algunas balanzas (ej. Kretz Aura Eco, tipo "ticket continuo") graban en
-- el código el IMPORTE final ya calculado en vez del peso -- variante
-- distinta a la que ya soporta 070_branch_scale_config.sql. Se agrega
-- payload_type para que el mismo asistente de calibración sirva para las
-- dos: el carnicero elige si su balanza muestra "Peso" o "Importe" antes
-- de calibrar. Sigue haciendo falta que el código traiga un PLU real --
-- un ticket que solo trae el total de varios productos juntos, sin PLU,
-- no se puede leer así (no hay forma de saber qué se vendió).
alter table public.branch_scale_configs
  add column if not exists payload_type text not null default 'weight' check (payload_type in ('weight', 'amount'));

create or replace function public.save_branch_scale_config(
  p_branch_id uuid,
  p_prefix_length int,
  p_plu_length int,
  p_weight_length int,
  p_weight_divisor numeric,
  p_total_length int,
  p_payload_type text default 'weight'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if not exists (
    select 1 from public.branches where id = p_branch_id and company_id = v_company_id
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if p_prefix_length is null or p_prefix_length < 0
    or p_plu_length is null or p_plu_length <= 0
    or p_weight_length is null or p_weight_length <= 0
    or p_weight_divisor is null or p_weight_divisor <= 0
    or p_total_length is null or p_total_length <= 0
  then
    raise exception 'Configuración de balanza inválida';
  end if;

  if p_payload_type not in ('weight', 'amount') then
    raise exception 'Tipo de valor inválido';
  end if;

  insert into public.branch_scale_configs (
    company_id, branch_id, prefix_length, plu_length, weight_length, weight_divisor, total_length, payload_type, created_by
  ) values (
    v_company_id, p_branch_id, p_prefix_length, p_plu_length, p_weight_length, p_weight_divisor, p_total_length, p_payload_type, v_user_id
  )
  on conflict (branch_id) do update
  set prefix_length = excluded.prefix_length,
      plu_length = excluded.plu_length,
      weight_length = excluded.weight_length,
      weight_divisor = excluded.weight_divisor,
      total_length = excluded.total_length,
      payload_type = excluded.payload_type,
      updated_at = now()
  returning id into v_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'branch_scale_config.save', 'branch_scale_config', v_id::text,
    jsonb_build_object(
      'prefix_length', p_prefix_length, 'plu_length', p_plu_length, 'weight_length', p_weight_length,
      'weight_divisor', p_weight_divisor, 'total_length', p_total_length, 'payload_type', p_payload_type
    )
  );

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.save_branch_scale_config(uuid,int,int,int,numeric,int,text) from public;
grant execute on function public.save_branch_scale_config(uuid,int,int,int,numeric,int,text) to authenticated;

drop function if exists public.save_branch_scale_config(uuid,int,int,int,numeric,int);
