-- Módulo de Rentabilidad: costos fijos mensuales configurables, y cierres de
-- período (semana/mes) que calculan la ganancia real:
-- Ventas − (Stock inicial + Compras − Stock final) − Costos fijos.
-- El ranking "qué se compró más" sale directo de purchase_items (ya cargado en
-- Compras) — no hace falta una carga manual aparte.

create table if not exists public.fixed_costs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  name text not null,
  monthly_amount numeric(14,2) not null check (monthly_amount >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.profitability_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  sales_total numeric(14,2) not null,
  purchases_total numeric(14,2) not null,
  fixed_costs_total numeric(14,2) not null,
  stock_start numeric(14,2) not null default 0,
  stock_end numeric(14,2) not null default 0,
  gross_profit numeric(14,2) not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.fixed_costs enable row level security;
alter table public.profitability_periods enable row level security;

create policy "fixed_costs_company_isolation"
on public.fixed_costs for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "profitability_periods_company_read"
on public.profitability_periods for select
using (company_id = public.current_company_id());

create or replace function public.create_fixed_cost(
  p_branch_id uuid,
  p_name text,
  p_monthly_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid := gen_random_uuid();
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if p_monthly_amount is null or p_monthly_amount < 0 then
    raise exception 'El monto no puede ser negativo';
  end if;

  insert into public.fixed_costs (id, company_id, branch_id, name, monthly_amount)
  values (v_id, v_company_id, p_branch_id, trim(p_name), p_monthly_amount);

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_fixed_cost(uuid,text,numeric) from public;
grant execute on function public.create_fixed_cost(uuid,text,numeric) to authenticated;

create or replace function public.update_fixed_cost(
  p_fixed_cost_id uuid,
  p_name text,
  p_monthly_amount numeric,
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if p_monthly_amount is null or p_monthly_amount < 0 then
    raise exception 'El monto no puede ser negativo';
  end if;

  update public.fixed_costs
  set name = trim(p_name), monthly_amount = p_monthly_amount, active = p_active
  where id = p_fixed_cost_id and company_id = v_company_id;

  if not found then
    raise exception 'Costo fijo inválido';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.update_fixed_cost(uuid,text,numeric,boolean) from public;
grant execute on function public.update_fixed_cost(uuid,text,numeric,boolean) to authenticated;

create or replace function public.close_profitability_period(
  p_branch_id uuid,
  p_period_start date,
  p_period_end date,
  p_stock_start numeric,
  p_stock_end numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sales_total numeric(14,2);
  v_purchases_total numeric(14,2);
  v_fixed_costs_monthly numeric(14,2);
  v_fixed_costs_total numeric(14,2);
  v_days integer;
  v_gross_profit numeric(14,2);
  v_period_id uuid;
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

  if not exists (
    select 1 from public.branches where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if exists (
    select 1 from public.profitability_periods
    where branch_id = p_branch_id
      and period_start <= p_period_end
      and period_end >= p_period_start
  ) then
    raise exception 'Ya existe un cierre que se superpone con ese período';
  end if;

  select coalesce(sum(ss.amount), 0) into v_sales_total
  from public.shift_sales ss
  join public.shift_registers sr on sr.id = ss.shift_id
  where sr.branch_id = p_branch_id and sr.company_id = v_company_id
    and sr.shift_date between p_period_start and p_period_end;

  select coalesce(sum(total), 0) into v_purchases_total
  from public.purchases
  where branch_id = p_branch_id and company_id = v_company_id and status = 'active'
    and purchase_date between p_period_start and p_period_end;

  select coalesce(sum(monthly_amount), 0) into v_fixed_costs_monthly
  from public.fixed_costs
  where branch_id = p_branch_id and company_id = v_company_id and active = true;

  v_days := (p_period_end - p_period_start) + 1;
  v_fixed_costs_total := round(v_fixed_costs_monthly / 30.0 * v_days, 2);

  v_gross_profit := v_sales_total - (coalesce(p_stock_start, 0) + v_purchases_total - coalesce(p_stock_end, 0)) - v_fixed_costs_total;

  insert into public.profitability_periods (
    company_id, branch_id, period_start, period_end,
    sales_total, purchases_total, fixed_costs_total, stock_start, stock_end, gross_profit, created_by
  ) values (
    v_company_id, p_branch_id, p_period_start, p_period_end,
    v_sales_total, v_purchases_total, v_fixed_costs_total, coalesce(p_stock_start, 0), coalesce(p_stock_end, 0), v_gross_profit, v_user_id
  )
  returning id into v_period_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'profitability_period.close', 'profitability_period', v_period_id::text,
    jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'gross_profit', v_gross_profit)
  );

  return jsonb_build_object(
    'id', v_period_id,
    'sales_total', v_sales_total,
    'purchases_total', v_purchases_total,
    'fixed_costs_total', v_fixed_costs_total,
    'stock_start', coalesce(p_stock_start, 0),
    'stock_end', coalesce(p_stock_end, 0),
    'gross_profit', v_gross_profit
  );
end;
$$;

revoke all on function public.close_profitability_period(uuid,date,date,numeric,numeric) from public;
grant execute on function public.close_profitability_period(uuid,date,date,numeric,numeric) to authenticated;
