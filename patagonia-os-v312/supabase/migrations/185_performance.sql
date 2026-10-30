-- 185: Velocidad (auditoría 29/10/2026, punto "rendimiento"). No cambia ningún dato ni ningún resultado.
--
-- 1. El stock es la suma de todos los movimientos de cada producto (nunca se guarda). El índice por empresa+sucursal+
--    producto obligaba a leer cada fila de la tabla para sumar la cantidad; con la cantidad dentro del índice
--    (INCLUDE) la suma sale del índice solo. Reemplaza al anterior (mismas columnas adelante, sirve para lo mismo).
-- 2. Inicio y Reportes traían cada pago de cada venta de Mostrador del período (miles de filas, de a 1000) para
--    sumarlos en la computadora. pos_sales_by_day_account devuelve ya sumado por día (hora de Argentina) y cuenta:
--    los mismos números, un pedido y pocas filas.
-- 3. Seis permisos de lectura de Contable volvían a calcular quién es el usuario en cada fila (aviso de Supabase
--    auth_rls_initplan): se calculan una vez por consulta. Mismas reglas.

-- 1 ---------------------------------------------------------------------------------------------------------
create index if not exists inventory_movements_stock_idx
  on public.inventory_movements (company_id, branch_id, product_id) include (quantity);
drop index if exists public.inventory_movements_company_branch_product_idx;

-- 2 ---------------------------------------------------------------------------------------------------------
create or replace function public.pos_sales_by_day_account(p_branch_id uuid, p_from date, p_to date)
returns table (sale_date date, account_id uuid, amount numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
begin
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;

  return query
  select (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date, pp.account_id, sum(pp.amount)
  from public.pos_sales s
  join public.pos_sale_payments pp on pp.sale_id = s.id
  where s.company_id = v_company_id
    and s.branch_id = p_branch_id
    and s.voided_at is null
    and s.created_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
    and s.created_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
  group by 1, 2;
end;
$$;
revoke all on function public.pos_sales_by_day_account(uuid, date, date) from public, anon;
grant execute on function public.pos_sales_by_day_account(uuid, date, date) to authenticated;

-- 3 ---------------------------------------------------------------------------------------------------------
do $mig$
declare
  t text;
  v_role_check constant text := 'exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = any (array[''owner'', ''admin'', ''manager'', ''accountant'']))';
begin
  foreach t in array array['purchase_vouchers', 'company_tax_settings', 'iibb_credits', 'tax_reminders', 'inventory_snapshots'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_read') then
      execute format('alter policy %I on public.%I using (company_id = (select public.current_company_id()) and %s)', t || '_read', t, v_role_check);
    end if;
  end loop;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'inventory_snapshot_items' and policyname = 'inventory_snapshot_items_read') then
    execute format(
      'alter policy inventory_snapshot_items_read on public.inventory_snapshot_items using (exists (select 1 from public.inventory_snapshots s where s.id = inventory_snapshot_items.snapshot_id and s.company_id = (select public.current_company_id())) and %s)',
      v_role_check
    );
  end if;
end
$mig$;

insert into public.schema_migrations (version) values ('185_performance') on conflict do nothing;
