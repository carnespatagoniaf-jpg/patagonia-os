-- Pruebas de las migraciones 189 (plan Empresa) y 190 (pedidos entre locales). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- A: plan Empresa con Planta, Centro y Norte. B: otra empresa Empresa. C: plan Full (no tiene la etapa 2).
insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000c9001', 'Cadena', 9901, 'empresa'),
  ('00000000-0000-0000-0000-0000000c9011', 'Otra cadena', 9902, 'empresa'),
  ('00000000-0000-0000-0000-0000000c9021', 'Solo Full', 9903, 'full');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9001', 'Planta'),
  ('00000000-0000-0000-0000-0000000c9003', '00000000-0000-0000-0000-0000000c9001', 'Centro'),
  ('00000000-0000-0000-0000-0000000c9004', '00000000-0000-0000-0000-0000000c9001', 'Norte'),
  ('00000000-0000-0000-0000-0000000c9012', '00000000-0000-0000-0000-0000000c9011', 'Única B'),
  ('00000000-0000-0000-0000-0000000c9022', '00000000-0000-0000-0000-0000000c9021', 'Planta C'),
  ('00000000-0000-0000-0000-0000000c9023', '00000000-0000-0000-0000-0000000c9021', 'Centro C');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c9005', 'duenio@a'), ('00000000-0000-0000-0000-0000000c9006', 'encargado-centro@a'),
  ('00000000-0000-0000-0000-0000000c9007', 'encargado-planta@a'), ('00000000-0000-0000-0000-0000000c9008', 'cajera-norte@a'),
  ('00000000-0000-0000-0000-0000000c9009', 'contador@a'), ('00000000-0000-0000-0000-0000000c9015', 'duenio@b'),
  ('00000000-0000-0000-0000-0000000c9025', 'duenio@c');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c9005', '00000000-0000-0000-0000-0000000c9001', '00000000-0000-0000-0000-0000000c9002', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000c9006', '00000000-0000-0000-0000-0000000c9001', '00000000-0000-0000-0000-0000000c9003', 'Juan Centro', 'manager'),
  ('00000000-0000-0000-0000-0000000c9007', '00000000-0000-0000-0000-0000000c9001', '00000000-0000-0000-0000-0000000c9002', 'Raúl Planta', 'manager'),
  ('00000000-0000-0000-0000-0000000c9008', '00000000-0000-0000-0000-0000000c9001', '00000000-0000-0000-0000-0000000c9004', 'Cajera Norte', 'cashier'),
  ('00000000-0000-0000-0000-0000000c9009', '00000000-0000-0000-0000-0000000c9001', '00000000-0000-0000-0000-0000000c9002', 'Contador', 'accountant'),
  ('00000000-0000-0000-0000-0000000c9015', '00000000-0000-0000-0000-0000000c9011', '00000000-0000-0000-0000-0000000c9012', 'Dueño B', 'owner'),
  ('00000000-0000-0000-0000-0000000c9025', '00000000-0000-0000-0000-0000000c9021', '00000000-0000-0000-0000-0000000c9022', 'Dueño C', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c900a', '00000000-0000-0000-0000-0000000c9001', '101', 'Asado', 'kg', 10000, 15000),
  ('00000000-0000-0000-0000-0000000c900b', '00000000-0000-0000-0000-0000000c9001', '210', 'Chorizo', 'kg', 9000, 13000),
  ('00000000-0000-0000-0000-0000000c900d', '00000000-0000-0000-0000-0000000c9001', '112', 'Nalga', 'kg', 13000, 18000),
  ('00000000-0000-0000-0000-0000000c901a', '00000000-0000-0000-0000-0000000c9011', '1', 'Asado B', 'kg', 9000, 15000),
  ('00000000-0000-0000-0000-0000000c902a', '00000000-0000-0000-0000-0000000c9021', '1', 'Asado C', 'kg', 9000, 15000);
insert into products (id, company_id, code, name, unit, cost, price_retail, stock_source_id, stock_factor) values
  ('00000000-0000-0000-0000-0000000c900c', '00000000-0000-0000-0000-0000000c9001', '901', 'Asado oferta x3', 'unit', 30000, 40000,
   '00000000-0000-0000-0000-0000000c900a', 3);
insert into inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reason) values
  ('00000000-0000-0000-0000-0000000c9001', '00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c900a', 'adjustment', 100, 'inicial'),
  ('00000000-0000-0000-0000-0000000c9001', '00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c900b', 'adjustment', 20, 'inicial'),
  ('00000000-0000-0000-0000-0000000c9001', '00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c900d', 'adjustment', 5, 'inicial');
-- Datos fiscales y un CAI, para el Remito R.
insert into company_fiscal_settings (company_id, cuit, business_name, tax_condition, point_of_sale, address, gross_income_number, activity_start) values
  ('00000000-0000-0000-0000-0000000c9001', '30712345671', 'Cadena SRL', 'responsable_inscripto', 1, 'Ruta 9 km 12', '901-123456-7', date '2015-03-01');
insert into remito_cai (company_id, point_of_sale, cai, cai_due, number_from, number_to) values
  ('00000000-0000-0000-0000-0000000c9001', 3, '75123456789012', date '2099-12-31', 1, 100);

-- Plan Empresa: arriba de Full.
do $$
begin
  if public.plan_rank('empresa') <= public.plan_rank('full') then raise exception 'Empresa no está arriba de Full'; end if;
  if public.plan_display_name('empresa') <> 'Empresa' then raise exception 'nombre del plan'; end if;
end $$;

-- Ayudas de la prueba (sesión, solo para esta prueba).
create function pg_temp.stock(p_branch text, p_product text) returns numeric language sql as $$
  select coalesce(sum(quantity), 0) from public.inventory_movements
  where branch_id = ('00000000-0000-0000-0000-0000000c90' || p_branch)::uuid and product_id = ('00000000-0000-0000-0000-0000000c90' || p_product)::uuid
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
grant execute on function pg_temp.must_fail(text, text) to authenticated;

set local role authenticated;

-- 1. El encargado del Centro le pide a la Planta.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9006', true);
do $$
declare v uuid;
begin
  v := public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9003', null, 'Si no hay nalga, cuadrada',
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":30},{"product_id":"00000000-0000-0000-0000-0000000c900b","quantity":5}]');
  perform set_config('test.t1', v::text, false);
  if (select status from branch_transfers where id = v) <> 'pedido' then raise exception 'no quedó como pedido'; end if;
  if (select number from branch_transfers where id = v) <> 1 then raise exception 'número del pedido'; end if;

  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9004', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":1}]')$q$, 'pedir para otro local');
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9003', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c901a","quantity":1}]')$q$, 'producto de otra empresa');
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9003', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900c","quantity":1}]')$q$, 'una presentación');
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9003', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":0}]')$q$, 'cantidad cero');
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9003', null, null, '[]')$q$, 'sin productos');
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9003', '00000000-0000-0000-0000-0000000c9003', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":1}]')$q$, 'mismo local');
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9003', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":1},{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":2}]')$q$, 'producto repetido');
  -- El encargado no prepara ni despacha lo que sale de la Planta.
  perform pg_temp.must_fail(format($q$select public.dispatch_branch_transfer(%L, null, null, '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":1}]', null, null, null)$q$, v), 'despachar desde otro local');
  perform pg_temp.must_fail($q$select public.set_branch_min_stock('00000000-0000-0000-0000-0000000c9003', '[{"product_id":"00000000-0000-0000-0000-0000000c900a","min_stock":30}]')$q$, 'encargado cambia mínimos');
end $$;

-- 2. La cajera de Norte no toca el pedido del Centro.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9008', true);
do $$
declare v uuid := current_setting('test.t1')::uuid;
begin
  perform pg_temp.must_fail(format($q$select public.prepare_branch_transfer(%L, null, null, '[]', null, null, null)$q$, v), 'preparar desde otro local');
  perform pg_temp.must_fail(format($q$select public.cancel_branch_transfer(%L, null)$q$, v), 'cancelar un pedido ajeno');
end $$;

-- 3. La Planta prepara (manda menos asado, nada de chorizo, suma nalga) y despacha: sale de la Planta, todavía no entra al Centro.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9007', true);
do $$
declare v uuid := current_setting('test.t1')::uuid; r jsonb;
begin
  perform public.prepare_branch_transfer(v, null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":26},{"product_id":"00000000-0000-0000-0000-0000000c900d","quantity":3}]', 'Raúl', 'AB 123 CD', null);
  if (select status from branch_transfers where id = v) <> 'preparando' then raise exception 'no quedó preparando'; end if;
  if pg_temp.stock('02', '0a') <> 100 then raise exception 'preparar no tiene que mover stock'; end if;

  r := public.dispatch_branch_transfer(v, null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":26.4},{"product_id":"00000000-0000-0000-0000-0000000c900b","quantity":0},{"product_id":"00000000-0000-0000-0000-0000000c900d","quantity":3}]',
    'Raúl', 'AB 123 CD', null);
  if (r->>'number')::int <> 1 or r->>'remito_id' is not null then raise exception 'respuesta del despacho: %', r; end if;
  if (select status from branch_transfers where id = v) <> 'en_viaje' then raise exception 'no quedó en viaje'; end if;
  if pg_temp.stock('02', '0a') <> 73.6 then raise exception 'no salió asado de la Planta: %', pg_temp.stock('02', '0a'); end if;
  if pg_temp.stock('02', '0b') <> 20 then raise exception 'salió chorizo que no se mandó'; end if;
  if pg_temp.stock('03', '0a') <> 0 then raise exception 'entró al Centro antes de recibir'; end if;
  if (select count(*) from branch_transfer_items where transfer_id = v) <> 3 then raise exception 'ítems del envío'; end if;
  if (select unit_cost from branch_transfer_items where transfer_id = v and product_id = '00000000-0000-0000-0000-0000000c900a') <> 10000 then raise exception 'costo al despachar'; end if;
  if (select requested_qty from branch_transfer_items where transfer_id = v and product_id = '00000000-0000-0000-0000-0000000c900d') is not null then raise exception 'la nalga no estaba pedida'; end if;

  perform pg_temp.must_fail(format($q$select public.dispatch_branch_transfer(%L, null, null, '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":1}]', null, null, null)$q$, v), 'despachar dos veces');
  perform pg_temp.must_fail(format($q$select public.cancel_branch_transfer(%L, null)$q$, v), 'cancelar en viaje');
  perform pg_temp.must_fail(format($q$select public.receive_branch_transfer(%L, '[]', null, null)$q$, v), 'recibir desde el que manda');
end $$;

-- 4. El Centro recibe: faltan 0,4 kg de asado. Entra lo que llegó; lo que falta no vuelve a la Planta.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9006', true);
do $$
declare v uuid := current_setting('test.t1')::uuid; r jsonb; a uuid; n uuid;
begin
  select id into a from branch_transfer_items where transfer_id = v and product_id = '00000000-0000-0000-0000-0000000c900a';
  select id into n from branch_transfer_items where transfer_id = v and product_id = '00000000-0000-0000-0000-0000000c900d';
  perform pg_temp.must_fail(format($q$select public.receive_branch_transfer(%L, %L, null, null)$q$, v, jsonb_build_array(jsonb_build_object('item_id', a, 'received', 26))), 'recibir sin anotar todo');
  r := public.receive_branch_transfer(v, jsonb_build_array(jsonb_build_object('item_id', a, 'received', 26), jsonb_build_object('item_id', n, 'received', 3)), null, 'Faltó un pedazo');
  if (r->>'missing')::numeric <> 0.4 then raise exception 'faltante: %', r; end if;
  if pg_temp.stock('03', '0a') <> 26 or pg_temp.stock('03', '0d') <> 3 then raise exception 'no entró lo que llegó'; end if;
  if pg_temp.stock('02', '0a') <> 73.6 then raise exception 'el faltante volvió a la Planta'; end if;
  if (select received_by_name from branch_transfers where id = v) <> 'Juan Centro' then raise exception 'quién recibió'; end if;
  if (select status from branch_transfers where id = v) <> 'recibido' then raise exception 'no quedó recibido'; end if;
  perform pg_temp.must_fail(format($q$select public.receive_branch_transfer(%L, %L, null, null)$q$, v, jsonb_build_array(jsonb_build_object('item_id', a, 'received', 26), jsonb_build_object('item_id', n, 'received', 3))), 'recibir dos veces');

  -- Un pedido que se cancela antes de salir.
  v := public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9003', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900b","quantity":2}]');
  perform public.cancel_branch_transfer(v, 'Ya no hace falta');
  if (select status from branch_transfers where id = v) <> 'cancelado' then raise exception 'no se canceló'; end if;
end $$;

-- 5. Envío sin pedido de la Planta a Norte, con Remito R. Sin domicilio no sale; con domicilio, sí.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9007', true);
do $$
declare r jsonb;
begin
  perform pg_temp.must_fail($q$select public.dispatch_branch_transfer(null, '00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9004',
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":10}]', null, null, null, true, true, null)$q$, 'Remito R sin domicilio');
  r := public.dispatch_branch_transfer(null, '00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9004',
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":10}]', 'Raúl', null, 'Reparto del lunes', true, true, 'Norte 123');
  perform set_config('test.t3', r->>'id', false);
  if r->>'remito_id' is null then raise exception 'no salió el Remito R'; end if;
  if (select number from remitos where id = (r->>'remito_id')::uuid) <> 1 then raise exception 'número del remito'; end if;
  if (select total from remitos where id = (r->>'remito_id')::uuid) <> 100000 then raise exception 'total del remito'; end if;
  if (select branch_transfer_id from remitos where id = (r->>'remito_id')::uuid) <> (r->>'id')::uuid then raise exception 'remito sin su envío'; end if;
  if (select receiver->>'address' from remitos where id = (r->>'remito_id')::uuid) <> 'Norte 123' then raise exception 'domicilio del destinatario'; end if;
  if pg_temp.stock('02', '0a') <> 63.6 then raise exception 'no salió de la Planta'; end if;
  perform pg_temp.must_fail(format($q$select public.void_branch_transfer(%L, 'error')$q$, r->>'id'), 'el encargado anula un envío en viaje');
end $$;

-- 6. El dueño anula el envío en viaje: vuelve a la Planta y el remito queda anulado. Mínimos por local.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9005', true);
do $$
declare v uuid := current_setting('test.t3')::uuid;
begin
  perform pg_temp.must_fail(format($q$select public.void_branch_transfer(%L, null)$q$, v), 'anular sin motivo');
  perform public.void_branch_transfer(v, 'Se rompió la camioneta');
  if pg_temp.stock('02', '0a') <> 73.6 then raise exception 'no volvió a la Planta'; end if;
  if pg_temp.stock('04', '0a') <> 0 then raise exception 'entró a Norte'; end if;
  if (select status from remitos where branch_transfer_id = v) <> 'anulado' then raise exception 'el remito sigue emitido'; end if;
  if (select status from branch_transfers where id = v) <> 'cancelado' then raise exception 'el envío no quedó anulado'; end if;

  perform public.set_branch_min_stock('00000000-0000-0000-0000-0000000c9003', '[{"product_id":"00000000-0000-0000-0000-0000000c900a","min_stock":30},{"product_id":"00000000-0000-0000-0000-0000000c900b","min_stock":12}]');
  perform public.set_branch_min_stock('00000000-0000-0000-0000-0000000c9003', '[{"product_id":"00000000-0000-0000-0000-0000000c900a","min_stock":25},{"product_id":"00000000-0000-0000-0000-0000000c900b","min_stock":0}]');
  if (select min_stock from branch_min_stock where branch_id = '00000000-0000-0000-0000-0000000c9003' and product_id = '00000000-0000-0000-0000-0000000c900a') <> 25 then raise exception 'mínimo del local'; end if;
  if exists (select 1 from branch_min_stock where product_id = '00000000-0000-0000-0000-0000000c900b') then raise exception 'mínimo 0 no se borró'; end if;
  perform pg_temp.must_fail($q$select public.set_branch_min_stock('00000000-0000-0000-0000-0000000c9012', '[{"product_id":"00000000-0000-0000-0000-0000000c900a","min_stock":3}]')$q$, 'mínimo en local de otra empresa');
  if (select count(*) from audit_log where entity_type = 'branch_transfer') < 6 then raise exception 'auditoría incompleta'; end if;
end $$;

-- 7. Otra empresa no ve ni toca nada; el plan Full no tiene la etapa 2; el contador no escribe.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9015', true);
do $$
begin
  if exists (select 1 from branch_transfers) or exists (select 1 from branch_transfer_items) or exists (select 1 from branch_min_stock) then
    raise exception 'otra empresa ve los envíos';
  end if;
  perform pg_temp.must_fail(format($q$select public.cancel_branch_transfer(%L, null)$q$, current_setting('test.t1')), 'otra empresa cancela');
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9012', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c901a","quantity":1}]')$q$, 'pedir a un local de otra empresa');
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9025', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9022', '00000000-0000-0000-0000-0000000c9023', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c902a","quantity":1}]')$q$, 'plan Full pide');
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9009', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.request_branch_transfer('00000000-0000-0000-0000-0000000c9002', '00000000-0000-0000-0000-0000000c9003', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c900a","quantity":1}]')$q$, 'el contador pide');
end $$;

-- 8. Nadie escribe las tablas directo.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9005', true);
do $$
begin
  perform pg_temp.must_fail($q$update branch_transfers set status = 'recibido'$q$, 'update directo');
  perform pg_temp.must_fail($q$delete from branch_min_stock$q$, 'delete directo');
end $$;

reset role;
rollback;
