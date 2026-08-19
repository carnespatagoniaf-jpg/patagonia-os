-- Primer paso para conectar Mostrador con Tesoreria (el escaneo de codigo
-- de barra de la balanza Kretz queda para mas adelante). Antes,
-- create_pos_sale ni pedia medio de pago ni tocaba treasury_movements
-- (ver comentario original en 027_pos_sales.sql) -- era una venta que
-- solo descontaba stock. Ahora la pantalla de cobro pide de que cuenta
-- entra la plata, y la venta genera el movimiento de caja como
-- corresponde, igual que Turnos.

alter table public.pos_sales
  add column if not exists account_id uuid references public.treasury_accounts(id);

create or replace function public.create_pos_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sale_id uuid := gen_random_uuid();
  v_total numeric(14,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_quantity numeric(14,3);
  v_unit_price numeric(14,2);
  v_stock numeric(14,3);
  v_movement_id uuid;
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
    select 1 from public.branches
    where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid
      and company_id = v_company_id
      and active = true
    for update;

    if not found then
      raise exception 'Producto inválido';
    end if;

    v_quantity := (v_item->>'quantity')::numeric;

    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Cantidad inválida';
    end if;

    select coalesce(sum(quantity), 0) into v_stock
    from public.inventory_movements
    where product_id = v_product.id and branch_id = p_branch_id;

    if v_stock < v_quantity then
      raise exception 'Stock insuficiente de %', v_product.name;
    end if;

    v_total := v_total + (v_quantity * v_product.price_retail);
  end loop;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by
  ) values (
    v_company_id, p_branch_id, p_account_id, 'in', v_total, 'venta',
    'pos_sale', v_sale_id, current_date, 'Venta de mostrador', v_user_id
  )
  returning id into v_movement_id;

  insert into public.pos_sales (id, company_id, branch_id, total, account_id, created_by)
  values (v_sale_id, v_company_id, p_branch_id, v_total, p_account_id, v_user_id);

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid;

    v_quantity := (v_item->>'quantity')::numeric;
    v_unit_price := v_product.price_retail;

    insert into public.pos_sale_items (sale_id, product_id, quantity, unit_price, line_total)
    values (v_sale_id, v_product.id, v_quantity, v_unit_price, v_quantity * v_unit_price);

    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by
    ) values (
      v_company_id, p_branch_id, v_product.id, 'sale', -v_quantity,
      'pos_sale', v_sale_id, 'Venta de mostrador', v_user_id
    );
  end loop;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'pos_sale.create', 'pos_sale', v_sale_id::text,
    jsonb_build_object('total', v_total, 'items', p_items, 'account_id', p_account_id)
  );

  return jsonb_build_object('sale_id', v_sale_id, 'total', v_total);
end;
$$;

revoke all on function public.create_pos_sale(uuid, jsonb, uuid) from public;
grant execute on function public.create_pos_sale(uuid, jsonb, uuid) to authenticated;

drop function if exists public.create_pos_sale(uuid, jsonb);
