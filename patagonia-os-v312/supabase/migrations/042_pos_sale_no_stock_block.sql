-- El cliente pidio explicitamente que Mostrador nunca bloquee una venta
-- por falta de stock cargado -- el stock recien se esta empezando a
-- cargar (catalogo nuevo, sin compras/despiece todavia) y frenar la venta
-- por eso es mas riesgoso para el negocio que dejar que el stock quede en
-- negativo. Se saca la validacion de "Stock insuficiente" de
-- create_pos_sale; inventory_movements se sigue escribiendo igual, asi que
-- Stock queda como numero informativo (puede ir a negativo) pero ya no
-- corta la venta.
create or replace function public.create_pos_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_account_id uuid,
  p_pos_shift_id uuid,
  p_discount_amount numeric default 0
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
  v_item_discount numeric(14,2);
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

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if not exists (
    select 1 from public.pos_shifts
    where id = p_pos_shift_id and company_id = v_company_id and branch_id = p_branch_id and status = 'open'
  ) then
    raise exception 'No hay un turno de mostrador abierto';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  if p_discount_amount is null or p_discount_amount < 0 then
    raise exception 'Descuento inválido';
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

    v_item_discount := coalesce((v_item->>'discount_amount')::numeric, 0);
    if v_item_discount < 0 then
      raise exception 'Descuento inválido';
    end if;

    v_line_total := (v_quantity * v_product.price_retail) - v_item_discount;
    if v_line_total < 0 then
      raise exception 'El descuento de % supera su precio', v_product.name;
    end if;

    v_total := v_total + v_line_total;
  end loop;

  v_total := v_total - p_discount_amount;
  if v_total < 0 then
    raise exception 'El descuento supera el total de la venta';
  end if;

  insert into public.pos_sales (id, company_id, branch_id, total, account_id, pos_shift_id, discount_amount, created_by)
  values (v_sale_id, v_company_id, p_branch_id, v_total, p_account_id, p_pos_shift_id, p_discount_amount, v_user_id);

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid;

    v_quantity := (v_item->>'quantity')::numeric;
    v_unit_price := v_product.price_retail;
    v_item_discount := coalesce((v_item->>'discount_amount')::numeric, 0);

    insert into public.pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total)
    values (v_sale_id, v_product.id, v_quantity, v_unit_price, v_item_discount, (v_quantity * v_unit_price) - v_item_discount);

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
    jsonb_build_object('total', v_total, 'discount_amount', p_discount_amount, 'pos_shift_id', p_pos_shift_id, 'items', p_items)
  );

  return jsonb_build_object('sale_id', v_sale_id, 'total', v_total);
end;
$$;

revoke all on function public.create_pos_sale(uuid, jsonb, uuid, uuid, numeric) from public;
grant execute on function public.create_pos_sale(uuid, jsonb, uuid, uuid, numeric) to authenticated;
