-- Pedido del dueño: Facundo cobra un premio fijo de $50.000/semana por
-- redes ademas del sueldo base. Cargarlo a mano en "Premios y descuentos"
-- cada vez que se liquida es tedioso y facil de olvidar. Se agrega un
-- premio recurrente en la ficha del empleado, que se prorratea junto con
-- el sueldo base (mismo criterio que salary_period) en cada liquidacion,
-- sin necesidad de cargarlo de nuevo cada periodo.

alter table public.employees
  add column if not exists recurring_bonus_amount numeric(14,2) not null default 0,
  add column if not exists recurring_bonus_reason text;

create or replace function public.create_employee(
  p_branch_id uuid,
  p_full_name text,
  p_base_salary numeric,
  p_salary_period text default 'monthly',
  p_recurring_bonus_amount numeric default 0,
  p_recurring_bonus_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_employee_id uuid := gen_random_uuid();
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

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'El nombre del empleado es obligatorio';
  end if;

  if p_base_salary is null or p_base_salary < 0 then
    raise exception 'El sueldo no puede ser negativo';
  end if;

  if p_salary_period not in ('weekly', 'monthly') then
    raise exception 'Período de sueldo inválido';
  end if;

  if p_recurring_bonus_amount is null or p_recurring_bonus_amount < 0 then
    raise exception 'El premio fijo no puede ser negativo';
  end if;

  if p_recurring_bonus_amount > 0 and (p_recurring_bonus_reason is null or length(trim(p_recurring_bonus_reason)) = 0) then
    raise exception 'El premio fijo necesita un motivo';
  end if;

  insert into public.employees (
    id, company_id, branch_id, full_name, base_salary, salary_period,
    recurring_bonus_amount, recurring_bonus_reason
  )
  values (
    v_employee_id, v_company_id, p_branch_id, trim(p_full_name), p_base_salary, p_salary_period,
    p_recurring_bonus_amount, nullif(trim(coalesce(p_recurring_bonus_reason, '')), '')
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'employee.create', 'employee', v_employee_id::text,
    jsonb_build_object(
      'full_name', p_full_name, 'base_salary', p_base_salary, 'salary_period', p_salary_period,
      'recurring_bonus_amount', p_recurring_bonus_amount, 'recurring_bonus_reason', p_recurring_bonus_reason
    )
  );

  return jsonb_build_object('id', v_employee_id, 'full_name', trim(p_full_name));
end;
$$;

revoke all on function public.create_employee(uuid,text,numeric,text,numeric,text) from public;
grant execute on function public.create_employee(uuid,text,numeric,text,numeric,text) to authenticated;

drop function if exists public.create_employee(uuid,text,numeric,text);

create or replace function public.update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_base_salary numeric,
  p_active boolean,
  p_salary_period text default 'monthly',
  p_recurring_bonus_amount numeric default 0,
  p_recurring_bonus_reason text default null
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

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'El nombre del empleado es obligatorio';
  end if;

  if p_base_salary is null or p_base_salary < 0 then
    raise exception 'El sueldo no puede ser negativo';
  end if;

  if p_salary_period not in ('weekly', 'monthly') then
    raise exception 'Período de sueldo inválido';
  end if;

  if p_recurring_bonus_amount is null or p_recurring_bonus_amount < 0 then
    raise exception 'El premio fijo no puede ser negativo';
  end if;

  if p_recurring_bonus_amount > 0 and (p_recurring_bonus_reason is null or length(trim(p_recurring_bonus_reason)) = 0) then
    raise exception 'El premio fijo necesita un motivo';
  end if;

  select branch_id into v_branch_id
  from public.employees
  where id = p_employee_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Empleado inválido';
  end if;

  update public.employees
  set full_name = trim(p_full_name), base_salary = p_base_salary, active = p_active, salary_period = p_salary_period,
      recurring_bonus_amount = p_recurring_bonus_amount,
      recurring_bonus_reason = nullif(trim(coalesce(p_recurring_bonus_reason, '')), '')
  where id = p_employee_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'employee.update', 'employee', p_employee_id::text,
    jsonb_build_object(
      'full_name', p_full_name, 'base_salary', p_base_salary, 'active', p_active, 'salary_period', p_salary_period,
      'recurring_bonus_amount', p_recurring_bonus_amount, 'recurring_bonus_reason', p_recurring_bonus_reason
    )
  );

  return jsonb_build_object('id', p_employee_id);
end;
$$;

revoke all on function public.update_employee(uuid,text,numeric,boolean,text,numeric,text) from public;
grant execute on function public.update_employee(uuid,text,numeric,boolean,text,numeric,text) to authenticated;

drop function if exists public.update_employee(uuid,text,numeric,boolean,text);

-- close_payroll_liquidation: prorratea sueldo base + premio fijo juntos.

create or replace function public.close_payroll_liquidation(
  p_branch_id uuid,
  p_employee_id uuid,
  p_period_start date,
  p_period_end date,
  p_account_id uuid
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

  if not exists (
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

  if v_net_amount > 0 then
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
