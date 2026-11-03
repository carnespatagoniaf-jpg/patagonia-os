-- Pruebas de la migración 194 (plan Planta: envasar, despachar escaneando, recibir, vender y anular). Se deshace.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000c9401', 'Autoservicio 194', 9941, 'planta'),
  ('00000000-0000-0000-0000-0000000c9402', 'Cadena 194', 9942, 'empresa');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9401', 'Planta'),
  ('00000000-0000-0000-0000-0000000c940b', '00000000-0000-0000-0000-0000000c9401', 'Local Centro'),
  ('00000000-0000-0000-0000-0000000c940f', '00000000-0000-0000-0000-0000000c9402', 'Única');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c9405', 'duenio@194'), ('00000000-0000-0000-0000-0000000c9406', 'envasador@194'),
  ('00000000-0000-0000-0000-0000000c9407', 'cajera@194'), ('00000000-0000-0000-0000-0000000c9408', 'duenio-empresa@194');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c9405', '00000000-0000-0000-0000-0000000c9401', '00000000-0000-0000-0000-0000000c940a', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000c9406', '00000000-0000-0000-0000-0000000c9401', '00000000-0000-0000-0000-0000000c940a', 'Envasador', 'production'),
  ('00000000-0000-0000-0000-0000000c9407', '00000000-0000-0000-0000-0000000c9401', '00000000-0000-0000-0000-0000000c940b', 'Cajera', 'cashier'),
  ('00000000-0000-0000-0000-0000000c9408', '00000000-0000-0000-0000-0000000c9402', '00000000-0000-0000-0000-0000000c940f', 'Dueño Empresa', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c9410', '00000000-0000-0000-0000-0000000c9401', '10', 'Vacío', 'kg', 8000, 14000),
  ('00000000-0000-0000-0000-0000000c9411', '00000000-0000-0000-0000-0000000c9401', '20', 'Chorizo x6', 'unit', 900, 1500),
  ('00000000-0000-0000-0000-0000000c9412', '00000000-0000-0000-0000-0000000c9402', '10', 'Vacío', 'kg', 8000, 14000);
insert into inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reason) values
  ('00000000-0000-0000-0000-0000000c9401', '00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9410', 'adjustment', 50, 'inicial');

create function pg_temp.stock(p_branch text, p_product text) returns numeric language sql as $$
  select coalesce(sum(quantity), 0) from public.inventory_movements
  where branch_id = ('00000000-0000-0000-0000-0000000c94' || p_branch)::uuid and product_id = ('00000000-0000-0000-0000-0000000c94' || p_product)::uuid
$$;
create function pg_temp.pkg(p_code text) returns public.planta_packages language sql as $$
  select * from public.planta_packages where company_id = '00000000-0000-0000-0000-0000000c9401' and code = p_code
$$;
create function pg_temp.must_fail(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return;
  end;
  raise exception 'Tendría que haber fallado: %', p_label;
end $$;
grant execute on function pg_temp.stock(text, text) to authenticated;
grant execute on function pg_temp.pkg(text) to authenticated;
grant execute on function pg_temp.must_fail(text, text) to authenticated;

-- El plan: mismo orden que Empresa, nombre propio.
do $$
begin
  if public.plan_rank('planta') <> public.plan_rank('empresa') then raise exception 'Planta no tiene el orden de Empresa'; end if;
  if public.plan_display_name('planta') <> 'Planta' then raise exception 'nombre del plan'; end if;
end $$;

set local role authenticated;

-- 1. El dueño envasa 3 vacíos con vencimiento. No mueve los kilos.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9405', true);
do $$
declare r jsonb;
begin
  if not public.planta_enabled() then raise exception 'planta_enabled con plan Planta'; end if;
  if not public.company_plan_allows('empresa') then raise exception 'Planta no incluye lo de Empresa'; end if;
  r := public.planta_pack('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9410', array[1.2, 0.85, 1.0]::numeric[], null, public.today_ar() + 10);
  if jsonb_array_length(r) <> 3 or r->0->>'code' <> 'PQ00000001' or r->2->>'code' <> 'PQ00000003' then raise exception 'paquetes: %', r; end if;
  if pg_temp.stock('0a', '10') <> 50 then raise exception 'envasar movió stock'; end if;
  if (pg_temp.pkg('PQ00000002')).status <> 'en_planta' or (pg_temp.pkg('PQ00000002')).quantity <> 0.85 then raise exception 'paquete 2'; end if;
  perform pg_temp.must_fail($q$select public.planta_pack('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9410', array[0]::numeric[])$q$, 'peso cero');
  perform pg_temp.must_fail($q$select public.planta_pack('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9410', array[1]::numeric[], null, public.today_ar() - 1)$q$, 'vencido');
  perform pg_temp.must_fail($q$select public.planta_pack('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9412', array[1]::numeric[])$q$, 'producto de otra empresa');
end $$;

-- 2. El envasador de la planta envasa chorizo por unidad; solo unidades enteras; no envasa en el local.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9406', true);
do $$
declare r jsonb;
begin
  r := public.planta_pack('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9411', array[6]::numeric[]);
  if r->0->>'code' <> 'PQ00000004' then raise exception 'chorizo: %', r; end if;
  perform pg_temp.must_fail($q$select public.planta_pack('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9411', array[2.5]::numeric[])$q$, 'media unidad');
  perform pg_temp.must_fail($q$select public.planta_pack('00000000-0000-0000-0000-0000000c940b', '00000000-0000-0000-0000-0000000c9410', array[1]::numeric[])$q$, 'envasar en otro local');
end $$;

-- 3. La cajera no envasa; la empresa con plan Empresa tampoco (es solo de Planta) y no ve paquetes.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9407', true);
select pg_temp.must_fail($q$select public.planta_pack('00000000-0000-0000-0000-0000000c940b', '00000000-0000-0000-0000-0000000c9410', array[1]::numeric[])$q$, 'cajera envasando');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9408', true);
do $$
begin
  if public.planta_enabled() then raise exception 'Empresa con planta_enabled'; end if;
  perform pg_temp.must_fail($q$select public.planta_pack('00000000-0000-0000-0000-0000000c940f', '00000000-0000-0000-0000-0000000c9412', array[1]::numeric[])$q$, 'plan Empresa envasando');
  if exists (select 1 from public.planta_packages) then raise exception 'otra empresa ve paquetes'; end if;
end $$;

-- 4. Se despachan 3 paquetes escaneados al Local: un envío con los kilos por producto.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9406', true);
do $$
declare r jsonb; v uuid;
begin
  perform pg_temp.must_fail($q$select public.planta_ship('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c940b', array['PQ00000001', 'PQ99999999'])$q$, 'paquete que no existe');
  r := public.planta_ship('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c940b', array['pq00000001', 'PQ00000002', 'PQ00000004', 'PQ00000002'], 'Juan', 'AB123CD', null);
  v := (r->>'id')::uuid;
  if (r->>'packages')::int <> 3 then raise exception 'cantidad despachada: %', r; end if;
  if (select status from branch_transfers where id = v) <> 'en_viaje' then raise exception 'el envío no salió'; end if;
  if (select sent_qty from branch_transfer_items where transfer_id = v and product_id = '00000000-0000-0000-0000-0000000c9410') <> 2.05 then raise exception 'kilos del envío'; end if;
  if pg_temp.stock('0a', '10') <> 47.95 then raise exception 'stock de la planta: %', pg_temp.stock('0a', '10'); end if;
  if pg_temp.stock('0a', '11') <> -6 then raise exception 'chorizo de la planta'; end if;
  if (pg_temp.pkg('PQ00000001')).status <> 'en_viaje' or (pg_temp.pkg('PQ00000001')).transfer_id <> v then raise exception 'paquete en viaje'; end if;
  if (pg_temp.pkg('PQ00000003')).status <> 'en_planta' then raise exception 'se fue uno que no se escaneó'; end if;
  perform pg_temp.must_fail($q$select public.planta_ship('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c940b', array['PQ00000001'])$q$, 'mandar dos veces');
end $$;

-- 5. La cajera del Local recibe: los paquetes quedan en el Local.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9407', true);
do $$
declare v uuid; items jsonb;
begin
  v := (pg_temp.pkg('PQ00000001')).transfer_id;
  select jsonb_agg(jsonb_build_object('item_id', id, 'received', sent_qty)) into items from branch_transfer_items where transfer_id = v;
  perform public.receive_branch_transfer(v, items, 'Cajera', null);
  if (pg_temp.pkg('PQ00000002')).status <> 'en_local' or (pg_temp.pkg('PQ00000002')).branch_id <> '00000000-0000-0000-0000-0000000c940b' then raise exception 'no quedó en el local'; end if;
  if pg_temp.stock('0b', '10') <> 2.05 then raise exception 'stock del local'; end if;
end $$;
reset role;

-- 6. Se vende en Mostrador (el código viaja en scale_ticket) y se anula la venta.
insert into pos_shifts (id, company_id, branch_id, status, opened_by) values
  ('00000000-0000-0000-0000-0000000c9420', '00000000-0000-0000-0000-0000000c9401', '00000000-0000-0000-0000-0000000c940b', 'open', '00000000-0000-0000-0000-0000000c9407');
insert into pos_sales (id, company_id, branch_id, total, created_by, pos_shift_id) values
  ('00000000-0000-0000-0000-0000000c9421', '00000000-0000-0000-0000-0000000c9401', '00000000-0000-0000-0000-0000000c940b', 16800, '00000000-0000-0000-0000-0000000c9407', '00000000-0000-0000-0000-0000000c9420');
insert into pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total, scale_ticket) values
  ('00000000-0000-0000-0000-0000000c9421', '00000000-0000-0000-0000-0000000c9410', 1.2, 14000, 0, 16800, 'PQ00000001');
-- Un código de paquete con otro producto no marca nada (y la venta pasa igual).
insert into pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total, scale_ticket) values
  ('00000000-0000-0000-0000-0000000c9421', '00000000-0000-0000-0000-0000000c9411', 1, 1500, 0, 1500, 'PQ00000002');
do $$
begin
  if (pg_temp.pkg('PQ00000001')).status <> 'vendido' or (pg_temp.pkg('PQ00000001')).pos_sale_id <> '00000000-0000-0000-0000-0000000c9421' then raise exception 'no quedó vendido'; end if;
  if (pg_temp.pkg('PQ00000002')).status <> 'en_local' then raise exception 'marcó vendido con otro producto'; end if;
end $$;
update pos_sales set voided_at = now() where id = '00000000-0000-0000-0000-0000000c9421';
do $$
begin
  if (pg_temp.pkg('PQ00000001')).status <> 'en_local' or (pg_temp.pkg('PQ00000001')).pos_sale_id is not null then raise exception 'anular no lo devolvió'; end if;
end $$;

-- 7. Anular un paquete en la planta (con motivo); uno en viaje o vendido no.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9405', true);
do $$
begin
  perform pg_temp.must_fail(format($q$select public.planta_void_package(%L, '')$q$, (pg_temp.pkg('PQ00000003')).id), 'anular sin motivo');
  perform public.planta_void_package((pg_temp.pkg('PQ00000003')).id, 'Se rompió el vacío');
  if (pg_temp.pkg('PQ00000003')).status <> 'anulado' then raise exception 'no se anuló'; end if;
  perform pg_temp.must_fail(format($q$select public.planta_void_package(%L, 'otra vez')$q$, (pg_temp.pkg('PQ00000003')).id), 'anular dos veces');
  -- Directo a la tabla no se escribe (migración 175).
  perform pg_temp.must_fail($q$update public.planta_packages set status = 'en_planta'$q$, 'escribir la tabla');
end $$;
reset role;

-- 8. Un envío anulado en viaje devuelve los paquetes a la planta.
do $$
declare r jsonb;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9405', true);
  r := public.planta_pack('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c9410', array[2]::numeric[]);
  r := public.planta_ship('00000000-0000-0000-0000-0000000c940a', '00000000-0000-0000-0000-0000000c940b', array['PQ00000005']);
  perform public.void_branch_transfer((r->>'id')::uuid, 'Se rompió el camión');
  if (pg_temp.pkg('PQ00000005')).status <> 'en_planta' or (pg_temp.pkg('PQ00000005')).transfer_id is not null then raise exception 'no volvió a la planta'; end if;
end $$;

rollback;
