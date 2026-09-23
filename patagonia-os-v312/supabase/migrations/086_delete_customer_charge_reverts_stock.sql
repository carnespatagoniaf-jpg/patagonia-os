-- Bug real encontrado en auditoría (2026-09-23): create_customer_charge_with_items
-- (060_customer_charge_items.sql) descuenta stock real cuando se carga una
-- entrega a un cliente de cuenta corriente con productos reales -- pero
-- delete_customer_charge (048_customers.sql, escrita ANTES de que existiera
-- esa función) solo borraba la fila de customer_charges. El delete
-- cascadeaba customer_charge_items (FK on delete cascade), pero el
-- movimiento en inventory_movements no tiene FK a customer_charges -- queda
-- huérfano, y el stock nunca vuelve. Resultado: borrar una entrega cargada
-- por error deja el stock descontado para siempre, sin ningún aviso.
--
-- Mismo patrón que void_purchase (053_void_purchase.sql): antes de borrar,
-- se revierte cada movimiento real que esa entrega haya generado con uno
-- inverso -- no se toca lo que ya se escribió, solo se compensa.
create or replace function public.delete_customer_charge(p_charge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement record;
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
    select 1 from public.customer_charges where id = p_charge_id and company_id = v_company_id
  ) then
    raise exception 'Cargo inválido';
  end if;

  for v_movement in
    select branch_id, product_id, quantity
    from public.inventory_movements
    where reference_type = 'customer_charge' and reference_id = p_charge_id and company_id = v_company_id
  loop
    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by
    ) values (
      v_company_id, v_movement.branch_id, v_movement.product_id, 'customer_charge_void', -v_movement.quantity,
      'customer_charge_void', p_charge_id, 'Se borró la entrega a cliente', v_user_id
    );
  end loop;

  delete from public.customer_charges where id = p_charge_id and company_id = v_company_id;

  return jsonb_build_object('id', p_charge_id);
end;
$$;

revoke all on function public.delete_customer_charge(uuid) from public;
grant execute on function public.delete_customer_charge(uuid) to authenticated;
