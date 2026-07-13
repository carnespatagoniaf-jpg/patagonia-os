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
  coalesce(cs.quantity, 0) as stock
from public.products p
cross join public.branches b
left join public.current_stock cs
  on cs.company_id = p.company_id
 and cs.branch_id = b.id
 and cs.product_id = p.id
where b.company_id = p.company_id
  and b.active = true;

create or replace function public.create_sale_transaction(
  p_branch_id uuid,
  p_payment_method text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_cash_session_id uuid;
  v_sale_id uuid := gen_random_uuid();
  v_total numeric(14,2) := 0;
  v_cost_total numeric(14,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_quantity numeric(14,3);
  v_unit_price numeric(14,2);
  v_stock numeric(14,3);
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

  select id into v_cash_session_id
  from public.cash_sessions
  where branch_id = p_branch_id
    and company_id = v_company_id
    and status = 'open'
  for update;

  if v_cash_session_id is null then
    raise exception 'No hay caja abierta';
  end if;

  if jsonb_array_length(p_items) = 0 then
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
    v_unit_price := (v_item->>'unit_price')::numeric;

    if v_quantity <= 0 or v_unit_price < 0 then
      raise exception 'Cantidad o precio inválido';
    end if;

    select coalesce(sum(quantity),0) into v_stock
    from public.inventory_movements
    where product_id = v_product.id and branch_id = p_branch_id;

    if v_stock < v_quantity then
      raise exception 'Stock insuficiente de %', v_product.name;
    end if;

    v_total := v_total + (v_quantity * v_unit_price);
    v_cost_total := v_cost_total + (v_quantity * v_product.cost);
  end loop;

  insert into public.sales (
    id, company_id, branch_id, cash_session_id, payment_method,
    total, cost_total, profit, status, created_by
  ) values (
    v_sale_id, v_company_id, p_branch_id, v_cash_session_id, p_payment_method,
    v_total, v_cost_total, v_total-v_cost_total, 'completed', v_user_id
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid;

    v_quantity := (v_item->>'quantity')::numeric;
    v_unit_price := (v_item->>'unit_price')::numeric;

    insert into public.sale_items (
      sale_id, product_id, quantity, unit_price, line_total, line_cost
    ) values (
      v_sale_id, v_product.id, v_quantity, v_unit_price,
      v_quantity*v_unit_price, v_quantity*v_product.cost
    );

    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by
    ) values (
      v_company_id, p_branch_id, v_product.id, 'sale', -v_quantity,
      'sale', v_sale_id, 'Venta', v_user_id
    );
  end loop;

  insert into public.cash_movements (
    company_id, branch_id, cash_session_id, direction, payment_method,
    amount, movement_type, reference_type, reference_id, reason, created_by
  ) values (
    v_company_id, p_branch_id, v_cash_session_id, 'in', p_payment_method,
    v_total, 'sale', 'sale', v_sale_id, 'Venta', v_user_id
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'sale.create', 'sale', v_sale_id::text,
    jsonb_build_object('total',v_total,'profit',v_total-v_cost_total)
  );

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'total', v_total,
    'profit', v_total-v_cost_total
  );
end;
$$;

revoke all on function public.create_sale_transaction(uuid,text,jsonb) from public;
grant execute on function public.create_sale_transaction(uuid,text,jsonb) to authenticated;
