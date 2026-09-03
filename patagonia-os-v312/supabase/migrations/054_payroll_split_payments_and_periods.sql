-- Rediseño de liquidación de sueldos, pedido del dueño:
-- 1) Pago dividido entre varias cuentas de tesorería en una misma
--    liquidación (mismo patrón que pos_sale_payments en Mostrador) --
--    hoy solo se podía elegir una sola cuenta (o ninguna).
-- 2) Dos períodos de sueldo nuevos: "daily" (por día, se multiplica
--    directo por los días del rango, sin prorrateo raro) y "biweekly"
--    (quincena real, divisor 14) -- antes solo existían 'weekly' y
--    'monthly', y "Quincena" en la pantalla era solo un atajo de fechas
--    que igual prorrateaba como semanal o mensual.
-- 3) payroll_adjustments.payroll_liquidation_id (mismo patrón que ya
--    existe en shift_outflows) para poder reimprimir el detalle exacto
--    (cada premio/descuento con su fecha) de una liquidación ya cerrada,
--    en vez de sólo el total.

create table if not exists public.payroll_liquidation_payments (
  id uuid primary key default gen_random_uuid(),
  liquidation_id uuid not null references public.payroll_liquidations(id) on delete cascade,
  account_id uuid not null references public.treasury_accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  treasury_movement_id uuid references public.treasury_movements(id)
);

alter table public.payroll_liquidation_payments enable row level security;

create policy "payroll_liquidation_payments_company_isolation"
on public.payroll_liquidation_payments for select
using (
  exists (
    select 1 from public.payroll_liquidations pl
    where pl.id = payroll_liquidation_payments.liquidation_id and pl.company_id = public.current_company_id()
  )
);

alter table public.payroll_adjustments
  add column if not exists payroll_liquidation_id uuid references public.payroll_liquidations(id);

alter table public.employees drop constraint if exists employees_salary_period_check;
alter table public.employees
  add constraint employees_salary_period_check check (salary_period in ('daily', 'weekly', 'biweekly', 'monthly'));

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

  if p_salary_period not in ('daily', 'weekly', 'biweekly', 'monthly') then
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

  if p_salary_period not in ('daily', 'weekly', 'biweekly', 'monthly') then
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

-- p_account_id (una sola cuenta) se reemplaza por p_payments: array
-- jsonb de {account_id, amount}, igual que create_pos_sale con sus
-- items. Array vacío = "sin cuenta, ya se pagó por afuera del sistema"
-- (mismo comportamiento que antes con p_account_id null). Si hay
-- pagos, tienen que sumar exacto el neto.
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
    and sr.shift_date <= p_period_end;

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
    and sr.shift_date <= p_period_end;

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

drop function if exists public.close_payroll_liquidation(uuid,uuid,date,date,uuid);

create or replace function public.delete_payroll_liquidation(p_liquidation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_legacy_movement_id uuid;
  v_movement_ids uuid[];
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

  select treasury_movement_id into v_legacy_movement_id
  from public.payroll_liquidations
  where id = p_liquidation_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Liquidación inválida';
  end if;

  select array_agg(treasury_movement_id) into v_movement_ids
  from public.payroll_liquidation_payments
  where liquidation_id = p_liquidation_id and treasury_movement_id is not null;

  -- Los vales y ajustes que esta liquidación había cubierto vuelven a
  -- quedar "pendientes" para que se puedan re-liquidar más adelante.
  update public.shift_outflows
  set payroll_liquidation_id = null
  where payroll_liquidation_id = p_liquidation_id;

  update public.payroll_adjustments
  set payroll_liquidation_id = null
  where payroll_liquidation_id = p_liquidation_id;

  -- payroll_liquidation_payments se borra solo por el "on delete cascade";
  -- hay que borrar primero (así deja de referenciar los treasury_movements)
  -- para poder borrar esos movimientos después sin violar la FK.
  delete from public.payroll_liquidations where id = p_liquidation_id;

  if v_movement_ids is not null then
    delete from public.treasury_movements where id = any(v_movement_ids);
  end if;

  if v_legacy_movement_id is not null then
    delete from public.treasury_movements where id = v_legacy_movement_id;
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
