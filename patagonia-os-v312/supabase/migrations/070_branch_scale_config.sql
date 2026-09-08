-- No hay un formato único de código de barras de balanza -- ni siquiera
-- Kretz usa siempre el mismo (prefijo/PLU/peso configurables en el propio
-- menú de la balanza, además de la variante "importe" en vez de peso). El
-- parser de Mostrador (parseWeightBarcode en Sale.tsx) tenía UN formato
-- hardcodeado (Kretz "peso": prefijo 1 dígito + PLU 5 + peso en gramos 5).
-- Como el dueño no quiere pedirle a carniceros no técnicos que configuren
-- dígitos/posiciones a mano, la calibración es automática desde el
-- frontend (escanea una etiqueta + decís qué peso mostró la balanza, y el
-- sistema prueba combinaciones hasta encontrar la que da ese peso) -- acá
-- solo se guarda el resultado ya resuelto, por sucursal (la balanza es
-- física, está atada a un local, no a la empresa entera).
create table if not exists public.branch_scale_configs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id) unique,
  prefix_length int not null,
  plu_length int not null,
  weight_length int not null,
  weight_divisor numeric not null,
  total_length int not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.branch_scale_configs enable row level security;

create policy "branch_scale_configs_company_isolation"
on public.branch_scale_configs for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create or replace function public.save_branch_scale_config(
  p_branch_id uuid,
  p_prefix_length int,
  p_plu_length int,
  p_weight_length int,
  p_weight_divisor numeric,
  p_total_length int
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

  insert into public.branch_scale_configs (
    company_id, branch_id, prefix_length, plu_length, weight_length, weight_divisor, total_length, created_by
  ) values (
    v_company_id, p_branch_id, p_prefix_length, p_plu_length, p_weight_length, p_weight_divisor, p_total_length, v_user_id
  )
  on conflict (branch_id) do update
  set prefix_length = excluded.prefix_length,
      plu_length = excluded.plu_length,
      weight_length = excluded.weight_length,
      weight_divisor = excluded.weight_divisor,
      total_length = excluded.total_length,
      updated_at = now()
  returning id into v_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'branch_scale_config.save', 'branch_scale_config', v_id::text,
    jsonb_build_object('prefix_length', p_prefix_length, 'plu_length', p_plu_length, 'weight_length', p_weight_length, 'weight_divisor', p_weight_divisor, 'total_length', p_total_length)
  );

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.save_branch_scale_config(uuid,int,int,int,numeric,int) from public;
grant execute on function public.save_branch_scale_config(uuid,int,int,int,numeric,int) to authenticated;

create or replace function public.delete_branch_scale_config(p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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

  delete from public.branch_scale_configs where branch_id = p_branch_id and company_id = v_company_id;
end;
$$;

revoke all on function public.delete_branch_scale_config(uuid) from public;
grant execute on function public.delete_branch_scale_config(uuid) to authenticated;
