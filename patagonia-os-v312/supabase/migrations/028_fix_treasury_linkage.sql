-- Corrige dos bugs reales de tesorería, confirmados contra datos reales:
--
-- 1) create_creditor_debt (cargar una deuda en Deudas, ej. "me prestan
--    plata") nunca escribía en treasury_movements: recibir un préstamo no
--    sumaba nada a ninguna cuenta. Ahora admite una cuenta OPCIONAL — una
--    deuda puede ser plata que entró (préstamo) o una deuda pura sin
--    movimiento de caja (ej. alquiler adeudado), así que no es obligatoria.
--
-- 2) register_supplier_payment buscaba la cuenta por payment_method (texto)
--    y si no encontraba una cuenta con ese medio de pago exacto, salteaba
--    la escritura del movimiento SIN avisar (bug ya documentado en el
--    comentario de 021_creditors.sql, nunca corregido acá). Pasa a recibir
--    account_id directo, igual que register_creditor_payment.
--
-- De paso, se agrega edición/borrado de pagos y deudas (hasta ahora solo
-- los ítems de compra eran editables) manteniendo el treasury_movement
-- vinculado sincronizado, mismo patrón que save_shift_outflow.

alter table public.supplier_payments
  add column if not exists account_id uuid references public.treasury_accounts(id),
  add column if not exists treasury_movement_id uuid references public.treasury_movements(id),
  alter column payment_method drop not null;

alter table public.creditor_debts
  add column if not exists account_id uuid references public.treasury_accounts(id),
  add column if not exists treasury_movement_id uuid references public.treasury_movements(id);

-- 1) register_supplier_payment: account_id en vez de payment_method

create or replace function public.register_supplier_payment(
  p_supplier_id uuid,
  p_branch_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_account_id uuid,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_payment_id uuid := gen_random_uuid();
  v_movement_id uuid;
  v_payment_method text;
  v_balance numeric(14,2);
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
    select 1 from public.suppliers
    where id = p_supplier_id and company_id = v_company_id
  ) then
    raise exception 'Proveedor inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  select payment_method into v_payment_method
  from public.treasury_accounts
  where id = p_account_id and company_id = v_company_id;

  if not found then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by
  ) values (
    v_company_id, p_branch_id, p_account_id, 'out', p_amount, 'pago_proveedor',
    'supplier_payment', v_payment_id, p_payment_date, coalesce(p_notes, 'Pago a proveedor'), v_user_id
  )
  returning id into v_movement_id;

  insert into public.supplier_payments (
    id, company_id, branch_id, supplier_id, payment_date, amount, payment_method,
    account_id, treasury_movement_id, notes, created_by
  ) values (
    v_payment_id, v_company_id, p_branch_id, p_supplier_id, p_payment_date, p_amount, coalesce(v_payment_method, 'cash'),
    p_account_id, v_movement_id, p_notes, v_user_id
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'supplier_payment.create', 'supplier_payment', v_payment_id::text,
    jsonb_build_object('amount', p_amount, 'account_id', p_account_id, 'supplier_id', p_supplier_id)
  );

  select balance into v_balance from public.supplier_balance where supplier_id = p_supplier_id;

  return jsonb_build_object('id', v_payment_id, 'balance', v_balance);
end;
$$;

revoke all on function public.register_supplier_payment(uuid,uuid,date,numeric,uuid,text) from public;
grant execute on function public.register_supplier_payment(uuid,uuid,date,numeric,uuid,text) to authenticated;

-- Elimina la firma vieja (p_payment_method text) para que no quede
-- ambigüedad de sobrecarga en PostgREST.
drop function if exists public.register_supplier_payment(uuid,uuid,date,numeric,text,text);

create or replace function public.update_supplier_payment(
  p_payment_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_account_id uuid,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_supplier_id uuid;
  v_movement_id uuid;
  v_payment_method text;
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

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  select payment_method into v_payment_method
  from public.treasury_accounts
  where id = p_account_id and company_id = v_company_id;

  if not found then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  select supplier_id, treasury_movement_id into v_supplier_id, v_movement_id
  from public.supplier_payments
  where id = p_payment_id and company_id = v_company_id
  for update;

  if v_supplier_id is null then
    raise exception 'Pago inválido';
  end if;

  update public.supplier_payments
  set payment_date = p_payment_date, amount = p_amount, account_id = p_account_id,
      payment_method = coalesce(v_payment_method, 'cash'), notes = p_notes
  where id = p_payment_id;

  if v_movement_id is not null then
    update public.treasury_movements
    set amount = p_amount, account_id = p_account_id, occurred_on = p_payment_date,
        notes = coalesce(p_notes, 'Pago a proveedor')
    where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'supplier_payment.update', 'supplier_payment', p_payment_id::text,
    jsonb_build_object('amount', p_amount, 'account_id', p_account_id)
  );

  return jsonb_build_object('id', p_payment_id);
end;
$$;

revoke all on function public.update_supplier_payment(uuid,date,numeric,uuid,text) from public;
grant execute on function public.update_supplier_payment(uuid,date,numeric,uuid,text) to authenticated;

create or replace function public.delete_supplier_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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

  select treasury_movement_id into v_movement_id
  from public.supplier_payments
  where id = p_payment_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Pago inválido';
  end if;

  delete from public.supplier_payments where id = p_payment_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'supplier_payment.delete', 'supplier_payment', p_payment_id::text
  );

  return jsonb_build_object('id', p_payment_id);
end;
$$;

revoke all on function public.delete_supplier_payment(uuid) from public;
grant execute on function public.delete_supplier_payment(uuid) to authenticated;

-- 2) create_creditor_debt: cuenta opcional, edición y borrado

create or replace function public.create_creditor_debt(
  p_creditor_id uuid,
  p_debt_date date,
  p_amount numeric,
  p_reason text,
  p_account_id uuid default null
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
  v_id uuid := gen_random_uuid();
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

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo es obligatorio';
  end if;

  select branch_id into v_branch_id
  from public.creditors
  where id = p_creditor_id and company_id = v_company_id;

  if v_branch_id is null then
    raise exception 'Acreedor inválido';
  end if;

  if p_account_id is not null then
    if not exists (
      select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
    ) then
      raise exception 'Cuenta de tesorería inválida';
    end if;

    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, notes, created_by
    ) values (
      v_company_id, v_branch_id, p_account_id, 'in', p_amount, 'creditor_debt',
      'creditor', p_creditor_id, p_debt_date, trim(p_reason), v_user_id
    )
    returning id into v_movement_id;
  end if;

  insert into public.creditor_debts (
    id, company_id, creditor_id, debt_date, amount, reason, account_id, treasury_movement_id, created_by
  ) values (
    v_id, v_company_id, p_creditor_id, p_debt_date, p_amount, trim(p_reason), p_account_id, v_movement_id, v_user_id
  );

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_creditor_debt(uuid,date,numeric,text,uuid) from public;
grant execute on function public.create_creditor_debt(uuid,date,numeric,text,uuid) to authenticated;

drop function if exists public.create_creditor_debt(uuid,date,numeric,text);

create or replace function public.update_creditor_debt(
  p_debt_id uuid,
  p_debt_date date,
  p_amount numeric,
  p_reason text,
  p_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_creditor_id uuid;
  v_branch_id uuid;
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

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo es obligatorio';
  end if;

  if p_account_id is not null and not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  select d.creditor_id, d.treasury_movement_id, c.branch_id
  into v_creditor_id, v_movement_id, v_branch_id
  from public.creditor_debts d
  join public.creditors c on c.id = d.creditor_id
  where d.id = p_debt_id and d.company_id = v_company_id
  for update of d;

  if v_creditor_id is null then
    raise exception 'Deuda inválida';
  end if;

  if v_movement_id is not null and p_account_id is null then
    -- Se sacó la cuenta: la deuda deja de representar un ingreso de caja.
    delete from public.treasury_movements where id = v_movement_id;
    v_movement_id := null;
  elsif v_movement_id is not null and p_account_id is not null then
    update public.treasury_movements
    set amount = p_amount, account_id = p_account_id, occurred_on = p_debt_date, notes = trim(p_reason)
    where id = v_movement_id;
  elsif v_movement_id is null and p_account_id is not null then
    -- No tenía cuenta y ahora se le asigna una.
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, notes, created_by
    ) values (
      v_company_id, v_branch_id, p_account_id, 'in', p_amount, 'creditor_debt',
      'creditor', v_creditor_id, p_debt_date, trim(p_reason), v_user_id
    )
    returning id into v_movement_id;
  end if;

  update public.creditor_debts
  set debt_date = p_debt_date, amount = p_amount, reason = trim(p_reason),
      account_id = p_account_id, treasury_movement_id = v_movement_id
  where id = p_debt_id;

  return jsonb_build_object('id', p_debt_id);
end;
$$;

revoke all on function public.update_creditor_debt(uuid,date,numeric,text,uuid) from public;
grant execute on function public.update_creditor_debt(uuid,date,numeric,text,uuid) to authenticated;

create or replace function public.delete_creditor_debt(p_debt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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

  select treasury_movement_id into v_movement_id
  from public.creditor_debts
  where id = p_debt_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Deuda inválida';
  end if;

  delete from public.creditor_debts where id = p_debt_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  return jsonb_build_object('id', p_debt_id);
end;
$$;

revoke all on function public.delete_creditor_debt(uuid) from public;
grant execute on function public.delete_creditor_debt(uuid) to authenticated;

-- 3) edición/borrado de pagos a acreedores (register_creditor_payment ya
--    exige cuenta siempre, así que acá no hay caso "sin movimiento")

create or replace function public.update_creditor_payment(
  p_payment_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_account_id uuid,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_creditor_id uuid;
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

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  select creditor_id, treasury_movement_id into v_creditor_id, v_movement_id
  from public.creditor_payments
  where id = p_payment_id and company_id = v_company_id
  for update;

  if v_creditor_id is null then
    raise exception 'Pago inválido';
  end if;

  update public.creditor_payments
  set payment_date = p_payment_date, amount = p_amount, account_id = p_account_id, notes = p_notes
  where id = p_payment_id;

  if v_movement_id is not null then
    update public.treasury_movements
    set amount = p_amount, account_id = p_account_id, occurred_on = p_payment_date,
        notes = coalesce(p_notes, 'Pago a acreedor')
    where id = v_movement_id;
  end if;

  return jsonb_build_object('id', p_payment_id);
end;
$$;

revoke all on function public.update_creditor_payment(uuid,date,numeric,uuid,text) from public;
grant execute on function public.update_creditor_payment(uuid,date,numeric,uuid,text) to authenticated;

create or replace function public.delete_creditor_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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

  select treasury_movement_id into v_movement_id
  from public.creditor_payments
  where id = p_payment_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Pago inválido';
  end if;

  delete from public.creditor_payments where id = p_payment_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  return jsonb_build_object('id', p_payment_id);
end;
$$;

revoke all on function public.delete_creditor_payment(uuid) from public;
grant execute on function public.delete_creditor_payment(uuid) to authenticated;
