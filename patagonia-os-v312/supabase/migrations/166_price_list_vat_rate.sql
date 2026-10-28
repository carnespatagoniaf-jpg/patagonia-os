-- 166: IVA por producto visible en Stock.
-- La 154 agregó products.vat_rate y set_products_vat_rate lo guardaba bien, pero la web lo leía de la
-- tabla products, que desde la 051 no tiene SELECT para authenticated: la lectura fallaba en silencio y
-- Stock mostraba siempre "IVA General" (clientes, 28/10). Se agrega la columna al final de
-- products_price_list (mismo filtro por empresa, sin costos) y la web lee de ahí.

create or replace view public.products_price_list as
select id,
       company_id,
       code,
       name,
       unit,
       price_retail,
       active,
       vat_rate
from public.products
where company_id = (select public.current_company_id());

insert into public.schema_migrations (version) values ('166_price_list_vat_rate') on conflict do nothing;
