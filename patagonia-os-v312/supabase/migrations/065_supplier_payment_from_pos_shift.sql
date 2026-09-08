-- Fase 1 de "vales y pagos desde Mostrador": poder pagarle a un proveedor
-- directo desde la caja de Mostrador (antes solo se podía desde Compras).
-- register_supplier_payment (028_fix_treasury_linkage.sql) ya existe y
-- funciona bien para Compras -- no se toca. Acá se agrega una versión
-- paralela que además liga el movimiento al turno de mostrador, para que
-- el arqueo de caja de close_pos_shift (047_pos_shift_cash_movements.sql)
-- lo tenga en cuenta como salida de efectivo real.
--
-- treasury_movements.reference_type/reference_id ya se usa para decir "a
-- quién" corresponde el movimiento (acá 'supplier_payment', igual que la
-- versión de Compras) -- por eso se agrega una columna aparte,
-- pos_shift_id (mismo patrón que la columna shift_id ya existente para
-- Turnos), en vez de pisar reference_type con 'pos_shift'.
alter table public.treasury_movements
  add column if not exists pos_shift_id uuid references public.pos_shifts(id);

create or replace function public.register_supplier_payment_from_pos_shift(
  p_supplier_id uuid,
  p_pos_shift_id uuid,
  p_account_id uuid,
  p_amount numeric,
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
  v_branch_id uuid;
  v_payment_id uuid := gen_random_uuid();
  v_movement_id uuid;
  v_payment_method text;
  v_balance numeric(14,2);
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
    reference_type, reference_id, occurred_on, pos_shift_id, notes, created_by
  ) values (
    v_company_id, v_branch_id, p_account_id, 'out', p_amount, 'pago_proveedor',
    'supplier_payment', v_payment_id, current_date, p_pos_shift_id, coalesce(p_notes, 'Pago a proveedor desde Mostrador'), v_user_id
  )
  returning id into v_movement_id;

  insert into public.supplier_payments (
    id, company_id, branch_id, supplier_id, payment_date, amount, payment_method,
    account_id, treasury_movement_id, notes, created_by
  ) values (
    v_payment_id, v_company_id, v_branch_id, p_supplier_id, current_date, p_amount, coalesce(v_payment_method, 'cash'),
    p_account_id, v_movement_id, p_notes, v_user_id
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'supplier_payment.create', 'supplier_payment', v_payment_id::text,
    jsonb_build_object('amount', p_amount, 'account_id', p_account_id, 'supplier_id', p_supplier_id, 'pos_shift_id', p_pos_shift_id)
  );

  select balance into v_balance from public.supplier_balance where supplier_id = p_supplier_id;

  return jsonb_build_object('id', v_payment_id, 'balance', v_balance);
end;
$$;

revoke all on function public.register_supplier_payment_from_pos_shift(uuid,uuid,uuid,numeric,text) from public;
grant execute on function public.register_supplier_payment_from_pos_shift(uuid,uuid,uuid,numeric,text) to authenticated;

-- close_pos_shift: el arqueo de efectivo esperado ahora también resta los
-- pagos a proveedores en efectivo hechos desde este turno (además de los
-- "Movimiento de caja" -- ajuste -- que ya contaba). Se identifican por la
-- nueva columna pos_shift_id en vez de reference_type, para no chocar con
-- el uso existente de reference_type='supplier_payment'.
create or replace function public.close_pos_shift(p_pos_shift_id uuid, p_closing_counted_cash numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_shift public.pos_shifts%rowtype;
  v_account record;
  v_summary jsonb := '[]'::jsonb;
  v_total numeric(14,2) := 0;
  v_cash_sales numeric(14,2) := 0;
  v_cash_movements numeric(14,2) := 0;
  v_expected_cash numeric(14,2);
  v_difference numeric(14,2);
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

  select * into v_shift
  from public.pos_shifts
  where id = p_pos_shift_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Turno inválido';
  end if;

  if v_shift.status <> 'open' then
    raise exception 'El turno ya está cerrado';
  end if;

  for v_account in
    select psp.account_id, sum(psp.amount) as amount, count(distinct psp.sale_id) as sales_count
    from public.pos_sale_payments psp
    join public.pos_sales ps on ps.id = psp.sale_id
    where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null
    group by psp.account_id
  loop
    if v_account.amount > 0 then
      insert into public.treasury_movements (
        company_id, branch_id, account_id, direction, amount, movement_type,
        reference_type, reference_id, occurred_on, notes, created_by
      ) values (
        v_company_id, v_shift.branch_id, v_account.account_id, 'in', v_account.amount, 'venta',
        'pos_shift', p_pos_shift_id, current_date, 'Cierre de turno de mostrador', v_user_id
      );
    end if;
    v_total := v_total + v_account.amount;
    v_summary := v_summary || jsonb_build_object(
      'account_id', v_account.account_id,
      'amount', v_account.amount,
      'sales_count', v_account.sales_count
    );
  end loop;

  select coalesce(sum(psp.amount), 0) into v_cash_sales
  from public.pos_sale_payments psp
  join public.pos_sales ps on ps.id = psp.sale_id
  join public.treasury_accounts ta on ta.id = psp.account_id
  where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null and ta.payment_method = 'cash';

  select coalesce(sum(case when tm.direction = 'in' then tm.amount else -tm.amount end), 0) into v_cash_movements
  from public.treasury_movements tm
  join public.treasury_accounts ta on ta.id = tm.account_id
  where ta.payment_method = 'cash'
    and (
      (tm.reference_type = 'pos_shift' and tm.reference_id = p_pos_shift_id and tm.movement_type = 'ajuste')
      or tm.pos_shift_id = p_pos_shift_id
    );

  v_expected_cash := coalesce(v_shift.opening_cash, 0) + v_cash_sales + v_cash_movements;
  v_difference := case when p_closing_counted_cash is null then null else p_closing_counted_cash - v_expected_cash end;

  update public.pos_shifts
  set status = 'closed', closed_at = now(), closed_by = v_user_id, closing_counted_cash = p_closing_counted_cash
  where id = p_pos_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_shift.branch_id, v_user_id, 'pos_shift.close', 'pos_shift', p_pos_shift_id::text,
    jsonb_build_object(
      'total', v_total, 'by_account', v_summary, 'opening_cash', v_shift.opening_cash,
      'cash_movements', v_cash_movements, 'expected_cash', v_expected_cash,
      'counted_cash', p_closing_counted_cash, 'difference', v_difference
    )
  );

  return jsonb_build_object(
    'total', v_total, 'by_account', v_summary,
    'expected_cash', v_expected_cash, 'counted_cash', p_closing_counted_cash, 'difference', v_difference
  );
end;
$$;

revoke all on function public.close_pos_shift(uuid, numeric) from public;
grant execute on function public.close_pos_shift(uuid, numeric) to authenticated;
