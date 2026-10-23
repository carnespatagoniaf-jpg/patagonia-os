-- Decomisos (2026-10-23, pedido del dueño: "cuando se tiene que tirar algo,
-- un lugar en la caja donde se pesa y se anota, y va quedando en reportes").
-- Plan Full (regla del dueño: lo nuevo arranca en Full).
--
--   stock_wastes: cada decomiso, con el producto, los kilos o unidades, el
--                 motivo, el costo de ese momento (para que el reporte no
--                 cambie si después sube el costo), quién lo cargó y en qué caja.
--   register_stock_waste: lo carga y descuenta el stock (movimiento 'waste').
--                 Una presentación descuenta de su principal, como cualquier
--                 movimiento (trigger de la 111).
--   void_stock_waste: solo dueño/admin; devuelve el stock ('waste_void') y lo
--                 deja anulado (no se borra).
-- period_result_report (145/146) suma "wastes": Merma los lista y el
-- Resultado los resta. Esta función sigue para todos los planes (146).

create table if not exists public.stock_wastes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  product_id uuid not null references public.products(id),
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost numeric(14,2) not null default 0,
  reason text not null check (reason in ('vencido', 'mal_estado', 'roto', 'otro')),
  notes text,
  barcode text,
  pos_shift_id uuid references public.pos_shifts(id),
  cashier_employee_id uuid references public.employees(id),
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists stock_wastes_company_created on public.stock_wastes (company_id, branch_id, created_at desc);
create index if not exists stock_wastes_shift on public.stock_wastes (pos_shift_id);

alter table public.stock_wastes enable row level security;
drop policy if exists stock_wastes_company_read on public.stock_wastes;
create policy stock_wastes_company_read on public.stock_wastes for select to authenticated using (company_id = public.current_company_id());
drop policy if exists plan_full on public.stock_wastes;
create policy plan_full on public.stock_wastes as restrictive for all to authenticated using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));
revoke all on public.stock_wastes from anon;
grant select on public.stock_wastes to authenticated;

create or replace function public.register_stock_waste(
  p_branch_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_reason text,
  p_notes text default null,
  p_pos_shift_id uuid default null,
  p_barcode text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_product record;
  v_cashier uuid;
  v_id uuid;
begin
  perform public.require_plan('full');

  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;

  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;

  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000 then
    raise exception 'Cantidad inválida';
  end if;

  if p_reason is null or p_reason not in ('vencido', 'mal_estado', 'roto', 'otro') then
    raise exception 'Elegí el motivo del decomiso';
  end if;

  if p_reason = 'otro' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Contá qué pasó (motivo "Otro")';
  end if;

  select id, name, cost, unit into v_product
  from public.products
  where id = p_product_id and company_id = v_company_id
  for update;
  if not found then raise exception 'Producto inválido'; end if;

  if p_pos_shift_id is not null then
    select cashier_employee_id into v_cashier
    from public.pos_shifts
    where id = p_pos_shift_id and company_id = v_company_id and branch_id = p_branch_id and status = 'open';
    if not found then raise exception 'La caja no está abierta'; end if;
  end if;

  insert into public.stock_wastes (company_id, branch_id, product_id, quantity, unit_cost, reason, notes, barcode, pos_shift_id, cashier_employee_id, created_by)
  values (v_company_id, p_branch_id, p_product_id, round(p_quantity, 3), coalesce(v_product.cost, 0), p_reason,
    nullif(trim(coalesce(p_notes, '')), ''), nullif(trim(coalesce(p_barcode, '')), ''), p_pos_shift_id, v_cashier, v_user_id)
  returning id into v_id;

  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  values (v_company_id, p_branch_id, p_product_id, 'waste', -round(p_quantity, 3), 'stock_waste', v_id,
    'Decomiso: ' || p_reason || coalesce(' · ' || nullif(trim(coalesce(p_notes, '')), ''), ''), v_user_id);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'stock_waste.create', 'stock_waste', v_id::text,
    jsonb_build_object('product_id', p_product_id, 'product', v_product.name, 'quantity', round(p_quantity, 3), 'reason', p_reason, 'unit_cost', coalesce(v_product.cost, 0)));

  return v_id;
end;
$$;

create or replace function public.void_stock_waste(p_waste_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_waste record;
begin
  perform public.require_plan('full');

  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;

  select * into v_waste from public.stock_wastes where id = p_waste_id and company_id = v_company_id for update;
  if not found then raise exception 'Decomiso inválido'; end if;
  if v_waste.voided_at is not null then return; end if;

  update public.stock_wastes set voided_at = now(), voided_by = v_user_id where id = p_waste_id;

  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  values (v_company_id, v_waste.branch_id, v_waste.product_id, 'waste_void', v_waste.quantity, 'stock_waste_void', p_waste_id, 'Decomiso anulado', v_user_id);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_waste.branch_id, v_user_id, 'stock_waste.void', 'stock_waste', p_waste_id::text,
    jsonb_build_object('product_id', v_waste.product_id, 'quantity', v_waste.quantity));
end;
$$;

revoke all on function public.register_stock_waste(uuid, uuid, numeric, text, text, uuid, text) from public, anon;
grant execute on function public.register_stock_waste(uuid, uuid, numeric, text, text, uuid, text) to authenticated;
revoke all on function public.void_stock_waste(uuid) from public, anon;
grant execute on function public.void_stock_waste(uuid) to authenticated;

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
  v_wastes jsonb;
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

  -- Decomisos (151): por producto y motivo, al costo del momento en que se tiraron.
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', w.product_id, 'product_name', w.name, 'product_code', w.code, 'unit', w.unit,
      'reason', w.reason, 'quantity', w.quantity, 'value', w.value, 'count', w.n
    ) order by w.value desc), '[]'::jsonb)
  into v_wastes
  from (
    select sw.product_id, p.name, p.code, p.unit, sw.reason,
      sum(sw.quantity) as quantity, sum(sw.quantity * sw.unit_cost) as value, count(*) as n
    from public.stock_wastes sw
    join public.products p on p.id = sw.product_id
    where sw.company_id = v_company_id and sw.branch_id = p_branch_id and sw.voided_at is null
      and (sw.created_at at time zone v_ar)::date between p_from and p_to
    group by 1, 2, 3, 4, 5
  ) w;

  return jsonb_build_object('sales', v_sales, 'expenses', v_expenses, 'stock_adjustments', v_adjustments, 'carcass', v_carcass, 'wastes', v_wastes);
end;
$$;

revoke all on function public.period_result_report(uuid, date, date) from public, anon;
grant execute on function public.period_result_report(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('151_stock_wastes') on conflict do nothing;
