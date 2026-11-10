-- Pruebas de la migración 197 (precios por zona en todos los planes). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values ('00000000-0000-0000-0000-0000000197c1', 'Estándar 197', 9971, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000197b1', '00000000-0000-0000-0000-0000000197c1', 'Centro'),
  ('00000000-0000-0000-0000-0000000197b2', '00000000-0000-0000-0000-0000000197c1', 'Barrio');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000197a1', 'dueno@197'), ('00000000-0000-0000-0000-0000000197a2', 'cajera@197');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000197a1', '00000000-0000-0000-0000-0000000197c1', '00000000-0000-0000-0000-0000000197b1', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000197a2', '00000000-0000-0000-0000-0000000197c1', '00000000-0000-0000-0000-0000000197b2', 'Cajera', 'cashier');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-000000197101', '00000000-0000-0000-0000-0000000197c1', '1', 'Asado', 'kg', 8000, 12000);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000197a1', true);

-- Plan Estándar: el dueño crea una zona para "Barrio" (+5%) y le pone un precio a mano a un producto.
do $$
declare v_zone uuid; v numeric;
begin
  v_zone := public.save_price_zone(null, 'Barrio', 5, array['00000000-0000-0000-0000-0000000197b2']::uuid[]);
  perform set_config('test.zone197', v_zone::text, false);
  if (select price_zone_id from branches where id = '00000000-0000-0000-0000-0000000197b2') is distinct from v_zone then
    raise exception 'Barrio no quedó en la zona';
  end if;
  if (select price_zone_id from branches where id = '00000000-0000-0000-0000-0000000197b1') is not null then
    raise exception 'Centro quedó en la zona';
  end if;
  select price into v from product_list_prices_view where list_id = v_zone and product_id = '00000000-0000-0000-0000-000000197101';
  if v <> 12600 then raise exception 'precio de zona: esperaba 12600, dio %', v; end if;
  perform public.set_product_list_prices(jsonb_build_array(jsonb_build_object(
    'product_id', '00000000-0000-0000-0000-000000197101', 'list_id', v_zone, 'price', 13000)));
  select price into v from product_list_prices_view where list_id = v_zone and product_id = '00000000-0000-0000-0000-000000197101';
  if v <> 13000 then raise exception 'precio a mano: esperaba 13000, dio %', v; end if;
end $$;

-- La cajera sigue sin poder crear zonas.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000197a2', true);
do $$
begin
  begin
    perform public.save_price_zone(null, 'Otra', 3, '{}');
    raise exception 'la cajera creó una zona';
  exception when others then
    if sqlerrm = 'la cajera creó una zona' then raise; end if;
  end;
end $$;

reset role;

-- Mostrador de Barrio cobra el precio de la zona; el precio general (Centro) no cambió.
do $$
declare v numeric;
begin
  select public.pos_list_unit_price(p, jsonb_build_object('price_list_id', current_setting('test.zone197'))) into v
  from products p where p.id = '00000000-0000-0000-0000-000000197101';
  if v <> 13000 then raise exception 'Mostrador de Barrio cobraría %', v; end if;
  if (select price_retail from products where id = '00000000-0000-0000-0000-000000197101') <> 12000 then
    raise exception 'cambió el precio general';
  end if;
end $$;

rollback;
