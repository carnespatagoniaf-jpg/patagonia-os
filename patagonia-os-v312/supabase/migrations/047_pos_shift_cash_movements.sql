-- Los "Movimiento de caja" (Ingreso/Egreso) que se hacen desde Mostrador
-- mientras hay un turno abierto quedaban sueltos: no se enlazaban a ese
-- pos_shift, asi que el arqueo de 046 no los tenia en cuenta -- si durante
-- el turno se metia o sacaba efectivo de la caja aparte de las ventas, el
-- "Efectivo esperado" del cierre quedaba mal. Ahora adjust_treasury_account
-- acepta un pos_shift opcional, y close_pos_shift lo suma/resta.
create or replace function public.adjust_treasury_account(
  p_account_id uuid,
  p_branch_id uuid,
  p_amount numeric,
  p_direction text,
  p_reason text,
  p_pos_shift_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement_id uuid;
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
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_direction not in ('in','out') then
    raise exception 'Dirección inválida';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo es obligatorio';
  end if;

  if p_pos_shift_id is not null and not exists (
    select 1 from public.pos_shifts where id = p_pos_shift_id and company_id = v_company_id and status = 'open'
  ) then
    raise exception 'Turno de mostrador inválido';
  end if;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by
  ) values (
    v_company_id, p_branch_id, p_account_id, p_direction, p_amount, 'ajuste',
    case when p_pos_shift_id is not null then 'pos_shift' else null end, p_pos_shift_id,
    current_date, trim(p_reason), v_user_id
  )
  returning id into v_movement_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'treasury_account.adjust', 'treasury_movement', v_movement_id::text,
    jsonb_build_object('account_id', p_account_id, 'amount', p_amount, 'direction', p_direction, 'reason', p_reason, 'pos_shift_id', p_pos_shift_id)
  );

  select balance into v_balance from public.treasury_balance where account_id = p_account_id;

  return jsonb_build_object('id', v_movement_id, 'balance', v_balance);
end;
$$;

revoke all on function public.adjust_treasury_account(uuid,uuid,numeric,text,text,uuid) from public;
grant execute on function public.adjust_treasury_account(uuid,uuid,numeric,text,text,uuid) to authenticated;

drop function if exists public.adjust_treasury_account(uuid,uuid,numeric,text,text);

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
  where tm.reference_type = 'pos_shift' and tm.reference_id = p_pos_shift_id
    and tm.movement_type = 'ajuste' and ta.payment_method = 'cash';

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
