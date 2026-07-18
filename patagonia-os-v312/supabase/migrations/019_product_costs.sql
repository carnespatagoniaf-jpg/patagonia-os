-- Alta/edición de productos (costo, precio de venta, stock mínimo) — hasta ahora
-- la tabla products no tenía ningún RPC de escritura, Stock corría en modo demo.
create or replace function public.create_product(
  p_branch_id uuid,
  p_code text,
  p_name text,
  p_unit text,
  p_cost numeric,
  p_price_retail numeric,
  p_min_stock numeric
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

  insert into public.products (id, company_id, code, name, unit, cost, price_retail, min_stock)
  values (v_id, v_company_id, trim(p_code), trim(p_name), p_unit, p_cost, p_price_retail, coalesce(p_min_stock, 0));

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'product.create', 'product', v_id::text,
    jsonb_build_object('code', p_code, 'name', p_name, 'cost', p_cost, 'price_retail', p_price_retail)
  );

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_product(uuid,text,text,text,numeric,numeric,numeric) from public;
grant execute on function public.create_product(uuid,text,text,text,numeric,numeric,numeric) to authenticated;

create or replace function public.update_product(
  p_branch_id uuid,
  p_product_id uuid,
  p_code text,
  p_name text,
  p_unit text,
  p_cost numeric,
  p_price_retail numeric,
  p_min_stock numeric,
  p_active boolean
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

  update public.products
  set code = trim(p_code), name = trim(p_name), unit = p_unit, cost = p_cost,
      price_retail = p_price_retail, min_stock = coalesce(p_min_stock, 0), active = p_active
  where id = p_product_id and company_id = v_company_id;

  if not found then
    raise exception 'Producto inválido';
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'product.update', 'product', p_product_id::text,
    jsonb_build_object('code', p_code, 'name', p_name, 'cost', p_cost, 'price_retail', p_price_retail, 'active', p_active)
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.update_product(uuid,uuid,text,text,text,numeric,numeric,numeric,boolean) from public;
grant execute on function public.update_product(uuid,uuid,text,text,text,numeric,numeric,numeric,boolean) to authenticated;
