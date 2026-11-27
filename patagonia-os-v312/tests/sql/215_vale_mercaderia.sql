-- Pruebas de la migración 215 (vale de mercadería desde Mostrador). Se deshace.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000e2151', 'Carnicería 215', 99216, 'full'),
  ('00000000-0000-0000-0000-0000000e2152', 'Otra 215', 99217, 'full');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000e215a', '00000000-0000-0000-0000-0000000e2151', 'Centro'),
  ('00000000-0000-0000-0000-0000000e215f', '00000000-0000-0000-0000-0000000e2152', 'Única');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e2155', 'duenio@215'), ('00000000-0000-0000-0000-0000000e2156', 'cajera@215'),
  ('00000000-0000-0000-0000-0000000e2158', 'otro@215');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000e2155', '00000000-0000-0000-0000-0000000e2151', '00000000-0000-0000-0000-0000000e215a', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000e2156', '00000000-0000-0000-0000-0000000e2151', '00000000-0000-0000-0000-0000000e215a', 'Cajera', 'cashier'),
  ('00000000-0000-0000-0000-0000000e2158', '00000000-0000-0000-0000-0000000e2152', '00000000-0000-0000-0000-0000000e215f', 'Otro', 'owner');
insert into employees (id, company_id, branch_id, full_name, base_salary, salary_period, active) values
  ('00000000-0000-0000-0000-0000000e2160', '00000000-0000-0000-0000-0000000e2151', '00000000-0000-0000-0000-0000000e215a', 'Lucas', 900000, 'monthly', true),
  ('00000000-0000-0000-0000-0000000e2161', '00000000-0000-0000-0000-0000000e2151', '00000000-0000-0000-0000-0000000e215a', 'Valeria', 900000, 'monthly', true),
  ('00000000-0000-0000-0000-0000000e2162', '00000000-0000-0000-0000-0000000e2152', '00000000-0000-0000-0000-0000000e215f', 'Ajeno', 900000, 'monthly', true);
insert into employee_pos_pins (employee_id, company_id, pin_hash) values
  ('00000000-0000-0000-0000-0000000e2161', '00000000-0000-0000-0000-0000000e2151', extensions.crypt('4321', extensions.gen_salt('bf')));
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000e2170', '00000000-0000-0000-0000-0000000e2151', '1', 'Asado', 'kg', 9000, 16500),
  ('00000000-0000-0000-0000-0000000e2171', '00000000-0000-0000-0000-0000000e2151', '50', 'Hamburguesa x4', 'unit', 900, 1500),
  ('00000000-0000-0000-0000-0000000e2172', '00000000-0000-0000-0000-0000000e2151', '9', 'Sin precio', 'kg', 900, 0);
insert into inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reason) values
  ('00000000-0000-0000-0000-0000000e2151', '00000000-0000-0000-0000-0000000e215a', '00000000-0000-0000-0000-0000000e2170', 'adjustment', 20, 'inicial'),
  ('00000000-0000-0000-0000-0000000e2151', '00000000-0000-0000-0000-0000000e215a', '00000000-0000-0000-0000-0000000e2171', 'adjustment', 10, 'inicial');
insert into pos_shifts (id, company_id, branch_id, status, opened_by) values
  ('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2151', '00000000-0000-0000-0000-0000000e215a', 'open', '00000000-0000-0000-0000-0000000e2156');

create function pg_temp.stock(p_product text) returns numeric language sql as $$
  select coalesce(sum(quantity), 0) from public.inventory_movements
  where branch_id = '00000000-0000-0000-0000-0000000e215a' and product_id = ('00000000-0000-0000-0000-0000000e21' || p_product)::uuid
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
grant execute on function pg_temp.stock(text) to authenticated;
grant execute on function pg_temp.must_fail(text, text) to authenticated;

set local role authenticated;

-- 1. La cajera le da a Lucas (sin PIN) 1,25 kg de asado y 2 hamburguesas, sin descuento.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2156', true);
do $$
declare r jsonb; v_treasury int;
begin
  select count(*) into v_treasury from public.treasury_movements where company_id = '00000000-0000-0000-0000-0000000e2151';
  r := public.register_employee_merchandise_vale('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2160',
    '[{"product_id":"00000000-0000-0000-0000-0000000e2170","quantity":1.25},{"product_id":"00000000-0000-0000-0000-0000000e2171","quantity":2}]');
  -- 1,25 × 16.500 = 20.625 + 2 × 1.500 = 3.000 → 23.625
  if (r->>'amount')::numeric <> 23625 or (r->>'lines')::int <> 2 then raise exception 'vale: %', r; end if;
  if pg_temp.stock('70') <> 18.75 or pg_temp.stock('71') <> 8 then raise exception 'stock: % %', pg_temp.stock('70'), pg_temp.stock('71'); end if;
  if (select count(*) from public.treasury_movements where company_id = '00000000-0000-0000-0000-0000000e2151') <> v_treasury then
    raise exception 'el vale de mercadería tocó Tesorería';
  end if;
  if (select type || '|' || amount || '|' || detail from public.pos_shift_outflows where id = (r->>'id')::uuid)
     <> 'vale_mercaderia|23625.00|Mercadería: Asado, Hamburguesa x4' then
    raise exception 'outflow: %', (select row_to_json(o) from public.pos_shift_outflows o where id = (r->>'id')::uuid);
  end if;
  if (select count(*) from public.pos_shift_outflow_items where outflow_id = (r->>'id')::uuid) <> 2 then raise exception 'renglones'; end if;
end $$;

-- 2. Valeria tiene PIN: sin PIN o con el equivocado no; con el suyo sí.
select pg_temp.must_fail($q$select public.register_employee_merchandise_vale('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2161', '[{"product_id":"00000000-0000-0000-0000-0000000e2170","quantity":1}]')$q$, 'sin PIN');
select pg_temp.must_fail($q$select public.register_employee_merchandise_vale('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2161', '[{"product_id":"00000000-0000-0000-0000-0000000e2170","quantity":1}]', '1111')$q$, 'PIN malo');
-- Producto sin precio, unidad partida, empleado de otra empresa, vacío.
select pg_temp.must_fail($q$select public.register_employee_merchandise_vale('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2160', '[{"product_id":"00000000-0000-0000-0000-0000000e2172","quantity":1}]')$q$, 'sin precio');
select pg_temp.must_fail($q$select public.register_employee_merchandise_vale('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2160', '[{"product_id":"00000000-0000-0000-0000-0000000e2171","quantity":1.5}]')$q$, 'unidad partida');
select pg_temp.must_fail($q$select public.register_employee_merchandise_vale('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2162', '[{"product_id":"00000000-0000-0000-0000-0000000e2170","quantity":1}]')$q$, 'empleado ajeno');
select pg_temp.must_fail($q$select public.register_employee_merchandise_vale('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2160', '[]')$q$, 'vacío');
-- La cajera no puede poner el descuento.
select pg_temp.must_fail($q$select public.set_employee_discount(20)$q$, 'cajera pone descuento');

-- 3. El dueño pone 20 % de descuento; Valeria con su PIN: 1 kg de asado = 16.500 − 20 % = 13.200.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2155', true);
select pg_temp.must_fail($q$select public.set_employee_discount(60)$q$, 'descuento > 50');
do $$
declare r jsonb;
begin
  if public.set_employee_discount(20) <> 20 then raise exception 'descuento'; end if;
  r := public.register_employee_merchandise_vale('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2161',
    '[{"product_id":"00000000-0000-0000-0000-0000000e2170","quantity":1}]', '4321', 'para el asado del domingo');
  if (r->>'amount')::numeric <> 13200 or (r->>'discount_pct')::numeric <> 20 then raise exception 'con descuento: %', r; end if;
  if (select detail from public.pos_shift_outflows where id = (r->>'id')::uuid) <> 'para el asado del domingo' then raise exception 'detalle'; end if;
  if pg_temp.stock('70') <> 17.75 then raise exception 'stock 2'; end if;
end $$;

-- 4. Otra empresa no ve los renglones.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2158', true);
do $$
begin
  if exists (select 1 from public.pos_shift_outflow_items) then raise exception 'otra empresa ve los renglones'; end if;
end $$;
select pg_temp.must_fail($q$insert into public.pos_shift_outflow_items (outflow_id, company_id, product_id, quantity, unit_price, line_total) select id, company_id, '00000000-0000-0000-0000-0000000e2170', 1, 1, 1 from public.pos_shift_outflows limit 1$q$, 'escribir la tabla');

-- 5. Borrar el vale de Lucas (como lo hace Mostrador) devuelve el stock.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2155', true);
do $$
declare v_id uuid; r jsonb;
begin
  select id into v_id from public.pos_shift_outflows where employee_id = '00000000-0000-0000-0000-0000000e2160';
  r := public.delete_pos_shift_outflow(v_id, null);
  if not coalesce((r->>'ok')::boolean, false) then raise exception 'borrar: %', r; end if;
  if pg_temp.stock('70') <> 19 or pg_temp.stock('71') <> 10 then raise exception 'no devolvió el stock: % %', pg_temp.stock('70'), pg_temp.stock('71'); end if;
end $$;

-- 6. Un vale de plata (066) se sigue borrando sin tocar stock.
reset role;
do $$
declare v_before numeric := (select sum(quantity) from public.inventory_movements where company_id = '00000000-0000-0000-0000-0000000e2151');
begin
  insert into public.pos_shift_outflows (pos_shift_id, company_id, branch_id, outflow_date, type, amount, detail, employee_id)
  values ('00000000-0000-0000-0000-0000000e2180', '00000000-0000-0000-0000-0000000e2151', '00000000-0000-0000-0000-0000000e215a', current_date, 'vale_adelanto', 5000, 'x', '00000000-0000-0000-0000-0000000e2160');
  delete from public.pos_shift_outflows where type = 'vale_adelanto';
  if (select sum(quantity) from public.inventory_movements where company_id = '00000000-0000-0000-0000-0000000e2151') <> v_before then raise exception 'vale de plata tocó stock'; end if;
end $$;

select 'OK 215' as resultado;
rollback;
