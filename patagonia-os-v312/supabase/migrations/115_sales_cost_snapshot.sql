-- Reportes → "Por categoría": ganancia y margen (pedido del dueño, 2026-10-08).
--
-- 1) pos_sale_items.unit_cost: el costo del producto EN EL MOMENTO de la venta.
--    Lo completa un trigger BEFORE INSERT con products.cost (no se reescribe
--    create_pos_sale, que tiene inyecciones propias en cada base). Si sube la
--    carne, la ganancia de las ventas viejas no cambia.
-- 2) Las ventas anteriores a esta migración no tienen costo guardado: el
--    reporte usa el costo ACTUAL del producto y cuenta cuántos renglones son
--    estimados, para avisarlo en pantalla.
-- 3) sales_by_product suma además el costo (cost), los renglones con costo
--    estimado (estimated_cost_lines) y los renglones con costo 0 / sin cargar
--    (missing_cost_lines). Cambia la forma de lo que devuelve, por eso se borra
--    y se vuelve a crear (misma firma de entrada, mismos permisos).

alter table public.pos_sale_items
  add column if not exists unit_cost numeric(14,2);

create or replace function public.pos_sale_items_snapshot_cost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.unit_cost is null and new.product_id is not null then
    select p.cost into new.unit_cost from public.products p where p.id = new.product_id;
  end if;
  return new;
end;
$$;

drop trigger if exists pos_sale_items_snapshot_cost on public.pos_sale_items;
create trigger pos_sale_items_snapshot_cost
  before insert on public.pos_sale_items
  for each row execute function public.pos_sale_items_snapshot_cost();

revoke all on function public.pos_sale_items_snapshot_cost() from public, anon, authenticated;

drop function if exists public.sales_by_product(uuid, timestamptz, timestamptz);

create function public.sales_by_product(p_branch_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  product_id uuid,
  product_name text,
  product_code text,
  unit text,
  category_id uuid,
  category_name text,
  quantity numeric,
  amount numeric,
  lines bigint,
  cost numeric,
  estimated_cost_lines bigint,
  missing_cost_lines bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
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

  if p_branch_id is not null and not exists (
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

  return query
  select
    i.product_id,
    coalesce(p.name, case when i.source = 'scale_total' then 'Tickets de total de la balanza' else 'Vendido sin código' end),
    p.code,
    p.unit,
    p.category_id,
    pc.name,
    sum(i.quantity)::numeric,
    sum(coalesce(i.line_total, i.quantity * i.unit_price - coalesce(i.discount_amount, 0)))::numeric,
    count(*),
    sum(case when i.product_id is null then 0 else i.quantity * coalesce(i.unit_cost, p.cost, 0) end)::numeric,
    count(*) filter (where i.product_id is not null and i.unit_cost is null),
    count(*) filter (where i.product_id is not null and coalesce(i.unit_cost, p.cost, 0) <= 0)
  from public.pos_sale_items i
  join public.pos_sales s on s.id = i.sale_id
  left join public.products p on p.id = i.product_id
  left join public.product_categories pc on pc.id = p.category_id
  where s.company_id = v_company_id
    and (p_branch_id is null or s.branch_id = p_branch_id)
    and s.voided_at is null
    and s.created_at >= p_from
    and s.created_at <= p_to
  group by 1, 2, 3, 4, 5, 6;
end;
$$;

revoke all on function public.sales_by_product(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_by_product(uuid, timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('115_sales_cost_snapshot') on conflict do nothing;
