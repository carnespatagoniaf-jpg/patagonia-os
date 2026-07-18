create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  full_name text not null,
  base_salary numeric(14,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  employee_id uuid not null references public.employees(id),
  adjustment_date date not null,
  type text not null check (type in ('bonus','deduction')),
  amount numeric(14,2) not null check (amount > 0),
  reason text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.payroll_liquidations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  employee_id uuid not null references public.employees(id),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  base_salary numeric(14,2) not null,
  adjustments_total numeric(14,2) not null,
  vouchers_total numeric(14,2) not null,
  net_amount numeric(14,2) not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'shift_outflows_employee_id_fkey'
  ) then
    alter table public.shift_outflows
      add constraint shift_outflows_employee_id_fkey
      foreign key (employee_id) references public.employees(id);
  end if;
end $$;

alter table public.employees enable row level security;
alter table public.payroll_adjustments enable row level security;
alter table public.payroll_liquidations enable row level security;

create policy "employees_company_isolation"
on public.employees for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "payroll_adjustments_company_isolation"
on public.payroll_adjustments for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "payroll_liquidations_company_read"
on public.payroll_liquidations for select
using (company_id = public.current_company_id());

create or replace function public.create_employee(
  p_branch_id uuid,
  p_full_name text,
  p_base_salary numeric
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

  insert into public.employees (id, company_id, branch_id, full_name, base_salary)
  values (v_employee_id, v_company_id, p_branch_id, trim(p_full_name), p_base_salary);

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'employee.create', 'employee', v_employee_id::text,
    jsonb_build_object('full_name', p_full_name, 'base_salary', p_base_salary)
  );

  return jsonb_build_object('id', v_employee_id, 'full_name', trim(p_full_name));
end;
$$;

revoke all on function public.create_employee(uuid,text,numeric) from public;
grant execute on function public.create_employee(uuid,text,numeric) to authenticated;

create or replace function public.update_employee(
  p_employee_id uuid,
  p_full_name text,
  p_base_salary numeric,
  p_active boolean
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

  select branch_id into v_branch_id
  from public.employees
  where id = p_employee_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Empleado inválido';
  end if;

  update public.employees
  set full_name = trim(p_full_name), base_salary = p_base_salary, active = p_active
  where id = p_employee_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'employee.update', 'employee', p_employee_id::text,
    jsonb_build_object('full_name', p_full_name, 'base_salary', p_base_salary, 'active', p_active)
  );

  return jsonb_build_object('id', p_employee_id);
end;
$$;

revoke all on function public.update_employee(uuid,text,numeric,boolean) from public;
grant execute on function public.update_employee(uuid,text,numeric,boolean) to authenticated;

create or replace function public.create_payroll_adjustment(
  p_employee_id uuid,
  p_adjustment_date date,
  p_type text,
  p_amount numeric,
  p_reason text
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
  v_adjustment_id uuid := gen_random_uuid();
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

  if p_type not in ('bonus','deduction') then
    raise exception 'Tipo de ajuste inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo es obligatorio';
  end if;

  select branch_id into v_branch_id
  from public.employees
  where id = p_employee_id and company_id = v_company_id;

  if v_branch_id is null then
    raise exception 'Empleado inválido';
  end if;

  insert into public.payroll_adjustments (
    id, company_id, employee_id, adjustment_date, type, amount, reason, created_by
  ) values (
    v_adjustment_id, v_company_id, p_employee_id, p_adjustment_date, p_type, p_amount, trim(p_reason), v_user_id
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'payroll_adjustment.create', 'payroll_adjustment', v_adjustment_id::text,
    jsonb_build_object('employee_id', p_employee_id, 'type', p_type, 'amount', p_amount, 'reason', p_reason)
  );

  return jsonb_build_object('id', v_adjustment_id);
end;
$$;

revoke all on function public.create_payroll_adjustment(uuid,date,text,numeric,text) from public;
grant execute on function public.create_payroll_adjustment(uuid,date,text,numeric,text) to authenticated;

create or replace function public.delete_payroll_adjustment(
  p_adjustment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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

  delete from public.payroll_adjustments
  where id = p_adjustment_id and company_id = v_company_id;

  if not found then
    raise exception 'Ajuste inválido';
  end if;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'payroll_adjustment.delete', 'payroll_adjustment', p_adjustment_id::text
  );

  return jsonb_build_object('id', p_adjustment_id);
end;
$$;

revoke all on function public.delete_payroll_adjustment(uuid) from public;
grant execute on function public.delete_payroll_adjustment(uuid) to authenticated;

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

  select coalesce(sum(so.amount), 0) into v_vouchers_total
  from public.shift_outflows so
  join public.shift_registers sr on sr.id = so.shift_id
  where so.employee_id = p_employee_id
    and so.type in ('vale_mercaderia', 'vale_adelanto')
    and sr.shift_date between p_period_start and p_period_end;

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
