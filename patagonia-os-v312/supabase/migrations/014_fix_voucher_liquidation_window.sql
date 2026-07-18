-- Los vales de mercadería/adelanto deben descontarse en la próxima liquidación
-- que los alcance, sin importar la fecha de inicio elegida para el período —
-- antes quedaban afuera para siempre si el vale era anterior al "periodStart"
-- del rango tipeado (ej: vale del 3/7 con liquidación "Semana" = últimos 7 días).
create or replace function public.close_payroll_liquidation(
  p_branch_id uuid,
  p_employee_id uuid,
  p_period_start date,
  p_period_end date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_base_salary numeric(14,2);
  v_adjustments_total numeric(14,2);
  v_vouchers_total numeric(14,2);
  v_net_amount numeric(14,2);
  v_liquidation_id uuid;
  v_vouchers_since date;
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

  select base_salary into v_base_salary
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

  select coalesce(sum(amount) filter (where type = 'bonus'), 0)
       - coalesce(sum(amount) filter (where type = 'deduction'), 0)
  into v_adjustments_total
  from public.payroll_adjustments
  where employee_id = p_employee_id
    and adjustment_date between p_period_start and p_period_end;

  select max(period_end) into v_vouchers_since
  from public.payroll_liquidations
  where employee_id = p_employee_id;

  select coalesce(sum(so.amount), 0) into v_vouchers_total
  from public.shift_outflows so
  join public.shift_registers sr on sr.id = so.shift_id
  where so.employee_id = p_employee_id
    and so.type in ('vale_mercaderia', 'vale_adelanto')
    and sr.shift_date <= p_period_end
    and (v_vouchers_since is null or sr.shift_date > v_vouchers_since);

  v_net_amount := v_base_salary + v_adjustments_total - v_vouchers_total;

  insert into public.payroll_liquidations (
    company_id, branch_id, employee_id, period_start, period_end,
    base_salary, adjustments_total, vouchers_total, net_amount, created_by
  ) values (
    v_company_id, p_branch_id, p_employee_id, p_period_start, p_period_end,
    v_base_salary, v_adjustments_total, v_vouchers_total, v_net_amount, v_user_id
  )
  returning id into v_liquidation_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'payroll_liquidation.close', 'payroll_liquidation', v_liquidation_id::text,
    jsonb_build_object('employee_id', p_employee_id, 'period_start', p_period_start, 'period_end', p_period_end, 'net_amount', v_net_amount)
  );

  return jsonb_build_object(
    'id', v_liquidation_id,
    'base_salary', v_base_salary,
    'adjustments_total', v_adjustments_total,
    'vouchers_total', v_vouchers_total,
    'net_amount', v_net_amount
  );
end;
$$;

revoke all on function public.close_payroll_liquidation(uuid,uuid,date,date) from public;
grant execute on function public.close_payroll_liquidation(uuid,uuid,date,date) to authenticated;
