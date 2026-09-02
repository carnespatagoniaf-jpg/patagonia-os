-- Hasta ahora costo/margen de producto se ocultaba solo a nivel pantalla
-- (Mostrador y Productos nunca lo muestran) -- pero como products_with_stock
-- y la tabla products están grant select a "authenticated", un cajero con
-- las herramientas de desarrollador del navegador podía pedirle directo a
-- la API el costo igual. Esto lo cierra en la base:
--
-- 1) products_with_stock ahora devuelve cost = null para el rol "cashier"
--    (el único rol que llega a Mostrador/Productos sin tener acceso a
--    Stock -- ver rolePermissions en permissions.ts). El resto de los
--    roles (owner/admin/manager/production/readonly, todos con
--    inventory.view) lo siguen viendo normal.
-- 2) products_price_list: vista nueva, compañía entera (no por sucursal,
--    a diferencia de products_with_stock) sin costo en absoluto, para la
--    pantalla "Productos" (products-service.ts) que hoy consultaba la
--    tabla products directo.
-- 3) Se revoca el select directo sobre la tabla products -- de ahora en
--    más solo se lee a través de estas dos vistas (los RPCs que la tocan
--    para crear/editar productos no se ven afectados, corren con los
--    permisos del dueño de la función, no con el grant del rol).
create or replace view public.products_with_stock as
select
  p.id,
  p.company_id,
  b.id as branch_id,
  p.code,
  p.name,
  p.unit,
  (case when (select role from public.profiles where id = auth.uid()) = 'cashier' then null else p.cost end)::numeric(14,2) as cost,
  p.price_retail,
  p.min_stock,
  p.active,
  coalesce(cs.quantity, 0) as stock,
  p.category_id
from public.products p
cross join public.branches b
left join public.current_stock cs
  on cs.company_id = p.company_id
 and cs.branch_id = b.id
 and cs.product_id = p.id
where b.company_id = p.company_id
  and b.active = true
  and p.company_id = public.current_company_id();

create or replace view public.products_price_list as
select id, company_id, code, name, unit, price_retail, active
from public.products
where company_id = public.current_company_id();

grant select on public.products_price_list to authenticated;

revoke select on public.products from authenticated, anon;
