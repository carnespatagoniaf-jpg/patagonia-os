-- Reportes → "Por cajero" y "Por día y hora" (2026-10-22, pedido del dueño:
-- "en reportes solo tenemos la venta"). Plan Full (regla del dueño: lo nuevo
-- arranca en Full). El "Ranking de productos" sale de sales_by_product (114/115)
-- y no necesita nada acá.
--
-- sales_activity_report(sucursal, desde, hasta) devuelve:
--   cashiers: por cajero, ventas, total, anuladas, descuentos y, solo para
--             dueño/admin (igual que list_pos_shift_closes), los cierres de caja
--             del período con su diferencia (contado − esperado: negativo = faltó).
--             El cajero de una venta es el del PIN de la caja (pos_shifts.
--             cashier_employee_id) y, si no hay PIN, el usuario que la cargó.
--   hours:    ventas y total por día de la semana (1 = lunes … 7 = domingo) y
--             hora, en hora de Argentina.
-- Solo Mostrador (pos_sales); Turnos no guarda hora ni cajero.

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
  perform public.require_plan('full');

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
      count(*) filter (where difference < 0) as short_shifts
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

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('144_sales_activity_report') on conflict do nothing;
