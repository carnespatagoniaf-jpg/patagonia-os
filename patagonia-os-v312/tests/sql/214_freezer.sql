-- Pruebas de la migración 214 (Freezer: guardar con la etiqueta de la balanza, sacar, vender en Mostrador y anular).
-- Se deshace.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, features) values
  ('00000000-0000-0000-0000-0000000f2141', 'Carnicería 214', 99214, array['freezer']),
  ('00000000-0000-0000-0000-0000000f2142', 'Otra 214', 99215, '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000f214a', '00000000-0000-0000-0000-0000000f2141', 'Centro'),
  ('00000000-0000-0000-0000-0000000f214b', '00000000-0000-0000-0000-0000000f2141', 'Norte'),
  ('00000000-0000-0000-0000-0000000f214f', '00000000-0000-0000-0000-0000000f2142', 'Única');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000f2145', 'duenio@214'), ('00000000-0000-0000-0000-0000000f2146', 'cajera@214'),
  ('00000000-0000-0000-0000-0000000f2148', 'otro@214');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000f2145', '00000000-0000-0000-0000-0000000f2141', '00000000-0000-0000-0000-0000000f214a', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000f2146', '00000000-0000-0000-0000-0000000f2141', '00000000-0000-0000-0000-0000000f214a', 'Cajera', 'cashier'),
  ('00000000-0000-0000-0000-0000000f2148', '00000000-0000-0000-0000-0000000f2142', '00000000-0000-0000-0000-0000000f214f', 'Otro', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000f2140', '00000000-0000-0000-0000-0000000f2141', '121', 'Matambre', 'kg', 9000, 15000),
  ('00000000-0000-0000-0000-0000000f2149', '00000000-0000-0000-0000-0000000f2141', '50', 'Hamburguesa x4', 'unit', 900, 1500),
  ('00000000-0000-0000-0000-0000000f214e', '00000000-0000-0000-0000-0000000f2142', '121', 'Matambre', 'kg', 9000, 15000);

create function pg_temp.must_fail(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return;
  end;
  raise exception 'Tendría que haber fallado: %', p_label;
end $$;
grant execute on function pg_temp.must_fail(text, text) to authenticated;

set local role authenticated;

-- 1. La cajera guarda 3 bolsas: dos de matambre con el MISMO código (mismo peso) y una hamburguesa a mano.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2146', true);
do $$
declare r jsonb;
begin
  r := public.freezer_store('00000000-0000-0000-0000-0000000f214a', jsonb_build_array(
    jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000f2140', 'quantity', 1.85, 'code', '2101210018509'),
    jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000f2140', 'quantity', 1.85, 'code', '2101210018509'),
    jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000f2149', 'quantity', 2)));
  if (r->>'packages')::int <> 3 or (r->>'kg')::numeric <> 3.7 then raise exception 'guardar: %', r; end if;
  if (select count(*) from public.freezer_packages where status = 'guardado') <> 3 then raise exception 'no se ven los 3'; end if;
  -- Guardar no mueve stock.
  if exists (select 1 from public.inventory_movements where company_id = '00000000-0000-0000-0000-0000000f2141') then
    raise exception 'guardar movió stock';
  end if;
end $$;

-- La cajera no puede guardar en otro local, ni medio paquete de hamburguesa, ni un producto de otra empresa.
select pg_temp.must_fail($q$select public.freezer_store('00000000-0000-0000-0000-0000000f214b', '[{"product_id":"00000000-0000-0000-0000-0000000f2140","quantity":1}]')$q$, 'otro local');
select pg_temp.must_fail($q$select public.freezer_store('00000000-0000-0000-0000-0000000f214a', '[{"product_id":"00000000-0000-0000-0000-0000000f2149","quantity":1.5}]')$q$, 'unidad partida');
select pg_temp.must_fail($q$select public.freezer_store('00000000-0000-0000-0000-0000000f214a', '[{"product_id":"00000000-0000-0000-0000-0000000f214e","quantity":1}]')$q$, 'producto ajeno');

-- 2. Otra empresa (sin la pantalla) no ve nada ni puede guardar.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2148', true);
do $$
begin
  if exists (select 1 from public.freezer_packages) then raise exception 'otra empresa ve el freezer'; end if;
end $$;
select pg_temp.must_fail($q$select public.freezer_store('00000000-0000-0000-0000-0000000f214f', '[{"product_id":"00000000-0000-0000-0000-0000000f214e","quantity":1}]')$q$, 'sin pantalla');
select pg_temp.must_fail($q$insert into public.freezer_packages (company_id, branch_id, product_id, quantity) values ('00000000-0000-0000-0000-0000000f2142', '00000000-0000-0000-0000-0000000f214f', '00000000-0000-0000-0000-0000000f214e', 1)$q$, 'escribir la tabla');

-- 3. Sacar a mano la hamburguesa (pide motivo) y volverla a guardar.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2145', true);
do $$
declare v_id uuid;
begin
  select id into v_id from public.freezer_packages where product_id = '00000000-0000-0000-0000-0000000f2149';
  perform pg_temp.must_fail(format('select public.freezer_take_out(array[%L]::uuid[], %L)', v_id, ' '), 'sin motivo');
  if public.freezer_take_out(array[v_id], 'Se usó para milanesas') <> 1 then raise exception 'sacar'; end if;
  if (select status from public.freezer_packages where id = v_id) <> 'sacado' then raise exception 'no quedó sacado'; end if;
  perform public.freezer_put_back(v_id);
  if (select status from public.freezer_packages where id = v_id) <> 'guardado' then raise exception 'no volvió'; end if;
end $$;

-- 4. Venta en Mostrador con una bolsa de matambre: sale la más vieja de las dos. Anular la devuelve.
reset role;
insert into pos_sales (id, company_id, branch_id, total, created_by) values
  ('00000000-0000-0000-0000-0000000f2150', '00000000-0000-0000-0000-0000000f2141', '00000000-0000-0000-0000-0000000f214a', 27750, '00000000-0000-0000-0000-0000000f2146'),
  ('00000000-0000-0000-0000-0000000f2151', '00000000-0000-0000-0000-0000000f2141', '00000000-0000-0000-0000-0000000f214b', 27750, '00000000-0000-0000-0000-0000000f2145');
insert into pos_sale_items (sale_id, product_id, quantity, unit_price, line_total, scale_ticket) values
  ('00000000-0000-0000-0000-0000000f2150', '00000000-0000-0000-0000-0000000f2140', 1.85, 15000, 27750, 'FRZ-2101210018509'),
  -- Mismo código vendido en OTRO local: no toca el freezer de Centro.
  ('00000000-0000-0000-0000-0000000f2151', '00000000-0000-0000-0000-0000000f2140', 1.85, 15000, 27750, 'FRZ-2101210018509');
do $$
declare v_first uuid;
begin
  select id into v_first from public.freezer_packages where code = '2101210018509' order by stored_at, id limit 1;
  if (select count(*) from public.freezer_packages where code = '2101210018509' and status = 'vendido') <> 1 then
    raise exception 'tenía que salir una sola bolsa';
  end if;
  if (select status from public.freezer_packages where id = v_first) <> 'vendido' then raise exception 'no salió la más vieja'; end if;
  if (select pos_sale_id from public.freezer_packages where id = v_first) <> '00000000-0000-0000-0000-0000000f2150' then raise exception 'venta'; end if;
end $$;
update pos_sales set voided_at = now() where id = '00000000-0000-0000-0000-0000000f2150';
do $$
begin
  if exists (select 1 from public.freezer_packages where status = 'vendido') then raise exception 'anular no la devolvió'; end if;
end $$;

-- 5. Una línea normal (sin FRZ-) no toca el freezer.
insert into pos_sales (id, company_id, branch_id, total, created_by) values
  ('00000000-0000-0000-0000-0000000f2152', '00000000-0000-0000-0000-0000000f2141', '00000000-0000-0000-0000-0000000f214a', 27750, '00000000-0000-0000-0000-0000000f2146');
insert into pos_sale_items (sale_id, product_id, quantity, unit_price, line_total, scale_ticket) values
  ('00000000-0000-0000-0000-0000000f2152', '00000000-0000-0000-0000-0000000f2140', 1.85, 15000, 27750, null);
do $$
begin
  if (select count(*) from public.freezer_packages where status = 'guardado') <> 3 then raise exception 'una venta común sacó del freezer'; end if;
end $$;

-- 6. La clave está en la lista del panel de plataforma.
do $$
begin
  if position('''freezer''' in pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure)) = 0 then
    raise exception 'falta freezer en set_company_feature';
  end if;
end $$;

select 'OK 214' as resultado;
rollback;
