-- Pruebas de la migración 187 (Pedidos de clientes). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- A: con Pedidos, dos sucursales. B: otra empresa con Pedidos. C: empresa sin la pantalla.
insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c8701', 'Con pedidos', 9871, 'full', '{pedidos}'),
  ('00000000-0000-0000-0000-0000000c8711', 'Otra empresa', 9872, 'full', '{pedidos}'),
  ('00000000-0000-0000-0000-0000000c8721', 'Sin pedidos', 9873, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c8702', '00000000-0000-0000-0000-0000000c8701', 'Centro'),
  ('00000000-0000-0000-0000-0000000c8703', '00000000-0000-0000-0000-0000000c8701', 'Norte'),
  ('00000000-0000-0000-0000-0000000c8712', '00000000-0000-0000-0000-0000000c8711', 'Única'),
  ('00000000-0000-0000-0000-0000000c8722', '00000000-0000-0000-0000-0000000c8721', 'Única');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c8704', 'duenio@a'), ('00000000-0000-0000-0000-0000000c8705', 'cajera-centro@a'),
  ('00000000-0000-0000-0000-0000000c8706', 'cajera-norte@a'), ('00000000-0000-0000-0000-0000000c8707', 'lectura@a'),
  ('00000000-0000-0000-0000-0000000c8714', 'duenio@b'), ('00000000-0000-0000-0000-0000000c8724', 'duenio@c');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c8704', '00000000-0000-0000-0000-0000000c8701', '00000000-0000-0000-0000-0000000c8702', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000c8705', '00000000-0000-0000-0000-0000000c8701', '00000000-0000-0000-0000-0000000c8702', 'Cajera Centro', 'cashier'),
  ('00000000-0000-0000-0000-0000000c8706', '00000000-0000-0000-0000-0000000c8701', '00000000-0000-0000-0000-0000000c8703', 'Cajera Norte', 'cashier'),
  ('00000000-0000-0000-0000-0000000c8707', '00000000-0000-0000-0000-0000000c8701', '00000000-0000-0000-0000-0000000c8702', 'Lectura', 'readonly'),
  ('00000000-0000-0000-0000-0000000c8714', '00000000-0000-0000-0000-0000000c8711', '00000000-0000-0000-0000-0000000c8712', 'Dueño B', 'owner'),
  ('00000000-0000-0000-0000-0000000c8724', '00000000-0000-0000-0000-0000000c8721', '00000000-0000-0000-0000-0000000c8722', 'Dueño C', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c8708', '00000000-0000-0000-0000-0000000c8701', '1', 'Asado', 'kg', 9000, 15000),
  ('00000000-0000-0000-0000-0000000c8709', '00000000-0000-0000-0000-0000000c8701', '2', 'Morcilla', 'unit', 900, 1500),
  ('00000000-0000-0000-0000-0000000c8718', '00000000-0000-0000-0000-0000000c8711', '1', 'Asado B', 'kg', 9000, 15000);

-- Lo que NO se puede tocar: se cuenta antes y después.
create temp table antes as
  select (select count(*) from inventory_movements) as mov, (select count(*) from treasury_movements) as tes,
         (select count(*) from pos_shifts) as turnos, (select count(*) from pos_sales) as ventas;
grant select on antes to authenticated;

set local role authenticated;

-- Cajera del Centro carga un pedido en su sucursal.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8705', true);
do $$
declare v uuid;
begin
  v := public.save_customer_order(null, '00000000-0000-0000-0000-0000000c8702', null, '  Juan  Pérez ', '2944 123456',
    date '2026-12-24', time '11:00', 'Asado en tiras', 50000, 10000,
    '[{"product_id":"00000000-0000-0000-0000-0000000c8708","quantity":2.5,"notes":"en tiras"},
      {"product_id":"00000000-0000-0000-0000-0000000c8709","quantity":3}]'::jsonb);
  perform set_config('test.order', v::text, false);

  -- En otra sucursal: no.
  begin
    perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c8703', null, 'X', null, date '2026-12-24', null, null, null, 0,
      '[{"product_id":"00000000-0000-0000-0000-0000000c8708","quantity":1}]'::jsonb);
    raise exception 'la cajera cargó en otra sucursal';
  exception when raise_exception then
    if sqlerrm = 'la cajera cargó en otra sucursal' then raise; end if;
  end;
  -- Sin productos, sin nombre, seña mayor que el total, producto de otra empresa: no.
  begin
    perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c8702', null, 'X', null, date '2026-12-24', null, null, null, 0, '[]'::jsonb);
    raise exception 'guardó sin productos';
  exception when raise_exception then
    if sqlerrm = 'guardó sin productos' then raise; end if;
  end;
  begin
    perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c8702', null, '  ', null, date '2026-12-24', null, null, null, 0,
      '[{"product_id":"00000000-0000-0000-0000-0000000c8708","quantity":1}]'::jsonb);
    raise exception 'guardó sin nombre';
  exception when raise_exception then
    if sqlerrm = 'guardó sin nombre' then raise; end if;
  end;
  begin
    perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c8702', null, 'X', null, date '2026-12-24', null, null, 1000, 2000,
      '[{"product_id":"00000000-0000-0000-0000-0000000c8708","quantity":1}]'::jsonb);
    raise exception 'seña mayor que el total';
  exception when raise_exception then
    if sqlerrm = 'seña mayor que el total' then raise; end if;
  end;
  begin
    perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c8702', null, 'X', null, date '2026-12-24', null, null, null, 0,
      '[{"product_id":"00000000-0000-0000-0000-0000000c8718","quantity":1}]'::jsonb);
    raise exception 'usó un producto de otra empresa';
  exception when raise_exception then
    if sqlerrm = 'usó un producto de otra empresa' then raise; end if;
  end;
end $$;

-- Escribir directo en la tabla: no (todo por RPC, migración 175).
do $$
begin
  begin
    insert into customer_orders (company_id, branch_id, customer_name, pickup_date)
    values ('00000000-0000-0000-0000-0000000c8701', '00000000-0000-0000-0000-0000000c8702', 'Directo', current_date);
    raise exception 'escribió directo';
  exception when insufficient_privilege then null;
  end;
end $$;

do $$
declare o record; n integer;
begin
  select * into o from customer_orders where id = current_setting('test.order')::uuid;
  if o.customer_name <> 'Juan Pérez' or o.status <> 'pendiente' or o.total <> 50000 or o.deposit <> 10000 then
    raise exception 'pedido mal guardado: %', row_to_json(o);
  end if;
  select count(*) into n from customer_order_items where order_id = o.id;
  if n <> 2 then raise exception 'ítems: %', n; end if;
  if (select unit from customer_order_items where order_id = o.id and position = 1) <> 'unit' then raise exception 'unidad mal copiada'; end if;
end $$;

-- La cajera del Norte no lo ve; solo lectura tampoco; otra empresa no.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8706', true);
do $$
begin
  if exists (select 1 from customer_orders) or exists (select 1 from customer_order_items) then
    raise exception 'la cajera del Norte ve pedidos del Centro';
  end if;
  begin
    perform public.set_customer_order_status(current_setting('test.order')::uuid, 'listo');
    raise exception 'la cajera del Norte cambió un pedido del Centro';
  exception when raise_exception then
    if sqlerrm = 'la cajera del Norte cambió un pedido del Centro' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8707', true);
do $$
begin
  -- Es el cuaderno del local: solo lectura (administración) no lo ve.
  if exists (select 1 from customer_orders) then raise exception 'solo lectura ve los pedidos'; end if;
  begin
    perform public.set_customer_order_status(current_setting('test.order')::uuid, 'listo');
    raise exception 'solo lectura cambió un pedido';
  exception when raise_exception then
    if sqlerrm = 'solo lectura cambió un pedido' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8714', true);
do $$
begin
  if exists (select 1 from customer_orders) or exists (select 1 from customer_order_items) then
    raise exception 'otra empresa ve los pedidos';
  end if;
  begin
    perform public.set_customer_order_status(current_setting('test.order')::uuid, 'cancelado');
    raise exception 'otra empresa canceló un pedido';
  exception when raise_exception then
    if sqlerrm = 'otra empresa canceló un pedido' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8724', true);
do $$
begin
  begin
    perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c8722', null, 'X', null, current_date, null, null, null, 0, '[]'::jsonb);
    raise exception 'empresa sin la pantalla cargó';
  exception when raise_exception then
    if sqlerrm = 'empresa sin la pantalla cargó' then raise; end if;
  end;
end $$;

-- El dueño ve todo, edita, marca listo y entrega; después no se puede editar.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8704', true);
do $$
declare v uuid := current_setting('test.order')::uuid;
begin
  if (select count(*) from customer_orders) <> 1 then raise exception 'el dueño no ve el pedido'; end if;
  perform public.save_customer_order(v, null, null, 'Juan Pérez', null, date '2026-12-24', time '12:30', null, null, 0,
    '[{"product_id":"00000000-0000-0000-0000-0000000c8708","quantity":4}]'::jsonb);
  if (select count(*) from customer_order_items where order_id = v) <> 1 then raise exception 'no reemplazó los ítems'; end if;
  if (select pickup_time from customer_orders where id = v) <> time '12:30' then raise exception 'no editó la hora'; end if;
  perform public.set_customer_order_status(v, 'listo');
  perform public.set_customer_order_status(v, 'entregado');
  begin
    perform public.save_customer_order(v, null, null, 'Otro', null, date '2026-12-24', null, null, null, 0,
      '[{"product_id":"00000000-0000-0000-0000-0000000c8708","quantity":1}]'::jsonb);
    raise exception 'editó un pedido entregado';
  exception when raise_exception then
    if sqlerrm = 'editó un pedido entregado' then raise; end if;
  end;
  begin
    perform public.set_customer_order_status(v, 'cancelado');
    raise exception 'canceló un pedido entregado';
  exception when raise_exception then
    if sqlerrm = 'canceló un pedido entregado' then raise; end if;
  end;
  if (select count(*) from audit_log where entity_type = 'customer_order' and entity_id = v::text) <> 4 then
    raise exception 'auditoría incompleta';
  end if;
end $$;

-- Nada de stock, caja, turnos ni ventas cambió.
reset role;
do $$
declare a record;
begin
  select * into a from antes;
  if (select count(*) from inventory_movements) <> a.mov then raise exception 'cambió el stock'; end if;
  if (select count(*) from treasury_movements) <> a.tes then raise exception 'cambió Tesorería'; end if;
  if (select count(*) from pos_shifts) <> a.turnos then raise exception 'cambió un turno'; end if;
  if (select count(*) from pos_sales) <> a.ventas then raise exception 'cambió una venta'; end if;
end $$;

-- Con la pantalla apagada, el dueño deja de verlos.
update companies set features = '{}' where id = '00000000-0000-0000-0000-0000000c8701';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8704', true);
do $$
begin
  if exists (select 1 from customer_orders) then raise exception 'con la pantalla apagada se ven pedidos'; end if;
end $$;

rollback;
