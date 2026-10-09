-- Reportes → "Por categoría" (pedido del dueño, 2026-10-08: "¿el sistema te va
-- desglosando cuánto se vende de carne, cuánto de pollo?"). Va dentro de la
-- pantalla Reportes, sin sumar nada al menú.
--
-- sales_by_product: lo vendido en Mostrador en un período, sumado POR PRODUCTO
-- (la web lo agrupa por categoría). La suma la hace la base para que un mes o
-- un año no sean miles de filas. Sin anuladas. Las líneas sin producto se
-- separan en "Tickets de total de la balanza" (source = 'scale_total') y
-- "Vendido sin código" (manual): no se puede saber de qué categoría eran.
-- El importe es el de cada renglón (con su descuento propio); el descuento o
-- recargo general de la venta no se reparte entre productos.
-- Mismos roles que ven Reportes (reports.view): dueño, administrador,
-- encargado y solo lectura. Todos los planes, como Reportes.

create or replace function public.sales_by_product(p_branch_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  product_id uuid,
  product_name text,
  product_code text,
  unit text,
  category_id uuid,
  category_name text,
  quantity numeric,
  amount numeric,
  lines bigint
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
    count(*)
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

insert into public.schema_migrations (version) values ('114_sales_by_product') on conflict do nothing;
