-- Ajuste manual de stock: como Ventas no carga la venta producto por producto,
-- el stock nunca baja solo (solo sube con Compras). Este RPC deja contar lo
-- que hay físicamente y corrige la diferencia con un movimiento de ajuste.
create or replace function public.adjust_product_stock(
  p_branch_id uuid,
  p_product_id uuid,
  p_counted_quantity numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_current numeric(14,3);
  v_delta numeric(14,3);
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
    select 1 from public.products where id = p_product_id and company_id = v_company_id
  ) then
    raise exception 'Producto inválido';
  end if;

  if not exists (
    select 1 from public.branches where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if p_counted_quantity is null or p_counted_quantity < 0 then
    raise exception 'La cantidad contada no puede ser negativa';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo es obligatorio';
  end if;

  select coalesce(sum(quantity), 0) into v_current
  from public.inventory_movements
  where company_id = v_company_id and branch_id = p_branch_id and product_id = p_product_id;

  v_delta := p_counted_quantity - v_current;

  if v_delta <> 0 then
    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reason, created_by
    ) values (
      v_company_id, p_branch_id, p_product_id, 'adjustment', v_delta,
      'manual_adjustment', trim(p_reason), v_user_id
    )
    returning id into v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'stock.adjust', 'product', p_product_id::text,
    jsonb_build_object('previous', v_current, 'counted', p_counted_quantity, 'delta', v_delta, 'reason', p_reason)
  );

  return jsonb_build_object('previous', v_current, 'counted', p_counted_quantity, 'delta', v_delta);
end;
$$;

revoke all on function public.adjust_product_stock(uuid,uuid,numeric,text) from public;
grant execute on function public.adjust_product_stock(uuid,uuid,numeric,text) to authenticated;
