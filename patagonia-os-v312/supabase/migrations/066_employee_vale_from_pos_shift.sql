-- Fase 2 de "vales y pagos desde Mostrador": vale de adelanto en efectivo
-- a un empleado, cargado directo desde la caja de Mostrador.
--
-- El mecanismo existente (shift_outflows, 008_treasury_and_shifts.sql) que
-- ya descuenta vales del sueldo al cerrar una liquidación está atado a
-- shift_registers (Turnos) con un FK not null -- tocar eso para que además
-- acepte turnos de Mostrador es arriesgado (close_payroll_liquidation ya
-- se corrigió 6 veces por bugs reales de plata). En vez de eso, se crea
-- una tabla paralela pos_shift_outflows con las mismas columnas relevantes,
-- y se amplía close_payroll_liquidation/delete_payroll_liquidation para
-- que sumen y liquiden vales de las DOS tablas -- shift_outflows sigue
-- exactamente igual, sin riesgo de romper nada de lo que ya funciona.
--
-- El vale de mercadería (que además descuenta stock real) es la Fase 3,
-- todavía no implementada -- por eso el check ya incluye 'vale_mercaderia'
-- (para no tener que volver a tocar el constraint), pero por ahora el
-- único type que se puede cargar desde acá es 'vale_adelanto'.
create table if not exists public.pos_shift_outflows (
  id uuid primary key default gen_random_uuid(),
  pos_shift_id uuid not null references public.pos_shifts(id),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  outflow_date date not null,
  account_id uuid references public.treasury_accounts(id),
  type text not null check (type in ('vale_mercaderia','vale_adelanto')),
  amount numeric(14,2) not null check (amount > 0),
  detail text not null,
  employee_id uuid not null references public.employees(id),
  treasury_movement_id uuid references public.treasury_movements(id),
  payroll_liquidation_id uuid references public.payroll_liquidations(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.pos_shift_outflows enable row level security;

create policy "pos_shift_outflows_company_isolation"
on public.pos_shift_outflows for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create or replace function public.register_employee_vale_from_pos_shift(
  p_employee_id uuid,
  p_pos_shift_id uuid,
  p_account_id uuid,
  p_amount numeric,
  p_detail text default null
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
  v_employee_name text;
  v_outflow_id uuid := gen_random_uuid();
  v_movement_id uuid;
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

  select full_name into v_employee_name
  from public.employees
  where id = p_employee_id and company_id = v_company_id;

  if v_employee_name is null then
    raise exception 'Empleado inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, pos_shift_id, notes, created_by
  ) values (
    v_company_id, v_branch_id, p_account_id, 'out', p_amount, 'vale_adelanto',
    'employee', p_employee_id, current_date, p_pos_shift_id,
    coalesce(nullif(trim(p_detail), ''), 'Vale de adelanto · ' || v_employee_name), v_user_id
  )
  returning id into v_movement_id;

  insert into public.pos_shift_outflows (
    id, pos_shift_id, company_id, branch_id, outflow_date, account_id, type, amount, detail, employee_id, treasury_movement_id, created_by
  ) values (
    v_outflow_id, p_pos_shift_id, v_company_id, v_branch_id, current_date, p_account_id, 'vale_adelanto', p_amount,
    coalesce(nullif(trim(p_detail), ''), 'Vale de adelanto'), p_employee_id, v_movement_id, v_user_id
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'pos_shift_outflow.save', 'pos_shift_outflow', v_outflow_id::text,
    jsonb_build_object('employee_id', p_employee_id, 'amount', p_amount, 'pos_shift_id', p_pos_shift_id)
  );

  return jsonb_build_object('id', v_outflow_id);
end;
$$;

revoke all on function public.register_employee_vale_from_pos_shift(uuid,uuid,uuid,numeric,text) from public;
grant execute on function public.register_employee_vale_from_pos_shift(uuid,uuid,uuid,numeric,text) to authenticated;

create or replace function public.delete_pos_shift_outflow(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement_id uuid;
  v_branch_id uuid;
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

  select treasury_movement_id, branch_id into v_movement_id, v_branch_id
  from public.pos_shift_outflows
  where id = p_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Salida inválida';
  end if;

  delete from public.pos_shift_outflows where id = p_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_branch_id, v_user_id, 'pos_shift_outflow.delete', 'pos_shift_outflow', p_id::text
  );

  return jsonb_build_object('id', p_id);
end;
$$;

revoke all on function public.delete_pos_shift_outflow(uuid) from public;
grant execute on function public.delete_pos_shift_outflow(uuid) to authenticated;

-- close_payroll_liquidation: el total de vales ahora suma tanto los de
-- Turnos (shift_outflows) como los de Mostrador (pos_shift_outflows), y
-- marca los dos como liquidados. shift_outflows no se toca en nada.
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

  select coalesce(sum(v.amount), 0) into v_vouchers_total
  from (
    select so.amount
    from public.shift_outflows so
    join public.shift_registers sr on sr.id = so.shift_id
    where so.employee_id = p_employee_id
      and so.type in ('vale_mercaderia', 'vale_adelanto')
      and so.payroll_liquidation_id is null
      and sr.shift_date between p_period_start and p_period_end
    union all
    select pso.amount
    from public.pos_shift_outflows pso
    where pso.employee_id = p_employee_id
      and pso.type in ('vale_mercaderia', 'vale_adelanto')
      and pso.payroll_liquidation_id is null
      and pso.outflow_date between p_period_start and p_period_end
  ) v;

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

  update public.pos_shift_outflows pso
  set payroll_liquidation_id = v_liquidation_id
  where pso.employee_id = p_employee_id
    and pso.type in ('vale_mercaderia', 'vale_adelanto')
    and pso.payroll_liquidation_id is null
    and pso.outflow_date between p_period_start and p_period_end;

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

-- delete_payroll_liquidation: además de "des-liquidar" los shift_outflows
-- de Turnos, ahora también libera los pos_shift_outflows de Mostrador.
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

  update public.pos_shift_outflows
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
