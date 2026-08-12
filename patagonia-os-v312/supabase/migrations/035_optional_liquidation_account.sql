-- Catch-up real: varios empleados nunca habian sido liquidados en el
-- sistema, asi que el primer cierre de cada uno cubre semanas atras. En
-- algunos casos el neto da positivo (mas vales bajos que sueldo del
-- periodo) porque el dueño ya les pago ese sueldo por afuera del sistema
-- (efectivo/transferencia sin cargar) -- cerrar la liquidacion ahi no
-- deberia generar un movimiento de Tesoreria (esa plata no sale "hoy",
-- ya salio antes sin registrar). p_account_id pasa a ser opcional, mismo
-- criterio que ya usa create_creditor_debt para deudas sin movimiento de
-- caja: sin cuenta, se registra la liquidacion igual pero no se toca
-- ninguna cuenta.

create or replace function public.close_payroll_liquidation(
  p_branch_id uuid,
  p_employee_id uuid,
  p_period_start date,
  p_period_end date,
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
  v_full_name text;
  v_base_salary numeric(14,2);
  v_recurring_bonus_amount numeric(14,2);
  v_salary_period text;
  v_period_days int;
  v_divisor int;
  v_prorated_base numeric(14,2);
  v_adjustments_total numeric(14,2);
  v_vouchers_total numeric(14,2);
  v_net_amount numeric(14,2);
  v_liquidation_id uuid;
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

  if p_period_end < p_period_start then
    raise exception 'El rango de fechas es inválido';
  end if;

  select full_name, base_salary, coalesce(recurring_bonus_amount, 0), salary_period
  into v_full_name, v_base_salary, v_recurring_bonus_amount, v_salary_period
  from public.employees
  where id = p_employee_id and company_id = v_company_id
  for update;

  if v_base_salary is null then
    raise exception 'Empleado inválido';
  end if;

  if p_account_id is not null and not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if exists (
    select 1 from public.payroll_liquidations
    where employee_id = p_employee_id
      and period_start <= p_period_end
      and period_end >= p_period_start
  ) then
    raise exception 'Ya existe una liquidación que se superpone con ese período';
  end if;

  v_period_days := (p_period_end - p_period_start) + 1;
  v_divisor := case when v_salary_period = 'weekly' then 7 else 30 end;
  v_prorated_base := round((v_base_salary + v_recurring_bonus_amount) * v_period_days / v_divisor, 2);

  select coalesce(sum(amount) filter (where type = 'bonus'), 0)
       - coalesce(sum(amount) filter (where type = 'deduction'), 0)
  into v_adjustments_total
  from public.payroll_adjustments
  where employee_id = p_employee_id
    and adjustment_date between p_period_start and p_period_end;

  select coalesce(sum(so.amount), 0) into v_vouchers_total
  from public.shift_outflows so
  join public.shift_registers sr on sr.id = so.shift_id
  where so.employee_id = p_employee_id
    and so.type in ('vale_mercaderia', 'vale_adelanto')
    and so.payroll_liquidation_id is null
    and sr.shift_date <= p_period_end;

  v_net_amount := v_prorated_base + v_adjustments_total - v_vouchers_total;

  -- Sin cuenta elegida, no se genera movimiento de caja aunque el neto de
  -- positivo (se asume que ya se pago por afuera del sistema).
  if v_net_amount > 0 and p_account_id is not null then
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, notes, created_by
    ) values (
      v_company_id, p_branch_id, p_account_id, 'out', v_net_amount, 'sueldo',
      'payroll_liquidation', null, p_period_end, 'Liquidación · ' || v_full_name, v_user_id
    )
    returning id into v_movement_id;
  end if;

  insert into public.payroll_liquidations (
    company_id, branch_id, employee_id, period_start, period_end,
    base_salary, adjustments_total, vouchers_total, net_amount,
    account_id, treasury_movement_id, created_by
  ) values (
    v_company_id, p_branch_id, p_employee_id, p_period_start, p_period_end,
    v_prorated_base, v_adjustments_total, v_vouchers_total, v_net_amount,
    p_account_id, v_movement_id, v_user_id
  )
  returning id into v_liquidation_id;

  update public.shift_outflows so
  set payroll_liquidation_id = v_liquidation_id
  from public.shift_registers sr
  where sr.id = so.shift_id
    and so.employee_id = p_employee_id
    and so.type in ('vale_mercaderia', 'vale_adelanto')
    and so.payroll_liquidation_id is null
    and sr.shift_date <= p_period_end;

  if v_movement_id is not null then
    update public.treasury_movements set reference_id = v_liquidation_id where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'payroll_liquidation.close', 'payroll_liquidation', v_liquidation_id::text,
    jsonb_build_object('employee_id', p_employee_id, 'period_start', p_period_start, 'period_end', p_period_end, 'net_amount', v_net_amount, 'account_id', p_account_id)
  );

  return jsonb_build_object(
    'id', v_liquidation_id,
    'base_salary', v_prorated_base,
    'adjustments_total', v_adjustments_total,
    'vouchers_total', v_vouchers_total,
    'net_amount', v_net_amount
  );
end;
$$;
