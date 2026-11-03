-- Pruebas de la migración 192 (zonas de precios, compra repartida, local nuevo copiando otro). Se deshace.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000c9201', 'Cadena 192', 9921, 'empresa'),
  ('00000000-0000-0000-0000-0000000c9202', 'Solo Full 192', 9922, 'full');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c920a', '00000000-0000-0000-0000-0000000c9201', 'Planta'),
  ('00000000-0000-0000-0000-0000000c920b', '00000000-0000-0000-0000-0000000c9201', 'Chacabuco'),
  ('00000000-0000-0000-0000-0000000c920c', '00000000-0000-0000-0000-0000000c9201', 'Trejo'),
  ('00000000-0000-0000-0000-0000000c920f', '00000000-0000-0000-0000-0000000c9202', 'Única');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c9205', 'duenio@192'), ('00000000-0000-0000-0000-0000000c9206', 'encargado@192'),
  ('00000000-0000-0000-0000-0000000c9207', 'duenio-full@192');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c9205', '00000000-0000-0000-0000-0000000c9201', '00000000-0000-0000-0000-0000000c920a', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000c9206', '00000000-0000-0000-0000-0000000c9201', '00000000-0000-0000-0000-0000000c920b', 'Juan', 'manager'),
  ('00000000-0000-0000-0000-0000000c9207', '00000000-0000-0000-0000-0000000c9202', '00000000-0000-0000-0000-0000000c920f', 'Dueño Full', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c9208', '00000000-0000-0000-0000-0000000c9201', '1', 'Pollo', 'kg', 3000, 5000),
  ('00000000-0000-0000-0000-0000000c9209', '00000000-0000-0000-0000-0000000c9201', '2', 'Pechuga', 'kg', 6000, 9000);
insert into suppliers (id, company_id, name) values ('00000000-0000-0000-0000-0000000c9210', '00000000-0000-0000-0000-0000000c9201', 'Frigorífico Andes');
insert into purchases (id, company_id, branch_id, supplier_id, purchase_date, invoice_number, total, status, created_by) values
  ('00000000-0000-0000-0000-0000000c9211', '00000000-0000-0000-0000-0000000c9201', '00000000-0000-0000-0000-0000000c920a', '00000000-0000-0000-0000-0000000c9210', date '2026-11-02', 'A 0005-00012874', 1920000, 'active', '00000000-0000-0000-0000-0000000c9205');
insert into purchase_items (purchase_id, product_id, description, quantity, unit, unit_price, line_total) values
  ('00000000-0000-0000-0000-0000000c9211', '00000000-0000-0000-0000-0000000c9208', 'Pollo', 400, 'kg', 3000, 1200000),
  ('00000000-0000-0000-0000-0000000c9211', '00000000-0000-0000-0000-0000000c9209', 'Pechuga', 120, 'kg', 6000, 720000);
insert into treasury_accounts (company_id, name, payment_method, initial_balance, branch_id) values
  ('00000000-0000-0000-0000-0000000c9201', 'Efectivo Chacabuco', 'cash', 50000, '00000000-0000-0000-0000-0000000c920b'),
  ('00000000-0000-0000-0000-0000000c9201', 'Posnet', 'card', 0, '00000000-0000-0000-0000-0000000c920b');
insert into branch_min_stock (company_id, branch_id, product_id, min_stock) values
  ('00000000-0000-0000-0000-0000000c9201', '00000000-0000-0000-0000-0000000c920b', '00000000-0000-0000-0000-0000000c9208', 60);
insert into branch_scale_configs (company_id, branch_id, prefix_length, plu_length, weight_length, weight_divisor, total_length) values
  ('00000000-0000-0000-0000-0000000c9201', '00000000-0000-0000-0000-0000000c920b', 2, 3, 7, 100, 13);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9205', true);

-- 1. Zona Norte (+6%) para Chacabuco y Trejo; después Trejo sale de la zona.
do $$
declare v_zone uuid;
begin
  v_zone := public.save_price_zone(null, 'Zona Norte', 6,
    array['00000000-0000-0000-0000-0000000c920b', '00000000-0000-0000-0000-0000000c920c']::uuid[]);
  perform set_config('test.zone', v_zone::text, false);
  if (select count(*) from branches where price_zone_id = v_zone) <> 2 then raise exception 'locales de la zona'; end if;
  if (select price from product_list_prices_view where list_id = v_zone and product_id = '00000000-0000-0000-0000-0000000c9208') <> 5300 then
    raise exception 'precio de zona: %', (select price from product_list_prices_view where list_id = v_zone and product_id = '00000000-0000-0000-0000-0000000c9208');
  end if;
  perform public.save_price_zone(v_zone, 'Zona Norte', 6, array['00000000-0000-0000-0000-0000000c920b']::uuid[]);
  if (select price_zone_id from branches where id = '00000000-0000-0000-0000-0000000c920c') is not null then raise exception 'Trejo sigue en la zona'; end if;
  if not (select is_zone from price_lists where id = v_zone) then raise exception 'no quedó como zona'; end if;
  begin
    perform public.save_price_zone(null, 'General', 5, '{}');
    raise exception 'creó la zona General';
  exception when raise_exception then
    if sqlerrm = 'creó la zona General' then raise; end if;
  end;
end $$;

-- 2. Reparto de la compra: Chacabuco y Trejo; no más de lo comprado.
do $$
declare n integer;
begin
  n := public.distribute_purchase('00000000-0000-0000-0000-0000000c9211', '[
    {"branch_id":"00000000-0000-0000-0000-0000000c920b","items":[{"product_id":"00000000-0000-0000-0000-0000000c9208","quantity":60},{"product_id":"00000000-0000-0000-0000-0000000c9209","quantity":20}]},
    {"branch_id":"00000000-0000-0000-0000-0000000c920c","items":[{"product_id":"00000000-0000-0000-0000-0000000c9208","quantity":50},{"product_id":"00000000-0000-0000-0000-0000000c9209","quantity":0}]}
  ]');
  if n <> 2 then raise exception 'envíos armados: %', n; end if;
  if (select count(*) from branch_transfers where purchase_id = '00000000-0000-0000-0000-0000000c9211' and status = 'preparando' and from_branch_id = '00000000-0000-0000-0000-0000000c920a') <> 2 then
    raise exception 'los envíos no salen de la Planta preparando';
  end if;
  if (select count(*) from branch_transfer_items i join branch_transfers t on t.id = i.transfer_id where t.to_branch_id = '00000000-0000-0000-0000-0000000c920c' and t.purchase_id is not null) <> 1 then
    raise exception 'a Trejo fue la pechuga en cero';
  end if;
  if exists (select 1 from inventory_movements where reference_type = 'branch_shipment') then raise exception 'repartir movió stock'; end if;
  begin
    perform public.distribute_purchase('00000000-0000-0000-0000-0000000c9211',
      '[{"branch_id":"00000000-0000-0000-0000-0000000c920c","items":[{"product_id":"00000000-0000-0000-0000-0000000c9208","quantity":300}]}]');
    raise exception 'repartió más de lo comprado';
  exception when raise_exception then
    if sqlerrm = 'repartió más de lo comprado' then raise; end if;
  end;
end $$;

-- 3. Local nuevo copiando Chacabuco.
do $$
declare r jsonb; v uuid;
begin
  r := public.create_branch_copy('Godoy Cruz', '00000000-0000-0000-0000-0000000c920b', '{"accounts":true,"mins":true,"zone":true,"scale":true,"managers":true}');
  v := (r->>'id')::uuid;
  if (select array_agg(name order by name) from treasury_accounts where branch_id = v) <> array['Efectivo Godoy Cruz', 'Posnet Godoy Cruz'] then
    raise exception 'cuentas: %', (select array_agg(name) from treasury_accounts where branch_id = v);
  end if;
  if exists (select 1 from treasury_accounts where branch_id = v and initial_balance <> 0) then raise exception 'cuentas con saldo'; end if;
  if (select min_stock from branch_min_stock where branch_id = v) <> 60 then raise exception 'mínimos'; end if;
  if (select price_zone_id from branches where id = v)::text <> current_setting('test.zone') then raise exception 'zona'; end if;
  if (select weight_length from branch_scale_configs where branch_id = v) <> 7 then raise exception 'balanza'; end if;
  if not exists (select 1 from profile_branches where branch_id = v and profile_id = '00000000-0000-0000-0000-0000000c9206') then raise exception 'encargado'; end if;
  begin
    perform public.create_branch_copy('godoy cruz', '00000000-0000-0000-0000-0000000c920b', '{}');
    raise exception 'repitió el nombre';
  exception when raise_exception then
    if sqlerrm = 'repitió el nombre' then raise; end if;
  end;
end $$;

-- 4. El encargado no crea zonas ni locales; el plan Full no tiene nada de esto.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9206', true);
do $$
begin
  begin
    perform public.save_price_zone(null, 'Zona Sur', 3, '{}');
    raise exception 'el encargado creó una zona';
  exception when raise_exception then
    if sqlerrm = 'el encargado creó una zona' then raise; end if;
  end;
  begin
    perform public.create_branch_copy('Otro', '00000000-0000-0000-0000-0000000c920b', '{}');
    raise exception 'el encargado abrió un local';
  exception when raise_exception then
    if sqlerrm = 'el encargado abrió un local' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9207', true);
do $$
begin
  begin
    perform public.save_price_zone(null, 'Zona', 3, '{}');
    raise exception 'plan Full creó una zona';
  exception when raise_exception then
    if sqlerrm = 'plan Full creó una zona' then raise; end if;
  end;
end $$;

reset role;

-- 4b. Mostrador cobra con la misma función que con Mayorista: una zona se acepta y da su precio.
do $$
declare v numeric;
begin
  select public.pos_list_unit_price(p, jsonb_build_object('price_list_id', current_setting('test.zone'))) into v
  from products p where p.id = '00000000-0000-0000-0000-0000000c9208';
  if v <> 5300 then raise exception 'Mostrador cobraría % en vez del precio de la zona', v; end if;
end $$;

-- 5. Una zona no se le pone a un cliente.
insert into customers (id, company_id, branch_id, name) values
  ('00000000-0000-0000-0000-0000000c9212', '00000000-0000-0000-0000-0000000c9201', '00000000-0000-0000-0000-0000000c920a', 'Cliente');
do $$
begin
  begin
    update customers set price_list_id = current_setting('test.zone')::uuid where id = '00000000-0000-0000-0000-0000000c9212';
    raise exception 'le puso una zona a un cliente';
  exception when raise_exception then
    if sqlerrm = 'le puso una zona a un cliente' then raise; end if;
  end;
end $$;

rollback;
