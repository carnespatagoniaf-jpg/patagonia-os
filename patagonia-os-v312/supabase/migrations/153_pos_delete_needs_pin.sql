-- Borrar un movimiento de caja o un vale en Mostrador pide el PIN de
-- autorización (2026-10-23). El dueño borró sin querer dos retiros a caja
-- fuerte (N.º 44 y 45) con un solo toque, y se restauraron a mano. Ahora:
--   - la web pregunta antes de borrar;
--   - si la empresa tiene PIN para anular (company_void_pins, migración 149),
--     delete_pos_shift_adjustment y delete_pos_shift_outflow lo exigen, con el
--     mismo traba de 5 fallos en 15 minutos que anular una venta.
-- Un PIN equivocado devuelve {ok:false} en vez de error, así el fallo queda
-- guardado en pos_void_pin_failures. Sin PIN (una pestaña vieja) da error y no
-- borra nada. Los cuerpos son los de producción, con el control agregado.

drop function if exists public.delete_pos_shift_adjustment(uuid);
drop function if exists public.delete_pos_shift_outflow(uuid);

create or replace function public.delete_pos_shift_adjustment(p_movement_id uuid, p_auth_pin text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_shift_id uuid;
  v_shift_status text;
  v_movement_type text;
  v_deposit_id uuid;
  v_matches boolean;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select profiles.company_id, profiles.role into v_company_id, v_role
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

  if v_movement_type not in ('ajuste', 'transferencia') then
    raise exception 'Ese movimiento no se puede borrar desde acá';
  end if;

  select status into v_shift_status from public.pos_shifts where id = v_shift_id;

  if v_shift_status is distinct from 'open' then
    raise exception 'No se puede borrar: el turno ya está cerrado';
  end if;

  select id into v_deposit_id from public.pos_safe_deposits
  where out_movement_id = p_movement_id and company_id = v_company_id;

  if v_deposit_id is not null and v_role not in ('owner', 'admin') then
    raise exception 'Un retiro a caja fuerte solo lo puede anular el dueño o un administrador';
  end if;

  v_matches := public.pos_void_pin_matches(v_company_id, p_auth_pin);
  if v_matches is not null then
    if p_auth_pin is null then
      raise exception 'Para borrar hace falta el PIN de autorización (si no lo pide, recargá la página con F5)';
    end if;
    if public.pos_void_pin_locked(v_company_id) then
      return jsonb_build_object('ok', false, 'error', 'Demasiados intentos con el PIN equivocado. Esperá 15 minutos.');
    end if;
    if not v_matches then
      insert into public.pos_void_pin_failures (company_id, created_by) values (v_company_id, v_user_id);
      return jsonb_build_object('ok', false, 'error', 'PIN de autorización incorrecto.');
    end if;
  end if;

  if v_deposit_id is not null then
    update public.pos_safe_deposits set voided_at = now(), voided_by = v_user_id where id = v_deposit_id;
  end if;

  delete from public.treasury_movements
  where reference_type = 'pos_shift_transfer' and reference_id = p_movement_id and company_id = v_company_id;

  delete from public.treasury_movements where id = p_movement_id and company_id = v_company_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'treasury_movement.delete', 'treasury_movement', p_movement_id::text,
    jsonb_build_object('with_pin', v_matches is not null, 'safe_deposit_id', v_deposit_id)
  );

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.delete_pos_shift_outflow(p_id uuid, p_auth_pin text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement_id uuid;
  v_branch_id uuid;
  v_matches boolean;
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

  select treasury_movement_id, branch_id into v_movement_id, v_branch_id
  from public.pos_shift_outflows
  where id = p_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Salida inválida';
  end if;

  v_matches := public.pos_void_pin_matches(v_company_id, p_auth_pin);
  if v_matches is not null then
    if p_auth_pin is null then
      raise exception 'Para borrar hace falta el PIN de autorización (si no lo pide, recargá la página con F5)';
    end if;
    if public.pos_void_pin_locked(v_company_id) then
      return jsonb_build_object('ok', false, 'error', 'Demasiados intentos con el PIN equivocado. Esperá 15 minutos.');
    end if;
    if not v_matches then
      insert into public.pos_void_pin_failures (company_id, created_by) values (v_company_id, v_user_id);
      return jsonb_build_object('ok', false, 'error', 'PIN de autorización incorrecto.');
    end if;
  end if;

  delete from public.pos_shift_outflows where id = p_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'pos_shift_outflow.delete', 'pos_shift_outflow', p_id::text,
    jsonb_build_object('with_pin', v_matches is not null)
  );

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

revoke all on function public.delete_pos_shift_adjustment(uuid, text) from public, anon;
grant execute on function public.delete_pos_shift_adjustment(uuid, text) to authenticated;
revoke all on function public.delete_pos_shift_outflow(uuid, text) from public, anon;
grant execute on function public.delete_pos_shift_outflow(uuid, text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('153_pos_delete_needs_pin') on conflict do nothing;
