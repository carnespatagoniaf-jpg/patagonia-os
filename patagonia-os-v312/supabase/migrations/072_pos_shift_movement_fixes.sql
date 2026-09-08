-- Dos huecos reales encontrados antes de que el dueño probara esto con
-- plata de verdad:
--
-- 1) No había forma de borrar un "Movimiento de caja" (Ingreso/Egreso,
--    adjust_treasury_account, 010_treasury_adjustments.sql) ni un "Vale a
--    empleado" (pos_shift_outflows, 066) mal cargado -- el segundo ya
--    tenía el RPC de borrado armado pero sin ningún botón que lo llame.
--
-- 2) La plata que se retira a la caja fuerte (transfer_treasury_funds,
--    010_treasury_adjustments.sql, usable solo desde Tesorería) no queda
--    ligada al turno de Mostrador -- el cierre de caja no la resta del
--    efectivo esperado, así que da una "diferencia" que en realidad es
--    plata que se sacó a propósito. Se agrega un traspaso pensado para
--    usarse DESDE Mostrador: solo la pata que sale de la cuenta de este
--    turno queda marcada con pos_shift_id (así el arqueo la resta), la
--    pata que entra a la cuenta destino (ej. Caja fuerte) NO queda
--    marcada -- si quedara marcada también, al ser las dos "efectivo" se
--    cancelarían entre sí y el arqueo no reflejaría la salida real de la
--    caja física.

create or replace function public.delete_pos_shift_adjustment(p_movement_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_shift_id uuid;
  v_shift_status text;
  v_movement_type text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select profiles.company_id into v_company_id
  from public.profiles
  where profiles.id = v_user_id and profiles.active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select
    coalesce(case when tm.reference_type = 'pos_shift' then tm.reference_id end, tm.pos_shift_id),
    tm.movement_type
  into v_shift_id, v_movement_type
  from public.treasury_movements tm
  where tm.id = p_movement_id and tm.company_id = v_company_id
  for update;

  if v_shift_id is null then
    raise exception 'Movimiento inválido';
  end if;

  -- Solo "Movimiento de caja" y traspasos hechos desde acá -- pagos a
  -- proveedores tienen su propio borrado (delete_supplier_payment, desde
  -- Compras) que además limpia la fila de supplier_payments vinculada;
  -- borrarlos por acá la dejaría huérfana.
  if v_movement_type not in ('ajuste', 'transferencia') then
    raise exception 'Ese movimiento no se puede borrar desde acá';
  end if;

  select status into v_shift_status from public.pos_shifts where id = v_shift_id;

  if v_shift_status is distinct from 'open' then
    raise exception 'No se puede borrar: el turno ya está cerrado';
  end if;

  -- Si es la pata de salida de un traspaso, se borra también la pata de
  -- entrada vinculada (si no, queda plata fantasma en la cuenta destino).
  delete from public.treasury_movements
  where reference_type = 'pos_shift_transfer' and reference_id = p_movement_id and company_id = v_company_id;

  delete from public.treasury_movements where id = p_movement_id and company_id = v_company_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'treasury_movement.delete', 'treasury_movement', p_movement_id::text
  );
end;
$$;

revoke all on function public.delete_pos_shift_adjustment(uuid) from public;
grant execute on function public.delete_pos_shift_adjustment(uuid) to authenticated;

create or replace function public.register_pos_shift_transfer(
  p_pos_shift_id uuid,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount numeric,
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
  v_branch_id uuid;
  v_out_id uuid;
  v_in_id uuid;
  v_reason text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select profiles.company_id into v_company_id
  from public.profiles
  where profiles.id = v_user_id and profiles.active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select branch_id into v_branch_id
  from public.pos_shifts
  where id = p_pos_shift_id and company_id = v_company_id and status = 'open';

  if v_branch_id is null then
    raise exception 'No hay un turno de mostrador abierto';
  end if;

  if p_from_account_id = p_to_account_id then
    raise exception 'Elegí dos cuentas distintas';
  end if;

  if not exists (select 1 from public.treasury_accounts where id = p_from_account_id and company_id = v_company_id) then
    raise exception 'Cuenta de origen inválida';
  end if;

  if not exists (select 1 from public.treasury_accounts where id = p_to_account_id and company_id = v_company_id) then
    raise exception 'Cuenta de destino inválida';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  v_reason := coalesce(nullif(trim(p_reason), ''), 'Traspaso desde Mostrador');

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, pos_shift_id, notes, created_by
  ) values (
    v_company_id, v_branch_id, p_from_account_id, 'out', p_amount, 'transferencia',
    'pos_shift', p_pos_shift_id, current_date, p_pos_shift_id, v_reason, v_user_id
  )
  returning id into v_out_id;

  -- La pata de entrada NO se marca con pos_shift_id a propósito -- ver
  -- comentario arriba del archivo.
  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by
  ) values (
    v_company_id, v_branch_id, p_to_account_id, 'in', p_amount, 'transferencia',
    'pos_shift_transfer', v_out_id, current_date, v_reason, v_user_id
  )
  returning id into v_in_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'treasury_movement.transfer', 'treasury_movement', v_out_id::text,
    jsonb_build_object('from_account_id', p_from_account_id, 'to_account_id', p_to_account_id, 'amount', p_amount, 'pos_shift_id', p_pos_shift_id)
  );

  return jsonb_build_object('out_id', v_out_id, 'in_id', v_in_id);
end;
$$;

revoke all on function public.register_pos_shift_transfer(uuid,uuid,uuid,numeric,text) from public;
grant execute on function public.register_pos_shift_transfer(uuid,uuid,uuid,numeric,text) to authenticated;
