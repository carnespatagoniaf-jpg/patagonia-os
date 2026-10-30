-- Pruebas de la migración 185 (velocidad). Se deshace al final.
\set ON_ERROR_STOP 1
begin;
do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'inventory_movements_stock_idx' and indexdef like '%INCLUDE (quantity)%') then
    raise exception 'falta el índice con la cantidad adentro';
  end if;
  if has_function_privilege('anon', 'public.pos_sales_by_day_account(uuid,date,date)', 'execute') then
    raise exception 'anon puede ver ventas por día';
  end if;
  if exists (
    select 1 from pg_policies
    where policyname in ('purchase_vouchers_read', 'company_tax_settings_read', 'iibb_credits_read', 'tax_reminders_read', 'inventory_snapshots_read', 'inventory_snapshot_items_read')
      and qual ~ 'auth\.uid\(\)' and qual !~ 'SELECT auth\.uid\(\)'
  ) then
    raise exception 'quedó un permiso que calcula el usuario en cada fila';
  end if;
end $$;
rollback;
