-- Bug real encontrado probando en vivo (Cecilia, semana 24-30/08): el total
-- de "vales del período" sumaba TODOS los vales pendientes con fecha hasta
-- el fin del período, sin piso -- así que vales sueltos de semanas
-- anteriores que habían quedado sin liquidar (por huecos entre
-- liquidaciones) se colaban en la liquidación de la semana actual e
-- inflaban el descuento. Ahora los vales se acotan por período igual que
-- los premios/descuentos (adjustment_date between p_period_start and
-- p_period_end), tanto al calcular el total como al marcarlos como
-- liquidados. Un vale pendiente de antes del período elegido simplemente
-- no se toca -- sigue "Pendiente" en la pantalla del empleado hasta que se
-- elija un rango que lo cubra.
create or replace function public.close_payroll_liquidation(
  p_branch_id uuid,
  p_employee_id uuid,
  p_period_start date,
  p_period_end date,
  p_payments jsonb default '[]'::jsonb
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
  v_payment jsonb;
  v_payments_total numeric(14,2) := 0;
  v_account_id uuid;
  v_amount numeric(14,2);
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

  if exists (
    select 1 from public.payroll_liquidations
    where employee_id = p_employee_id
      and period_start <= p_period_end
      and period_end >= p_period_start
  ) then
    raise exception 'Ya existe una liquidación que se superpone con ese período';
  end if;

  v_period_days := (p_period_end - p_period_start) + 1;
  v_divisor := case v_salary_period
    when 'daily' then 1
    when 'weekly' then 7
    when 'biweekly' then 14
    else 30
  end;
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
    and sr.shift_date between p_period_start and p_period_end;

  v_net_amount := v_prorated_base + v_adjustments_total - v_vouchers_total;

  if p_payments is null then
    p_payments := '[]'::jsonb;
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments)
  loop
    v_account_id := (v_payment->>'account_id')::uuid;
    v_amount := (v_payment->>'amount')::numeric;

    if not exists (
      select 1 from public.treasury_accounts where id = v_account_id and company_id = v_company_id
    ) then
      raise exception 'Cuenta de tesorería inválida';
    end if;

    if v_amount is null or v_amount <= 0 then
      raise exception 'El monto de cada pago debe ser mayor que cero';
    end if;

    v_payments_total := v_payments_total + v_amount;
  end loop;

  if jsonb_array_length(p_payments) > 0 and v_payments_total <> v_net_amount then
    raise exception 'Los pagos (%) no suman el neto a pagar (%)', v_payments_total, v_net_amount;
  end if;

  if jsonb_array_length(p_payments) > 0 and v_net_amount <= 0 then
    raise exception 'El neto no es positivo, no hay nada que pagar';
  end if;

  insert into public.payroll_liquidations (
    company_id, branch_id, employee_id, period_start, period_end,
    base_salary, adjustments_total, vouchers_total, net_amount,
    created_by
  ) values (
    v_company_id, p_branch_id, p_employee_id, p_period_start, p_period_end,
    v_prorated_base, v_adjustments_total, v_vouchers_total, v_net_amount,
    v_user_id
  )
  returning id into v_liquidation_id;

  for v_payment in select * from jsonb_array_elements(p_payments)
  loop
    v_account_id := (v_payment->>'account_id')::uuid;
    v_amount := (v_payment->>'amount')::numeric;

    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, notes, created_by
    ) values (
      v_company_id, p_branch_id, v_account_id, 'out', v_amount, 'sueldo',
      'payroll_liquidation', v_liquidation_id, p_period_end, 'Liquidación · ' || v_full_name, v_user_id
    )
    returning id into v_movement_id;

    insert into public.payroll_liquidation_payments (liquidation_id, account_id, amount, treasury_movement_id)
    values (v_liquidation_id, v_account_id, v_amount, v_movement_id);
  end loop;

  update public.shift_outflows so
  set payroll_liquidation_id = v_liquidation_id
  from public.shift_registers sr
  where sr.id = so.shift_id
    and so.employee_id = p_employee_id
    and so.type in ('vale_mercaderia', 'vale_adelanto')
    and so.payroll_liquidation_id is null
    and sr.shift_date between p_period_start and p_period_end;

  update public.payroll_adjustments
  set payroll_liquidation_id = v_liquidation_id
  where employee_id = p_employee_id
    and adjustment_date between p_period_start and p_period_end
    and payroll_liquidation_id is null;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'payroll_liquidation.close', 'payroll_liquidation', v_liquidation_id::text,
    jsonb_build_object('employee_id', p_employee_id, 'period_start', p_period_start, 'period_end', p_period_end, 'net_amount', v_net_amount, 'payments', p_payments)
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

revoke all on function public.close_payroll_liquidation(uuid,uuid,date,date,jsonb) from public;
grant execute on function public.close_payroll_liquidation(uuid,uuid,date,date,jsonb) to authenticated;
