-- Importacion masiva desde Excel/CSV: productos, proveedores y clientes.
-- Solo dueño o administrador. Cada funcion es atomica: si UNA fila es invalida
-- no se importa nada (el mensaje dice cual fila). Todo se valida contra la
-- empresa del que llama. Queda un registro de auditoria por importacion.

create or replace function public.import_products(
  p_branch_id uuid,
  p_rows jsonb,
  p_update_existing boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_row jsonb;
  v_idx int := 0;
  v_label text;
  v_code text;
  v_name text;
  v_unit text;
  v_cost numeric;
  v_price numeric;
  v_min numeric;
  v_stock numeric;
  v_cat_name text;
  v_cat_id uuid;
  v_sort int;
  v_product_id uuid;
  v_current numeric;
  v_seen text[] := '{}';
  v_created int := 0;
  v_updated int := 0;
  v_skipped int := 0;
  v_stock_rows int := 0;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para importar datos';
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'No hay filas para importar';
  end if;

  if jsonb_array_length(p_rows) > 3000 then
    raise exception 'Demasiadas filas de una vez (máximo 3000)';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_idx := v_idx + 1;
    v_label := coalesce(nullif(v_row->>'row', ''), v_idx::text);
    v_code := trim(coalesce(v_row->>'code', ''));
    v_name := trim(coalesce(v_row->>'name', ''));
    v_unit := coalesce(nullif(trim(v_row->>'unit'), ''), 'kg');
    v_cost := coalesce(nullif(v_row->>'cost', '')::numeric, 0);
    v_price := coalesce(nullif(v_row->>'price_retail', '')::numeric, 0);
    v_min := coalesce(nullif(v_row->>'min_stock', '')::numeric, 0);
    v_stock := nullif(v_row->>'stock', '')::numeric;
    v_cat_name := nullif(trim(coalesce(v_row->>'category', '')), '');

    if v_code = '' then raise exception 'Fila %: falta el código', v_label; end if;
    if v_name = '' then raise exception 'Fila %: falta el nombre', v_label; end if;
    if v_unit not in ('kg', 'unit', 'box') then raise exception 'Fila %: unidad inválida "%"', v_label, v_unit; end if;
    if v_cost < 0 or v_price < 0 or v_min < 0 or v_cost > 1000000000 or v_price > 1000000000 then
      raise exception 'Fila %: costo, precio o stock mínimo fuera de rango', v_label;
    end if;
    if v_stock is not null and (v_stock < 0 or v_stock > 100000000) then
      raise exception 'Fila %: stock fuera de rango', v_label;
    end if;
    if lower(v_code) = any (v_seen) then
      raise exception 'Fila %: el código "%" está repetido en el archivo', v_label, v_code;
    end if;
    v_seen := v_seen || lower(v_code);

    v_cat_id := null;
    if v_cat_name is not null then
      select id into v_cat_id
      from public.product_categories
      where company_id = v_company_id and lower(name) = lower(v_cat_name);

      if v_cat_id is null then
        select coalesce(max(sort_order), 0) + 1 into v_sort
        from public.product_categories where company_id = v_company_id;
        v_cat_id := gen_random_uuid();
        insert into public.product_categories (id, company_id, name, sort_order)
        values (v_cat_id, v_company_id, v_cat_name, v_sort);
      end if;
    end if;

    v_product_id := null;
    select id into v_product_id
    from public.products
    where company_id = v_company_id and lower(code) = lower(v_code)
    for update;

    if v_product_id is not null then
      if not p_update_existing then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      -- Se actualiza nombre, costo, precio, minimo y categoria; NUNCA la unidad
      -- (cambiarla dejaria mal el stock ya cargado).
      update public.products
      set name = v_name, cost = v_cost, price_retail = v_price, min_stock = v_min,
          category_id = coalesce(v_cat_id, category_id)
      where id = v_product_id;
      v_updated := v_updated + 1;
    else
      v_product_id := gen_random_uuid();
      insert into public.products (id, company_id, code, name, unit, cost, price_retail, min_stock, category_id)
      values (v_product_id, v_company_id, v_code, v_name, v_unit, v_cost, v_price, v_min, v_cat_id);
      v_created := v_created + 1;
    end if;

    if v_stock is not null then
      select coalesce(sum(quantity), 0) into v_current
      from public.inventory_movements
      where company_id = v_company_id and branch_id = p_branch_id and product_id = v_product_id;

      if v_stock - v_current <> 0 then
        insert into public.inventory_movements (
          company_id, branch_id, product_id, movement_type, quantity, reference_type, reason, created_by
        ) values (
          v_company_id, p_branch_id, v_product_id, 'adjustment', v_stock - v_current,
          'manual_adjustment', 'Importación desde archivo', v_user_id
        );
        v_stock_rows := v_stock_rows + 1;
      end if;
    end if;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'product.import', 'product', 'import',
          jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped, 'stock_adjusted', v_stock_rows, 'update_existing', p_update_existing));

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped, 'stock_adjusted', v_stock_rows);
end;
$$;

revoke all on function public.import_products(uuid, jsonb, boolean) from public;
grant execute on function public.import_products(uuid, jsonb, boolean) to authenticated;


create or replace function public.import_suppliers(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_row jsonb;
  v_idx int := 0;
  v_label text;
  v_name text;
  v_seen text[] := '{}';
  v_created int := 0;
  v_skipped int := 0;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para importar datos';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'No hay filas para importar';
  end if;

  if jsonb_array_length(p_rows) > 3000 then
    raise exception 'Demasiadas filas de una vez (máximo 3000)';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_idx := v_idx + 1;
    v_label := coalesce(nullif(v_row->>'row', ''), v_idx::text);
    v_name := trim(coalesce(v_row->>'name', ''));
    if v_name = '' then raise exception 'Fila %: falta el nombre', v_label; end if;
    if lower(v_name) = any (v_seen) then raise exception 'Fila %: "%" está repetido en el archivo', v_label, v_name; end if;
    v_seen := v_seen || lower(v_name);

    if exists (select 1 from public.suppliers where company_id = v_company_id and lower(trim(name)) = lower(v_name)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.suppliers (id, company_id, name, category, phone, notes)
    values (
      gen_random_uuid(), v_company_id, v_name,
      coalesce(nullif(trim(coalesce(v_row->>'category', '')), ''), 'general'),
      nullif(trim(coalesce(v_row->>'phone', '')), ''),
      nullif(trim(coalesce(v_row->>'notes', '')), '')
    );
    v_created := v_created + 1;
  end loop;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'supplier.import', 'supplier', 'import',
          jsonb_build_object('created', v_created, 'skipped', v_skipped));

  return jsonb_build_object('created', v_created, 'skipped', v_skipped);
end;
$$;

revoke all on function public.import_suppliers(jsonb) from public;
grant execute on function public.import_suppliers(jsonb) to authenticated;


create or replace function public.import_customers(p_branch_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_row jsonb;
  v_idx int := 0;
  v_label text;
  v_name text;
  v_seen text[] := '{}';
  v_created int := 0;
  v_skipped int := 0;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para importar datos';
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'No hay filas para importar';
  end if;

  if jsonb_array_length(p_rows) > 3000 then
    raise exception 'Demasiadas filas de una vez (máximo 3000)';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_idx := v_idx + 1;
    v_label := coalesce(nullif(v_row->>'row', ''), v_idx::text);
    v_name := trim(coalesce(v_row->>'name', ''));
    if v_name = '' then raise exception 'Fila %: falta el nombre', v_label; end if;
    if lower(v_name) = any (v_seen) then raise exception 'Fila %: "%" está repetido en el archivo', v_label, v_name; end if;
    v_seen := v_seen || lower(v_name);

    if exists (select 1 from public.customers where company_id = v_company_id and lower(trim(name)) = lower(v_name)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.customers (id, company_id, branch_id, name, phone, notes, locality, province)
    values (
      gen_random_uuid(), v_company_id, p_branch_id, v_name,
      nullif(trim(coalesce(v_row->>'phone', '')), ''),
      nullif(trim(coalesce(v_row->>'notes', '')), ''),
      nullif(trim(coalesce(v_row->>'locality', '')), ''),
      nullif(trim(coalesce(v_row->>'province', '')), '')
    );
    v_created := v_created + 1;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'customer.import', 'customer', 'import',
          jsonb_build_object('created', v_created, 'skipped', v_skipped));

  return jsonb_build_object('created', v_created, 'skipped', v_skipped);
end;
$$;

revoke all on function public.import_customers(uuid, jsonb) from public;
grant execute on function public.import_customers(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
