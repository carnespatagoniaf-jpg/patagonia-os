-- 213: Venta a cuenta al precio de la zona del local. Pedido de Della Finca (26/11/2026): en Planta, Productos y
-- Mostrador muestran el precio de la zona del local (Aguja parrillera $8.200), pero Clientes → "+ Venta a cuenta"
-- a Cañada Dellafinca cobró el minorista general ($14.000).
--
-- La 167 cobra la venta a cuenta con customer_list_price (la lista del cliente o el minorista) y la 192 dejó afuera
-- las zonas. Ahora el precio es, en este orden:
--   1. la lista del cliente (si tiene una activa), como siempre;
--   2. si no tiene, la zona del local donde se carga la venta (branches.price_zone_id), igual que Mostrador;
--   3. si el local no tiene zona, el minorista general.
-- Venta en ruta usa la misma función con el camión como local: un camión sin zona sigue igual.
--
-- create_customer_charge_with_items se inyecta sobre la definición viva (la de la 145 + la 167), y si no aparecen
-- los dos puntos de la 167 se corta todo.

create or replace function public.customer_branch_price(p_product public.products, p_customer_id uuid, p_branch_id uuid)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.price_list_price(
    p_product,
    coalesce(
      (select c.price_list_id from public.customers c
         join public.price_lists l on l.id = c.price_list_id and l.active and l.company_id = p_product.company_id
       where c.id = p_customer_id),
      (select b.price_zone_id from public.branches b
         join public.price_lists z on z.id = b.price_zone_id and z.active and z.is_zone and z.company_id = p_product.company_id
       where b.id = p_branch_id)
    )
  );
$$;
revoke all on function public.customer_branch_price(public.products, uuid, uuid) from public, anon, authenticated;

do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.create_customer_charge_with_items(uuid,uuid,date,jsonb,text,numeric)');
  v_def text;
  v_old constant text := 'public.customer_list_price(v_product, p_customer_id)';
  v_new constant text := 'public.customer_branch_price(v_product, p_customer_id, p_branch_id)';
begin
  if v_proc is null then
    raise exception '213: no está create_customer_charge_with_items de 6 argumentos';
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position('customer_branch_price' in v_def) > 0 then
    raise notice '213: create_customer_charge_with_items ya cobra con la zona del local';
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 2 then
    raise exception '213: create_customer_charge_with_items no tiene los dos puntos de la 167';
  end if;
  execute replace(v_def, v_old, v_new);
end
$mig$;

insert into public.schema_migrations (version) values ('213_venta_cuenta_precio_zona') on conflict do nothing;
