-- Reportes nuevos (ranking/cajeros/horarios de la 144 y resultado/merma de la 145)
-- para TODOS los planes (2026-10-22, decisión del dueño: "cargale a todos los
-- clientes esta opción"). Las mismas funciones, sin el require_plan('full') del
-- principio. Resultado y merma siguen siendo solo para dueño/admin.

create or replace function public.sales_activity_report(p_branch_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
  v_cashiers jsonb;
  v_hours jsonb;
begin
  select pr.company_id, pr.role into v_company_id, v_role
  from public.profiles pr
  where pr.id = auth.uid() and pr.active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin', 'manager', 'readonly') then
    raise exception 'No autorizado para ver reportes';
  end if;

  if p_branch_id is null or not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.company_id = v_company_id
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Período inválido';
  end if;

  if p_to - p_from > interval '400 days' then
    raise exception 'Elegí un período de hasta un año';
  end if;

  with sales as (
    select
      s.id,
      s.total,
      s.created_at,
      s.voided_at,
      coalesce(s.discount_amount, 0)
        + coalesce((select sum(coalesce(i.discount_amount, 0)) from public.pos_sale_items i where i.sale_id = s.id), 0) as discount,
      coalesce(e.full_name, pc.full_name, 'Sin nombre') as cashier_name,
      (sh.cashier_employee_id is not null) as with_pin
    from public.pos_sales s
    left join public.pos_shifts sh on sh.id = s.pos_shift_id
    left join public.employees e on e.id = sh.cashier_employee_id
    left join public.profiles pc on pc.id = s.created_by
    where s.company_id = v_company_id
      and s.branch_id = p_branch_id
      and s.created_at >= p_from
      and s.created_at <= p_to
  ),
  by_cashier as (
    select
      cashier_name,
      bool_or(with_pin) as with_pin,
      count(*) filter (where voided_at is null) as sales,
      coalesce(sum(total) filter (where voided_at is null), 0) as total,
      count(*) filter (where voided_at is not null) as voided_count,
      coalesce(sum(total) filter (where voided_at is not null), 0) as voided_amount,
      coalesce(sum(discount) filter (where voided_at is null), 0) as discount
    from sales
    group by cashier_name
  ),
  closes as (
    select
      coalesce(e.full_name, po.full_name, 'Sin nombre') as cashier_name,
      (a.new_data ->> 'difference')::numeric as difference
    from public.pos_shifts sh
    left join public.employees e on e.id = sh.cashier_employee_id
    left join public.profiles po on po.id = sh.opened_by
    left join lateral (
      select al.new_data from public.audit_log al
      where al.company_id = v_company_id and al.action = 'pos_shift.close' and al.entity_id = sh.id::text
      order by al.created_at desc limit 1
    ) a on true
    where v_role in ('owner', 'admin')
      and sh.company_id = v_company_id
      and sh.branch_id = p_branch_id
      and sh.status = 'closed'
      and sh.closed_at >= p_from
      and sh.closed_at <= p_to
  ),
  by_close as (
    select
      cashier_name,
      count(*) as shifts,
      count(difference) as counted_shifts,
      coalesce(sum(difference), 0) as cash_difference,
      -- Menos de $1 es redondeo de centavos, no faltante.
      count(*) filter (where difference <= -1) as short_shifts
    from closes
    group by cashier_name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'cashier_name', coalesce(c.cashier_name, k.cashier_name),
      'with_pin', coalesce(c.with_pin, false),
      'sales', coalesce(c.sales, 0),
      'total', coalesce(c.total, 0),
      'voided_count', coalesce(c.voided_count, 0),
      'voided_amount', coalesce(c.voided_amount, 0),
      'discount', coalesce(c.discount, 0),
      'shifts', case when v_role in ('owner', 'admin') then coalesce(k.shifts, 0) end,
      'counted_shifts', case when v_role in ('owner', 'admin') then coalesce(k.counted_shifts, 0) end,
      'cash_difference', case when v_role in ('owner', 'admin') then coalesce(k.cash_difference, 0) end,
      'short_shifts', case when v_role in ('owner', 'admin') then coalesce(k.short_shifts, 0) end
    ) order by coalesce(c.total, 0) desc), '[]'::jsonb)
  into v_cashiers
  from by_cashier c
  full join by_close k on k.cashier_name = c.cashier_name;

  select coalesce(jsonb_agg(jsonb_build_object('dow', h.dow, 'hour', h.hour, 'sales', h.sales, 'total', h.total) order by h.dow, h.hour), '[]'::jsonb)
  into v_hours
  from (
    select
      extract(isodow from s.created_at at time zone 'America/Argentina/Buenos_Aires')::int as dow,
      extract(hour from s.created_at at time zone 'America/Argentina/Buenos_Aires')::int as hour,
      count(*) as sales,
      sum(s.total) as total
    from public.pos_sales s
    where s.company_id = v_company_id
      and s.branch_id = p_branch_id
      and s.voided_at is null
      and s.created_at >= p_from
      and s.created_at <= p_to
    group by 1, 2
  ) h;

  return jsonb_build_object('cashiers', v_cashiers, 'hours', v_hours);
end;
$$;

revoke all on function public.sales_activity_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_activity_report(uuid, timestamptz, timestamptz) to authenticated;

create or replace function public.period_result_report(p_branch_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
  v_sales jsonb;
  v_expenses jsonb;
  v_adjustments jsonb;
  v_carcass jsonb;
  v_ar constant text := 'America/Argentina/Buenos_Aires';
begin
  select pr.company_id, pr.role into v_company_id, v_role
  from public.profiles pr
  where pr.id = auth.uid() and pr.active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador';
  end if;

  if p_branch_id is null or not exists (
    select 1 from public.branches b where b.id = p_branch_id and b.company_id = v_company_id
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Período inválido';
  end if;

  if p_to - p_from > 400 then
    raise exception 'Elegí un período de hasta un año';
  end if;

  select jsonb_build_object(
    'mostrador_total', coalesce((
      select sum(s.total) from public.pos_sales s
      where s.company_id = v_company_id and s.branch_id = p_branch_id and s.voided_at is null
        and (s.created_at at time zone v_ar)::date between p_from and p_to), 0),
    'mostrador_sales', coalesce((
      select count(*) from public.pos_sales s
      where s.company_id = v_company_id and s.branch_id = p_branch_id and s.voided_at is null
        and (s.created_at at time zone v_ar)::date between p_from and p_to), 0),
    'lines', (
      select jsonb_build_object(
        'identified_amount', coalesce(sum(l.amount) filter (where l.product_id is not null), 0),
        'identified_cost', coalesce(sum(l.cost) filter (where l.product_id is not null), 0),
        'unidentified_amount', coalesce(sum(l.amount) filter (where l.product_id is null), 0),
        'missing_cost_amount', coalesce(sum(l.amount) filter (where l.product_id is not null and l.cost <= 0), 0)
      )
      from (
        select i.product_id,
          coalesce(i.line_total, i.quantity * i.unit_price - coalesce(i.discount_amount, 0)) as amount,
          case when i.product_id is null then 0 else i.quantity * coalesce(i.unit_cost, p.cost, 0) end as cost
        from public.pos_sale_items i
        join public.pos_sales s on s.id = i.sale_id
        left join public.products p on p.id = i.product_id
        where s.company_id = v_company_id and s.branch_id = p_branch_id and s.voided_at is null
          and (s.created_at at time zone v_ar)::date between p_from and p_to
      ) l
    ),
    'account_total', coalesce((
      select sum(cc.amount) from public.customer_charges cc
      join public.customers c on c.id = cc.customer_id
      where cc.company_id = v_company_id and c.branch_id = p_branch_id
        and cc.charge_date between p_from and p_to), 0),
    'account_items_cost', coalesce((
      select sum(-m.quantity * coalesce(p.cost, 0)) from public.inventory_movements m
      join public.customer_charges cc on cc.id = m.reference_id
      join public.customers c on c.id = cc.customer_id
      join public.products p on p.id = m.product_id
      where m.company_id = v_company_id and m.branch_id = p_branch_id
        and m.reference_type in ('customer_charge', 'customer_charge_void')
        and cc.charge_date between p_from and p_to), 0),
    'account_without_items', coalesce((
      select sum(cc.amount) from public.customer_charges cc
      join public.customers c on c.id = cc.customer_id
      where cc.company_id = v_company_id and c.branch_id = p_branch_id
        and cc.charge_date between p_from and p_to
        and not exists (select 1 from public.inventory_movements m where m.reference_id = cc.id and m.reference_type = 'customer_charge')), 0),
    'turnos_total', coalesce((
      select sum(ss.amount) from public.shift_sales ss
      join public.shift_registers sr on sr.id = ss.shift_id
      where sr.company_id = v_company_id and sr.branch_id = p_branch_id
        and sr.shift_date between p_from and p_to), 0)
  ) into v_sales;

  select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'category', x.category, 'amount', x.amount, 'count', x.n) order by x.amount desc), '[]'::jsonb)
  into v_expenses
  from (
    select
      case when t.movement_type = 'gasto' then 'gasto' else 'sueldos' end as kind,
      case when t.movement_type = 'gasto' then coalesce(nullif(t.category, ''), 'otro') else t.movement_type end as category,
      sum(t.amount) as amount,
      count(*) as n
    from public.treasury_movements t
    where t.company_id = v_company_id and t.branch_id = p_branch_id
      and t.direction = 'out'
      and t.movement_type in ('gasto', 'sueldo', 'vale_adelanto', 'vale_mercaderia')
      and t.occurred_on between p_from and p_to
    group by 1, 2
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', a.product_id, 'product_name', a.name, 'product_code', a.code, 'unit', a.unit,
      'lost_qty', a.lost_qty, 'lost_value', a.lost_value, 'found_qty', a.found_qty, 'found_value', a.found_value,
      'count', a.n, 'reasons', a.reasons
    ) order by a.lost_value desc, a.found_value desc), '[]'::jsonb)
  into v_adjustments
  from (
    select m.product_id, p.name, p.code, p.unit,
      coalesce(sum(-m.quantity) filter (where m.quantity < 0), 0) as lost_qty,
      coalesce(sum(-m.quantity * coalesce(p.cost, 0)) filter (where m.quantity < 0), 0) as lost_value,
      coalesce(sum(m.quantity) filter (where m.quantity > 0), 0) as found_qty,
      coalesce(sum(m.quantity * coalesce(p.cost, 0)) filter (where m.quantity > 0), 0) as found_value,
      count(*) as n,
      (array_agg(distinct left(m.reason, 80)) filter (where nullif(trim(m.reason), '') is not null))[1:3] as reasons
    from public.inventory_movements m
    join public.products p on p.id = m.product_id
    where m.company_id = v_company_id and m.branch_id = p_branch_id
      and m.movement_type = 'adjustment'
      and coalesce(m.reference_type, '') <> 'stock_source_link'
      and (m.created_at at time zone v_ar)::date between p_from and p_to
    group by 1, 2, 3, 4
  ) a;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'date', b.batch_date, 'animal_type', b.animal_type, 'supplier', sp.name,
      'total_weight', b.total_weight, 'total_cost', b.total_cost,
      'cuts_weight', coalesce(c.w, 0), 'cuts', coalesce(c.n, 0)
    ) order by b.batch_date desc, b.created_at desc), '[]'::jsonb)
  into v_carcass
  from public.carcass_batches b
  left join public.suppliers sp on sp.id = b.supplier_id
  left join lateral (select sum(cu.weight) w, count(*) n from public.carcass_cuts cu where cu.batch_id = b.id) c on true
  where b.company_id = v_company_id and b.branch_id = p_branch_id
    and b.batch_date between p_from and p_to;

  return jsonb_build_object('sales', v_sales, 'expenses', v_expenses, 'stock_adjustments', v_adjustments, 'carcass', v_carcass);
end;
$$;

revoke all on function public.period_result_report(uuid, date, date) from public, anon;
grant execute on function public.period_result_report(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('146_reports_all_plans') on conflict do nothing;
