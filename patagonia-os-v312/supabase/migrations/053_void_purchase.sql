-- El dueño pidió poder borrar una compra ("factura") cargada mal --
-- hoy no hay forma de sacarla, solo de editar item por item. Sigue el
-- mismo patrón que void_pos_sale (043_split_payments_and_surcharge.sql):
-- no se borra nada, se revierte el stock con un movimiento inverso y se
-- marca la compra como anulada (purchases.status, que ya existía y
-- supplier_balance ya filtra por status = 'active' -- este RPC faltaba
-- para poder usarlo).
create or replace function public.void_purchase(p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_purchase public.purchases%rowtype;
  v_item record;
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

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Compra inválida';
  end if;

  if v_purchase.status <> 'active' then
    raise exception 'Esa compra ya está anulada';
  end if;

  for v_item in
    select product_id, quantity from public.purchase_items
    where purchase_id = p_purchase_id and product_id is not null
  loop
    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by
    ) values (
      v_company_id, v_purchase.branch_id, v_item.product_id, 'purchase_void', -v_item.quantity,
      'purchase_void', p_purchase_id, 'Anulación de compra', v_user_id
    );
  end loop;

  update public.purchases
  set status = 'voided'
  where id = p_purchase_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_purchase.branch_id, v_user_id, 'purchase.void', 'purchase', p_purchase_id::text,
    jsonb_build_object('invoice_number', v_purchase.invoice_number, 'total', v_purchase.total)
  );
end;
$$;

revoke all on function public.void_purchase(uuid) from public;
grant execute on function public.void_purchase(uuid) to authenticated;
