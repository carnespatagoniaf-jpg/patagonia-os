-- Pruebas de la migración 196 (Pedidos para tienda: el dueño carga pedidos y los cobra en Mostrador). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- A: Pedidos + pedidos_tienda. B: solo Pedidos (como todas las carnicerías hoy). C: otra empresa con todo.
insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c9601', 'Tienda', 9961, 'estandar', '{pedidos,pedidos_tienda,sin_carniceria}'),
  ('00000000-0000-0000-0000-0000000c9611', 'Carniceria', 9962, 'estandar', '{pedidos}'),
  ('00000000-0000-0000-0000-0000000c9621', 'Otra tienda', 9963, 'estandar', '{pedidos,pedidos_tienda}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c9602', '00000000-0000-0000-0000-0000000c9601', 'Casa'),
  ('00000000-0000-0000-0000-0000000c9612', '00000000-0000-0000-0000-0000000c9611', 'Local'),
  ('00000000-0000-0000-0000-0000000c9622', '00000000-0000-0000-0000-0000000c9621', 'Casa');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c9603', 'duenio@tienda'), ('00000000-0000-0000-0000-0000000c9604', 'lectura@tienda'),
  ('00000000-0000-0000-0000-0000000c9613', 'duenio@carniceria'), ('00000000-0000-0000-0000-0000000c9623', 'duenio@otra');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c9603', '00000000-0000-0000-0000-0000000c9601', '00000000-0000-0000-0000-0000000c9602', 'Dueño tienda', 'owner'),
  ('00000000-0000-0000-0000-0000000c9604', '00000000-0000-0000-0000-0000000c9601', '00000000-0000-0000-0000-0000000c9602', 'Lectura', 'readonly'),
  ('00000000-0000-0000-0000-0000000c9613', '00000000-0000-0000-0000-0000000c9611', '00000000-0000-0000-0000-0000000c9612', 'Dueño carnicería', 'owner'),
  ('00000000-0000-0000-0000-0000000c9623', '00000000-0000-0000-0000-0000000c9621', '00000000-0000-0000-0000-0000000c9622', 'Dueño otra', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c9605', '00000000-0000-0000-0000-0000000c9601', '1-1', 'Mate imperial - Negro', 'unit', 9000, 25000),
  ('00000000-0000-0000-0000-0000000c9615', '00000000-0000-0000-0000-0000000c9611', '1', 'Asado', 'kg', 9000, 15000);
-- Ventas de Mostrador (las crea create_pos_sale; acá alcanza con la fila).
insert into pos_sales (id, company_id, branch_id, total, created_by) values
  ('00000000-0000-0000-0000-0000000c9606', '00000000-0000-0000-0000-0000000c9601', '00000000-0000-0000-0000-0000000c9602', 25000, '00000000-0000-0000-0000-0000000c9603'),
  ('00000000-0000-0000-0000-0000000c9626', '00000000-0000-0000-0000-0000000c9621', '00000000-0000-0000-0000-0000000c9622', 25000, '00000000-0000-0000-0000-0000000c9623');

set local role authenticated;

-- El dueño de la tienda carga un pedido, lo ve, y lo cobra.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9603', true);
do $$
declare v uuid;
begin
  v := public.save_customer_order(null, '00000000-0000-0000-0000-0000000c9602', null, 'Juana', '2944 000000',
    date '2026-12-24', null, 'Retira en la casa', 25000, 0,
    '[{"product_id":"00000000-0000-0000-0000-0000000c9605","quantity":1}]'::jsonb);
  perform set_config('test.order', v::text, false);

  if (select count(*) from public.customer_orders where id = v) <> 1 then raise exception 'el dueño no ve su pedido'; end if;

  -- Una venta de otra empresa: no.
  begin
    perform public.deliver_customer_order(v, '00000000-0000-0000-0000-0000000c9626');
    raise exception 'aceptó una venta de otra empresa';
  exception when raise_exception then
    if sqlerrm = 'aceptó una venta de otra empresa' then raise; end if;
  end;

  if public.deliver_customer_order(v, '00000000-0000-0000-0000-0000000c9606') <> 'entregado' then raise exception 'no quedó entregado'; end if;
  if (select pos_sale_id from public.customer_orders where id = v) <> '00000000-0000-0000-0000-0000000c9606' then
    raise exception 'no guardó la venta';
  end if;
  -- Otra vez (doble clic / reintento): no falla.
  perform public.deliver_customer_order(v, '00000000-0000-0000-0000-0000000c9606');
end $$;

-- Solo lectura de la tienda: no los ve ni los cobra.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9604', true);
do $$
begin
  if (select count(*) from public.customer_orders) <> 0 then raise exception 'solo lectura ve pedidos'; end if;
  begin
    perform public.deliver_customer_order(current_setting('test.order')::uuid, null);
    raise exception 'solo lectura cobró';
  exception when raise_exception then
    if sqlerrm = 'solo lectura cobró' then raise; end if;
  end;
end $$;

-- Dueño de otra tienda: no ve el pedido de la primera.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9623', true);
do $$
begin
  if (select count(*) from public.customer_orders) <> 0 then raise exception 'otra empresa ve pedidos'; end if;
  begin
    perform public.deliver_customer_order(current_setting('test.order')::uuid, null);
    raise exception 'otra empresa cobró';
  exception when raise_exception then
    if sqlerrm = 'otra empresa cobró' then raise; end if;
  end;
end $$;

-- Carnicería con solo Pedidos: el dueño sigue sin poder cargar (como en 187).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9613', true);
do $$
begin
  begin
    perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c9612', null, 'X', null, date '2026-12-24', null, null, null, 0,
      '[{"product_id":"00000000-0000-0000-0000-0000000c9615","quantity":1}]'::jsonb);
    raise exception 'el dueño de la carnicería cargó un pedido';
  exception when raise_exception then
    if sqlerrm = 'el dueño de la carnicería cargó un pedido' then raise; end if;
  end;
end $$;

reset role;
rollback;
