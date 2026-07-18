-- Despiece: cargar una res/media res/pollo (peso y precio total pagado) y por
-- cada corte el peso obtenido y el precio de venta por kg, para ver la ganancia
-- real de esa compra (venta de todos los cortes menos lo pagado por el animal).
create table if not exists public.carcass_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  batch_date date not null,
  animal_type text not null,
  supplier_id uuid references public.suppliers(id),
  total_weight numeric(14,3) not null check (total_weight > 0),
  total_cost numeric(14,2) not null check (total_cost >= 0),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.carcass_cuts (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.carcass_batches(id) on delete cascade,
  cut_name text not null,
  product_id uuid references public.products(id),
  weight numeric(14,3) not null check (weight > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_total numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

alter table public.carcass_batches enable row level security;
alter table public.carcass_cuts enable row level security;

create policy "carcass_batches_company_isolation"
on public.carcass_batches for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "carcass_cuts_company_isolation"
on public.carcass_cuts for all
using (exists (select 1 from public.carcass_batches b where b.id = batch_id and b.company_id = public.current_company_id()))
with check (exists (select 1 from public.carcass_batches b where b.id = batch_id and b.company_id = public.current_company_id()));

create or replace function public.save_carcass_batch(
  p_batch_id uuid,
  p_branch_id uuid,
  p_batch_date date,
  p_animal_type text,
  p_supplier_id uuid,
  p_total_weight numeric,
  p_total_cost numeric,
  p_notes text
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

  if p_animal_type is null or length(trim(p_animal_type)) = 0 then
    raise exception 'El tipo de animal es obligatorio';
  end if;

  if p_total_weight is null or p_total_weight <= 0 then
    raise exception 'El peso total debe ser mayor que cero';
  end if;

  if p_total_cost is null or p_total_cost < 0 then
    raise exception 'El costo total no puede ser negativo';
  end if;

  if p_batch_id is not null then
    update public.carcass_batches
    set batch_date = p_batch_date, animal_type = trim(p_animal_type), supplier_id = p_supplier_id,
        total_weight = p_total_weight, total_cost = p_total_cost, notes = p_notes
    where id = p_batch_id and company_id = v_company_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Registro inválido';
    end if;
  else
    v_id := gen_random_uuid();
    insert into public.carcass_batches (
      id, company_id, branch_id, batch_date, animal_type, supplier_id, total_weight, total_cost, notes, created_by
    ) values (
      v_id, v_company_id, p_branch_id, p_batch_date, trim(p_animal_type), p_supplier_id, p_total_weight, p_total_cost, p_notes, v_user_id
    );
  end if;

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.save_carcass_batch(uuid,uuid,date,text,uuid,numeric,numeric,text) from public;
grant execute on function public.save_carcass_batch(uuid,uuid,date,text,uuid,numeric,numeric,text) to authenticated;

create or replace function public.delete_carcass_batch(
  p_batch_id uuid
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

  delete from public.carcass_batches where id = p_batch_id and company_id = v_company_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_carcass_batch(uuid) from public;
grant execute on function public.delete_carcass_batch(uuid) to authenticated;

create or replace function public.save_carcass_cut(
  p_cut_id uuid,
  p_batch_id uuid,
  p_cut_name text,
  p_product_id uuid,
  p_weight numeric,
  p_unit_price numeric
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
  v_line_total numeric(14,2);
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

  if p_cut_name is null or length(trim(p_cut_name)) = 0 then
    raise exception 'El nombre del corte es obligatorio';
  end if;

  if p_weight is null or p_weight <= 0 then
    raise exception 'El peso debe ser mayor que cero';
  end if;

  if p_unit_price is null or p_unit_price < 0 then
    raise exception 'El precio no puede ser negativo';
  end if;

  if not exists (
    select 1 from public.carcass_batches where id = p_batch_id and company_id = v_company_id
  ) then
    raise exception 'Res inválida';
  end if;

  v_line_total := round(p_weight * p_unit_price, 2);

  if p_cut_id is not null then
    update public.carcass_cuts
    set cut_name = trim(p_cut_name), product_id = p_product_id, weight = p_weight,
        unit_price = p_unit_price, line_total = v_line_total
    where id = p_cut_id and batch_id = p_batch_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Corte inválido';
    end if;
  else
    v_id := gen_random_uuid();
    insert into public.carcass_cuts (id, batch_id, cut_name, product_id, weight, unit_price, line_total)
    values (v_id, p_batch_id, trim(p_cut_name), p_product_id, p_weight, p_unit_price, v_line_total);
  end if;

  return jsonb_build_object('id', v_id, 'line_total', v_line_total);
end;
$$;

revoke all on function public.save_carcass_cut(uuid,uuid,text,uuid,numeric,numeric) from public;
grant execute on function public.save_carcass_cut(uuid,uuid,text,uuid,numeric,numeric) to authenticated;

create or replace function public.delete_carcass_cut(
  p_cut_id uuid
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

  delete from public.carcass_cuts cc
  using public.carcass_batches b
  where cc.id = p_cut_id and cc.batch_id = b.id and b.company_id = v_company_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_carcass_cut(uuid) from public;
grant execute on function public.delete_carcass_cut(uuid) to authenticated;
