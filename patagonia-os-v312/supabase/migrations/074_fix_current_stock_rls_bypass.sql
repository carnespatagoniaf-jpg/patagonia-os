-- Mismo bug que 031_fix_view_rls_bypass.sql y 050_fix_customer_balance_rls_bypass.sql,
-- en una vista que ninguna de las dos pasadas anteriores tocó: current_stock
-- (001_core.sql) no tiene su propio filtro por company_id, y "create or
-- replace view" corre con los permisos del dueño (postgres, bypassea RLS).
-- No se llama directo desde el frontend (products_with_stock la usa por
-- adentro, ya filtrada), pero al estar "grant select to authenticated" --
-- y, más grave todavía, también a "anon" -- cualquiera podía leer el stock
-- de TODAS las empresas consultando /rest/v1/current_stock directo, sin
-- ni siquiera loguearse (la anon key es pública, va en el bundle del sitio).
-- Fix: agregar el filtro adentro de la vista, igual que las otras 6.
create or replace view public.current_stock as
select company_id, branch_id, product_id, sum(quantity) as quantity
from public.inventory_movements
where company_id = public.current_company_id()
group by company_id, branch_id, product_id;

-- Endurecimiento adicional para las 7 vistas de este tipo: ninguna necesita
-- que se pueda escribir en ella (son vistas de solo lectura), y ninguna
-- tiene que ser alcanzable sin login. El filtro por company_id ya las
-- protege (anon nunca tiene perfil, current_company_id() les da null y no
-- matchea ninguna fila), pero se saca el permiso de escritura y de acceso
-- anónimo para no depender de eso.
do $$
declare
  v text;
begin
  foreach v in array array[
    'current_stock', 'products_with_stock', 'treasury_balance',
    'supplier_balance', 'creditor_balance', 'customer_balance', 'products_price_list'
  ]
  loop
    execute format('revoke all on public.%I from anon', v);
    execute format('revoke all on public.%I from authenticated', v);
    execute format('grant select on public.%I to authenticated', v);
  end loop;
end $$;
