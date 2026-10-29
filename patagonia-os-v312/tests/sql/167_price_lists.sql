-- Pruebas de la migración 167 (precio mayorista). Corren en la base de prueba
-- de scripts/ci/check-migrations.sh, dentro de una transacción que se deshace.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values ('00000000-0000-0000-0000-0000000000c1', 'Prueba', 9901, 'full');
insert into branches (id, company_id, name) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'dueno@prueba'), ('00000000-0000-0000-0000-0000000000a2', 'cajera@prueba');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'Cajera', 'cashier');
insert into treasury_accounts (id, company_id, name, payment_method) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'Efectivo', 'cash');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000c1', '105', 'Chorizo', 'kg', 6000, 8100),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-0000000000c1', '106', 'Morcilla', 'kg', 3000, 4200),
  ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-0000000000c1', '107', 'Chorizo x2 (oferta)', 'kg', 5000, 7000);
update products set stock_source_id = '00000000-0000-0000-0000-000000000101' where id = '00000000-0000-0000-0000-000000000103';

-- Como el dueño
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select public.save_price_list(null, 'Mayorista', 'retail', -10, true);
select public.set_product_list_prices(jsonb_build_array(jsonb_build_object(
  'product_id', '00000000-0000-0000-0000-000000000102', 'list_id', (select id from price_lists), 'price', 3750)));

do $$
declare v numeric;
begin
  select price into v from product_list_prices_view where product_id = '00000000-0000-0000-0000-000000000101';
  if v <> 7290 then raise exception 'regla: esperaba 7290, dio %', v; end if;
  select price into v from product_list_prices_view where product_id = '00000000-0000-0000-0000-000000000102';
  if v <> 3750 then raise exception 'precio a mano: esperaba 3750, dio %', v; end if;
  select price into v from product_list_prices_view where product_id = '00000000-0000-0000-0000-000000000103';
  if v <> 7000 then raise exception 'oferta: esperaba su precio 7000, dio %', v; end if;
end $$;

select public.open_pos_shift('00000000-0000-0000-0000-0000000000b1', 0, null, null);

-- Minorista: 1,25 kg = 10.125
select public.create_pos_sale('00000000-0000-0000-0000-0000000000b1',
  '[{"product_id":"00000000-0000-0000-0000-000000000101","quantity":1.25,"source":"scale","scale_tickets":1}]',
  '[{"account_id":"00000000-0000-0000-0000-0000000000e1","amount":10125}]',
  (select id from pos_shifts where status = 'open'), 0, 0, gen_random_uuid());
-- Mayorista: 9.112,50 + 7.500 + 7.000 = 23.612,50 -> 23.613
select public.create_pos_sale('00000000-0000-0000-0000-0000000000b1',
  jsonb_build_array(
    jsonb_build_object('product_id', '00000000-0000-0000-0000-000000000101', 'quantity', 1.25, 'source', 'scale', 'scale_tickets', 1, 'price_list_id', (select id from price_lists)),
    jsonb_build_object('product_id', '00000000-0000-0000-0000-000000000102', 'quantity', 2, 'price_list_id', (select id from price_lists)),
    jsonb_build_object('product_id', '00000000-0000-0000-0000-000000000103', 'quantity', 1, 'price_list_id', (select id from price_lists))),
  '[{"account_id":"00000000-0000-0000-0000-0000000000e1","amount":23613}]',
  (select id from pos_shifts where status = 'open'), 0, 0, gen_random_uuid());
-- Etiqueta con importe 10.125 a mayorista = 9.112,50 -> 9.113
select public.create_pos_sale('00000000-0000-0000-0000-0000000000b1',
  jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-0000-0000-000000000101', 'quantity', 1.25, 'source', 'scale', 'scale_tickets', 1,
    'scale_amount', 10125, 'scale_ticket', 'T1', 'price_list_id', (select id from price_lists))),
  '[{"account_id":"00000000-0000-0000-0000-0000000000e1","amount":9113}]',
  (select id from pos_shifts where status = 'open'), 0, 0, gen_random_uuid());

-- Cliente mayorista (cuenta corriente / Venta en ruta)
select public.create_customer('00000000-0000-0000-0000-0000000000b1', 'Parrilla', null, null, null, null);
select public.set_customer_price_list((select id from customers), (select id from price_lists));
select public.create_customer_charge_with_items((select id from customers), '00000000-0000-0000-0000-0000000000b1', current_date,
  '[{"product_id":"00000000-0000-0000-0000-000000000101","quantity":2}]', null, 0);
reset role;

do $$
declare v jsonb; n numeric;
begin
  -- El control de balanza compara contra lo que imprimió la balanza (3 × 10.125).
  v := public.scale_control_totals(array(select id from pos_shifts));
  if (v->>'system_amount')::numeric <> 30375 then raise exception 'control de balanza: esperaba 30375, dio %', v->>'system_amount'; end if;
  if (v->>'list_discount')::numeric <> 2025 then raise exception 'descuento mayorista: esperaba 2025, dio %', v->>'list_discount'; end if;
  select line_total into n from customer_charge_items;
  if n <> 14580 then raise exception 'cliente mayorista: esperaba 14580, dio %', n; end if;
end $$;

-- La cajera no crea listas, una lista ajena se rechaza, y el PIN funciona.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
do $$
begin
  begin
    perform public.save_price_list(null, 'Otra', 'retail', -5, true);
    raise exception 'la cajera pudo crear una lista';
  exception when raise_exception then
    if sqlerrm = 'la cajera pudo crear una lista' then raise; end if;
  end;
  begin
    perform public.create_pos_sale('00000000-0000-0000-0000-0000000000b1',
      '[{"product_id":"00000000-0000-0000-0000-000000000101","quantity":1,"price_list_id":"11111111-1111-1111-1111-111111111111"}]',
      '[{"account_id":"00000000-0000-0000-0000-0000000000e1","amount":8100}]',
      (select id from pos_shifts where status = 'open'), 0, 0, gen_random_uuid());
    raise exception 'se aceptó una lista ajena';
  exception when raise_exception then
    if sqlerrm = 'se aceptó una lista ajena' then raise; end if;
  end;
  if (public.check_price_list_pin(null)->>'ok')::boolean is not true then raise exception 'sin PIN configurado tenía que dejar pasar'; end if;
end $$;
reset role;
insert into company_void_pins (company_id, pin_hash) values ('00000000-0000-0000-0000-0000000000c1', extensions.crypt('1234', extensions.gen_salt('bf')));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
do $$
begin
  if (public.check_price_list_pin(null)->>'need_pin')::boolean is not true then raise exception 'sin PIN escrito tenía que pedirlo'; end if;
  if (public.check_price_list_pin('9999')->>'ok')::boolean then raise exception 'aceptó un PIN equivocado'; end if;
  if (public.check_price_list_pin('1234')->>'ok')::boolean is not true then raise exception 'rechazó el PIN correcto'; end if;
end $$;
do $$
begin
  perform public.price_list_price(null::public.products, null);
  raise exception 'una función interna quedó abierta';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
