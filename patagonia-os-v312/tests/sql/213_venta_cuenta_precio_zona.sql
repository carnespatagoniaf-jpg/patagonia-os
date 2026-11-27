-- Pruebas de la migración 213 (venta a cuenta al precio de la zona del local). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values ('00000000-0000-0000-0000-0000000213c1', 'Prueba 213', 9213, 'full');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000213b1', '00000000-0000-0000-0000-0000000213c1', 'Centro'),
  ('00000000-0000-0000-0000-0000000213b2', '00000000-0000-0000-0000-0000000213c1', 'Planta');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000213a1', 'dueno@213');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000213a1', '00000000-0000-0000-0000-0000000213c1', '00000000-0000-0000-0000-0000000213b2', 'Dueño', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-000000213101', '00000000-0000-0000-0000-0000000213c1', '2', 'Aguja parrillera', 'kg', 7000, 14000),
  ('00000000-0000-0000-0000-000000213102', '00000000-0000-0000-0000-0000000213c1', '3', 'Bife de chorizo', 'kg', 15000, 20000);
insert into customers (id, company_id, branch_id, name) values
  ('00000000-0000-0000-0000-0000000213d1', '00000000-0000-0000-0000-0000000213c1', '00000000-0000-0000-0000-0000000213b2', 'Sucursal'),
  ('00000000-0000-0000-0000-0000000213d2', '00000000-0000-0000-0000-0000000213c1', '00000000-0000-0000-0000-0000000213b2', 'Mayorista');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000213a1', true);

-- Planta en una zona "minorista −20%", con la aguja a mano en 8.200. Centro sin zona.
-- El cliente "Mayorista" tiene su lista (minorista −10%).
do $$
declare v_zone uuid; v_list uuid;
begin
  v_zone := public.save_price_zone(null, 'Planta', -20, array['00000000-0000-0000-0000-0000000213b2']::uuid[]);
  perform public.set_product_list_prices(jsonb_build_array(jsonb_build_object(
    'product_id', '00000000-0000-0000-0000-000000213101', 'list_id', v_zone, 'price', 8200)));
  v_list := public.save_price_list(null, 'Mayorista', 'retail', -10, true);
  perform public.set_customer_price_list('00000000-0000-0000-0000-0000000213d2', v_list);
end $$;

-- Sin lista, cargada en Planta: precio de la zona (a mano 8.200 y la regla −20% = 16.000).
select public.create_customer_charge_with_items('00000000-0000-0000-0000-0000000213d1', '00000000-0000-0000-0000-0000000213b2', current_date,
  '[{"product_id":"00000000-0000-0000-0000-000000213101","quantity":1},{"product_id":"00000000-0000-0000-0000-000000213102","quantity":1}]', 'planta', 0);
-- Sin lista, cargada en Centro (sin zona): minorista general.
select public.create_customer_charge_with_items('00000000-0000-0000-0000-0000000213d1', '00000000-0000-0000-0000-0000000213b1', current_date,
  '[{"product_id":"00000000-0000-0000-0000-000000213101","quantity":1}]', 'centro', 0);
-- Con lista propia, cargada en Planta: manda la lista del cliente.
select public.create_customer_charge_with_items('00000000-0000-0000-0000-0000000213d2', '00000000-0000-0000-0000-0000000213b2', current_date,
  '[{"product_id":"00000000-0000-0000-0000-000000213101","quantity":1}]', 'lista', 0);
reset role;

do $$
declare v numeric;
begin
  select amount into v from customer_charges where reason = 'planta';
  if v <> 24200 then raise exception 'Planta sin lista: esperaba 8200 + 16000 = 24200, dio %', v; end if;
  select i.unit_price into v from customer_charge_items i join customer_charges c on c.id = i.charge_id
  where c.reason = 'planta' and i.product_id = '00000000-0000-0000-0000-000000213101';
  if v <> 8200 then raise exception 'renglón de la aguja en Planta: esperaba 8200, dio %', v; end if;
  select amount into v from customer_charges where reason = 'centro';
  if v <> 14000 then raise exception 'Centro sin zona: esperaba el minorista 14000, dio %', v; end if;
  select amount into v from customer_charges where reason = 'lista';
  if v <> 12600 then raise exception 'cliente con lista: esperaba 12600 (minorista −10%%), dio %', v; end if;
end $$;

-- La función nueva es interna.
set local role authenticated;
do $$
begin
  perform public.customer_branch_price(null::public.products, null, null);
  raise exception 'customer_branch_price quedó abierta';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
