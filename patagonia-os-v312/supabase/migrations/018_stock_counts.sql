-- Conteo de stock por categoría (achura, cerdo, pollo, vacuno, embutidos,
-- preparados, varios), cargado por fecha (lunes por pesaje semanal, día 1 por
-- conteo mensual). Rentabilidad usa el conteo más reciente disponible en o antes
-- de la fecha de inicio/fin del período elegido como "stock inicial"/"stock final".
create table if not exists public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  count_date date not null,
  category text not null,
  value numeric(14,2) not null check (value >= 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, branch_id, count_date, category)
);

alter table public.stock_counts enable row level security;

create policy "stock_counts_company_isolation"
on public.stock_counts for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create or replace function public.save_stock_count(
  p_branch_id uuid,
  p_count_date date,
  p_category text,
  p_value numeric
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

  if p_category is null or length(trim(p_category)) = 0 then
    raise exception 'La categoría es obligatoria';
  end if;

  if p_value is null or p_value < 0 then
    raise exception 'El valor no puede ser negativo';
  end if;

  insert into public.stock_counts (company_id, branch_id, count_date, category, value, created_by)
  values (v_company_id, p_branch_id, p_count_date, trim(p_category), p_value, v_user_id)
  on conflict (company_id, branch_id, count_date, category)
  do update set value = excluded.value
  returning id into v_id;

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.save_stock_count(uuid,date,text,numeric) from public;
grant execute on function public.save_stock_count(uuid,date,text,numeric) to authenticated;

create or replace function public.delete_stock_count(
  p_stock_count_id uuid
)
returns jsonb
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

  delete from public.stock_counts where id = p_stock_count_id and company_id = v_company_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_stock_count(uuid) from public;
grant execute on function public.delete_stock_count(uuid) to authenticated;
