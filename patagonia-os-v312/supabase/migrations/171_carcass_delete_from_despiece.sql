-- 171: Despiece — "Quitar" una media res que vino de una compra la borra de todos lados (2026-10-29).
--
-- Pedido del dueño (cliente Carnicería Cocuzza): "la gente se tiene que poder manejar sola y borrar, y que se borre de
-- todos lados". Hasta ahora, una res que vino de Compras (126) no se podía quitar en Despiece: decía "anulá la compra en
-- Compras" y la persona quedaba trabada.
--
-- Ahora, en una res de una compra:
--   * si la compra trae SOLO esa res, se anula la compra (void_purchase, lo mismo que el botón de Compras): la deuda con el
--     proveedor deja de contar y el trigger purchases_carcass_sync (126) borra la res, sus cortes y el stock de los cortes;
--   * si la compra trae otros productos, NO se anula sola (se perderían esos productos): se avisa con la fecha y el
--     proveedor para anularla en Compras;
--   * si la compra ya estaba anulada y la res quedó, se borra la res.
-- Una res cargada a mano se borra como siempre.

create or replace function public.delete_carcass_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_batch public.carcass_batches%rowtype;
  v_purchase public.purchases%rowtype;
  v_items int;
  v_supplier text;
  v_purchase_id uuid;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select * into v_batch from public.carcass_batches where id = p_batch_id and company_id = v_company_id;
  if not found then
    return jsonb_build_object('ok', true);
  end if;

  if v_batch.purchase_item_id is not null then
    select p.* into v_purchase
    from public.purchases p
    join public.purchase_items pi on pi.purchase_id = p.id
    where pi.id = v_batch.purchase_item_id and p.company_id = v_company_id;

    if found and v_purchase.status = 'active' then
      select count(*) into v_items from public.purchase_items where purchase_id = v_purchase.id;
      if v_items > 1 then
        select name into v_supplier from public.suppliers where id = v_purchase.supplier_id;
        raise exception 'Esta res vino en la compra del % a % junto con otros productos: para quitarla, anulá esa compra en Compras (se anula entera).',
          to_char(v_purchase.purchase_date, 'DD/MM/YYYY'), coalesce(v_supplier, 'el proveedor');
      end if;
      -- Lo mismo que "Anular" en Compras: revierte la compra y el trigger 126 borra la res, sus cortes y su stock.
      perform public.void_purchase(v_purchase.id);
      if exists (select 1 from public.carcass_batches where id = p_batch_id) then
        perform public.carcass_delete_cuts_core(p_batch_id, false);
        delete from public.carcass_batches where id = p_batch_id;
      end if;
      insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
      values (v_company_id, v_batch.branch_id, v_user_id, 'carcass.delete', 'carcass_batch', p_batch_id::text,
              jsonb_build_object('animal_type', v_batch.animal_type, 'total_cost', v_batch.total_cost, 'voided_purchase', v_purchase.id));
      return jsonb_build_object('ok', true, 'voided_purchase', v_purchase.id);
    end if;

    -- Compra ya anulada (o sin compra): solo queda la res.
    perform public.carcass_delete_cuts_core(p_batch_id, false);
    delete from public.carcass_batches where id = p_batch_id;
    insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
    values (v_company_id, v_batch.branch_id, v_user_id, 'carcass.delete', 'carcass_batch', p_batch_id::text,
            jsonb_build_object('animal_type', v_batch.animal_type, 'total_cost', v_batch.total_cost));
    return jsonb_build_object('ok', true);
  end if;

  -- Res cargada a mano: como antes.
  v_purchase_id := v_batch.purchase_id;

  update public.carcass_cuts cc
  set inventory_movement_id = null
  where cc.batch_id = p_batch_id and cc.inventory_movement_id is not null;

  delete from public.inventory_movements im
  where im.reference_type = 'carcass_cut'
    and im.reference_id in (select id from public.carcass_cuts where batch_id = p_batch_id);

  delete from public.carcass_batches where id = p_batch_id and company_id = v_company_id;

  if v_purchase_id is not null then
    delete from public.purchase_items where purchase_id = v_purchase_id;
    delete from public.purchases where id = v_purchase_id;
  end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_batch.branch_id, v_user_id, 'carcass.delete', 'carcass_batch', p_batch_id::text,
          jsonb_build_object('animal_type', v_batch.animal_type, 'total_cost', v_batch.total_cost));
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_carcass_batch(uuid) from public, anon;
grant execute on function public.delete_carcass_batch(uuid) to authenticated;

insert into public.schema_migrations (version) values ('171_carcass_delete_from_despiece') on conflict do nothing;
