-- Cierra dos gaps reales de Tesorería, ambos confirmados con el dueño de
-- Carnes Patagonia:
--
-- 1) close_payroll_liquidation calculaba bien el neto a pagar (sueldo +
--    premios - descuentos - vales) pero nunca lo restaba de ninguna cuenta
--    de tesorería. El pago real de un sueldo es plata que sale de la caja,
--    pero el sistema nunca se enteraba -> Tesorería quedaba mostrando más
--    plata de la que realmente había, cada vez que se liquidaba un sueldo.
--
-- 2) base_salary es un solo número sin indicar si es semanal o mensual, así
--    que liquidar por semana con un sueldo cargado como mensual (o
--    viceversa) cobraba el período completo sin prorratear. Se agrega
--    employees.salary_period ('weekly'|'monthly') y se prorratea el sueldo
--    según la cantidad de días del período elegido.

alter table public.employees
  add column if not exists salary_period text not null default 'monthly'
    check (salary_period in ('weekly', 'monthly'));

alter table public.payroll_liquidations
  add column if not exists account_id uuid references public.treasury_accounts(id),
  add column if not exists treasury_movement_id uuid references public.treasury_movements(id);

-- 1) create_employee / update_employee: suman salary_period

create or replace function public.create_employee(
  p_branch_id uuid,
  p_full_name text,
  p_base_salary numeric,
  p_salary_period text default 'monthly'
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

  insert into public.employees (id, company_id, branch_id, full_name, base_salary, salary_period)
  values (v_employee_id, v_company_id, p_branch_id, trim(p_full_name), p_base_salary, p_salary_period);

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'employee.create', 'employee', v_employee_id::text,
    jsonb_build_object('full_name', p_full_name, 'base_salary', p_base_salary, 'salary_period', p_salary_period)
  );

  return jsonb_build_object('id', v_employee_id, 'full_name', trim(p_full_name));
end;
$$;

revoke all on function public.create_employee(uuid,text,numeric,text) from public;
grant execute on function public.create_employee(uuid,text,numeric,text) to authenticated;

drop function if exists public.create_employee(uuid,text,numeric);

create or replace function public.update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_base_salary numeric,
  p_active boolean,
  p_salary_period text default 'monthly'
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

  select branch_id into v_branch_id
  from public.employees
  where id = p_employee_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Empleado inválido';
  end if;

  update public.employees
  set full_name = trim(p_full_name), base_salary = p_base_salary, active = p_active, salary_period = p_salary_period
  where id = p_employee_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'employee.update', 'employee', p_employee_id::text,
    jsonb_build_object('full_name', p_full_name, 'base_salary', p_base_salary, 'active', p_active, 'salary_period', p_salary_period)
  );

  return jsonb_build_object('id', p_employee_id);
end;
$$;

revoke all on function public.update_employee(uuid,text,numeric,boolean,text) from public;
grant execute on function public.update_employee(uuid,text,numeric,boolean,text) to authenticated;

drop function if exists public.update_employee(uuid,text,numeric,boolean);

-- 2) close_payroll_liquidation: prorratea por salary_period y genera el
--    movimiento de tesorería (si hay algo neto para pagar).

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

  select full_name, base_salary, salary_period into v_full_name, v_base_salary, v_salary_period
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
  v_prorated_base := round(v_base_salary * v_period_days / v_divisor, 2);

  select coalesce(sum(amount) filter (where type = 'bonus'), 0)
       - coalesce(sum(amount) filter (where type = 'deduction'), 0)
  into v_adjustments_total
  from public.payroll_adjustments
  where employee_id = p_employee_id
    and adjustment_date between p_period_start and p_period_end;

  -- Mismo criterio que 015_link_vouchers_to_liquidation: un vale queda
  -- "pendiente" hasta que una liquidación lo cubre explícitamente (por
  -- payroll_liquidation_id, no por rango de fechas), así ningún vale se
  -- pierde ni se descuenta dos veces.
  select coalesce(sum(so.amount), 0) into v_vouchers_total
  from public.shift_outflows so
  join public.shift_registers sr on sr.id = so.shift_id
  where so.employee_id = p_employee_id
    and so.type in ('vale_mercaderia', 'vale_adelanto')
    and so.payroll_liquidation_id is null
    and sr.shift_date <= p_period_end;

  v_net_amount := v_prorated_base + v_adjustments_total - v_vouchers_total;

  -- Si los vales ya cubrieron (o superaron) lo que corresponde este
  -- período, no queda nada para pagar: se registra la liquidación igual
  -- (para no perder el cálculo) pero sin movimiento de caja.
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

revoke all on function public.close_payroll_liquidation(uuid,uuid,date,date,uuid) from public;
grant execute on function public.close_payroll_liquidation(uuid,uuid,date,date,uuid) to authenticated;

drop function if exists public.close_payroll_liquidation(uuid,uuid,date,date);

create or replace function public.delete_payroll_liquidation(p_liquidation_id uuid)
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
  from public.payroll_liquidations
  where id = p_liquidation_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Liquidación inválida';
  end if;

  -- Los vales que esta liquidación había cubierto vuelven a quedar
  -- "pendientes" para que se puedan re-liquidar más adelante.
  update public.shift_outflows
  set payroll_liquidation_id = null
  where payroll_liquidation_id = p_liquidation_id;

  delete from public.payroll_liquidations where id = p_liquidation_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'payroll_liquidation.delete', 'payroll_liquidation', p_liquidation_id::text
  );

  return jsonb_build_object('id', p_liquidation_id);
end;
$$;

revoke all on function public.delete_payroll_liquidation(uuid) from public;
grant execute on function public.delete_payroll_liquidation(uuid) to authenticated;
