-- Categorías de productos (Carne, Cerdo, Pollo, Achuras, etc.) -- administrables
-- por el cliente, no una lista fija en el código. Cada compañía tiene las suyas
-- (se siembran unas por defecto para las que ya existen), y un producto puede
-- quedar sin categoría (category_id null) -- los 219 productos ya cargados no
-- se les asigna nada automáticamente acá, hay que hacerlo a mano después.
create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

alter table public.product_categories enable row level security;

create policy "product_categories_company_isolation"
on public.product_categories for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

alter table public.products
  add column if not exists category_id uuid references public.product_categories(id);

-- products_with_stock expone category_id -- create or replace view solo permite
-- agregar columnas al final, no reordenar/sacar las que ya estaban (031_fix_view_rls_bypass.sql).
create or replace view public.products_with_stock as
select
  p.id,
  p.company_id,
  b.id as branch_id,
  p.code,
  p.name,
  p.unit,
  p.cost,
  p.price_retail,
  p.min_stock,
  p.active,
  coalesce(cs.quantity, 0) as stock,
  p.category_id
from public.products p
cross join public.branches b
left join public.current_stock cs
  on cs.company_id = p.company_id
 and cs.branch_id = b.id
 and cs.product_id = p.id
where b.company_id = p.company_id
  and b.active = true
  and p.company_id = public.current_company_id();

insert into public.product_categories (company_id, name)
select c.id, cat.name
from public.companies c
cross join (
  values ('Carne'), ('Cerdo'), ('Pollo'), ('Achuras'), ('Embutidos'), ('Almacén'), ('Leña y Carbón'), ('Combos')
) as cat(name)
on conflict (company_id, name) do nothing;

create or replace function public.create_product_category(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_category_id uuid := gen_random_uuid();
  v_name text := trim(p_name);
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

  if v_name is null or length(v_name) = 0 then
    raise exception 'El nombre de la categoría es obligatorio';
  end if;

  insert into public.product_categories (id, company_id, name)
  values (v_category_id, v_company_id, v_name);

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'product_category.create', 'product_category', v_category_id::text,
    jsonb_build_object('name', v_name)
  );

  return jsonb_build_object('id', v_category_id, 'name', v_name);
end;
$$;

revoke all on function public.create_product_category(text) from public;
grant execute on function public.create_product_category(text) to authenticated;

create or replace function public.update_product_category(p_category_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_name text := trim(p_name);
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
    select 1 from public.product_categories where id = p_category_id and company_id = v_company_id
  ) then
    raise exception 'Categoría inválida';
  end if;

  if v_name is null or length(v_name) = 0 then
    raise exception 'El nombre de la categoría es obligatorio';
  end if;

  update public.product_categories set name = v_name where id = p_category_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'product_category.update', 'product_category', p_category_id::text,
    jsonb_build_object('name', v_name)
  );

  return jsonb_build_object('id', p_category_id, 'name', v_name);
end;
$$;

revoke all on function public.update_product_category(uuid, text) from public;
grant execute on function public.update_product_category(uuid, text) to authenticated;

create or replace function public.delete_product_category(p_category_id uuid)
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

  if not exists (
    select 1 from public.product_categories where id = p_category_id and company_id = v_company_id
  ) then
    raise exception 'Categoría inválida';
  end if;

  update public.products set category_id = null where category_id = p_category_id and company_id = v_company_id;

  delete from public.product_categories where id = p_category_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'product_category.delete', 'product_category', p_category_id::text, '{}'::jsonb
  );
end;
$$;

revoke all on function public.delete_product_category(uuid) from public;
grant execute on function public.delete_product_category(uuid) to authenticated;

-- create_product/update_product ahora aceptan p_category_id (nullable) al final.
create or replace function public.create_product(
  p_branch_id uuid,
  p_code text,
  p_name text,
  p_unit text,
  p_cost numeric,
  p_price_retail numeric,
  p_min_stock numeric,
  p_category_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid := gen_random_uuid();
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

  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'El código es obligatorio';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if p_unit not in ('kg','unit','box') then
    raise exception 'Unidad inválida';
  end if;

  if p_cost is null or p_cost < 0 or p_price_retail is null or p_price_retail < 0 then
    raise exception 'El costo y el precio no pueden ser negativos';
  end if;

  if p_category_id is not null and not exists (
    select 1 from public.product_categories where id = p_category_id and company_id = v_company_id
  ) then
    raise exception 'Categoría inválida';
  end if;

  insert into public.products (id, company_id, code, name, unit, cost, price_retail, min_stock, category_id)
  values (v_id, v_company_id, trim(p_code), trim(p_name), p_unit, p_cost, p_price_retail, coalesce(p_min_stock, 0), p_category_id);

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'product.create', 'product', v_id::text,
    jsonb_build_object('code', p_code, 'name', p_name, 'cost', p_cost, 'price_retail', p_price_retail, 'category_id', p_category_id)
  );

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_product(uuid,text,text,text,numeric,numeric,numeric,uuid) from public;
grant execute on function public.create_product(uuid,text,text,text,numeric,numeric,numeric,uuid) to authenticated;

drop function if exists public.create_product(uuid,text,text,text,numeric,numeric,numeric);

create or replace function public.update_product(
  p_branch_id uuid,
  p_product_id uuid,
  p_code text,
  p_name text,
  p_unit text,
  p_cost numeric,
  p_price_retail numeric,
  p_min_stock numeric,
  p_active boolean,
  p_category_id uuid default null
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

  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'El código es obligatorio';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if p_unit not in ('kg','unit','box') then
    raise exception 'Unidad inválida';
  end if;

  if p_cost is null or p_cost < 0 or p_price_retail is null or p_price_retail < 0 then
    raise exception 'El costo y el precio no pueden ser negativos';
  end if;

  if p_category_id is not null and not exists (
    select 1 from public.product_categories where id = p_category_id and company_id = v_company_id
  ) then
    raise exception 'Categoría inválida';
  end if;

  update public.products
  set code = trim(p_code), name = trim(p_name), unit = p_unit, cost = p_cost,
      price_retail = p_price_retail, min_stock = coalesce(p_min_stock, 0), active = p_active,
      category_id = p_category_id
  where id = p_product_id and company_id = v_company_id;

  if not found then
    raise exception 'Producto inválido';
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'product.update', 'product', p_product_id::text,
    jsonb_build_object('code', p_code, 'name', p_name, 'cost', p_cost, 'price_retail', p_price_retail, 'active', p_active, 'category_id', p_category_id)
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.update_product(uuid,uuid,text,text,text,numeric,numeric,numeric,boolean,uuid) from public;
grant execute on function public.update_product(uuid,uuid,text,text,text,numeric,numeric,numeric,boolean,uuid) to authenticated;

drop function if exists public.update_product(uuid,uuid,text,text,text,numeric,numeric,numeric,boolean);
