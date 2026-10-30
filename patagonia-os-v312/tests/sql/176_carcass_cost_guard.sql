-- Pruebas de la migración 176 (Despiece: el costo automático no escribe costos imposibles). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c7601', 'Tienda de carnes (prueba)', 9761, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7602', '00000000-0000-0000-0000-0000000c7601', 'Centro');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c7611', '00000000-0000-0000-0000-0000000c7601', '15', 'lomo', 'kg', 8900, 20000),
  ('00000000-0000-0000-0000-0000000c7612', '00000000-0000-0000-0000-0000000c7601', '26', 'tapa de asado', 'kg', 8900, 14000),
  ('00000000-0000-0000-0000-0000000c7613', '00000000-0000-0000-0000-0000000c7601', '30', 'asado', 'kg', 8900, 12000);

-- REAL 30/10: media de 155 kg a $1.395.000; solo unos pocos cortes con precio, el resto sin producto (sin precio).
insert into carcass_batches (id, company_id, branch_id, batch_date, animal_type, total_weight, total_cost) values
  ('00000000-0000-0000-0000-0000000c7621', '00000000-0000-0000-0000-0000000c7601', '00000000-0000-0000-0000-0000000c7602', current_date, 'Vaca / media res', 155, 1395000);
insert into carcass_cuts (batch_id, cut_name, weight, unit_price, product_id) values
  ('00000000-0000-0000-0000-0000000c7621', 'Lomo', 2.79, 20000, '00000000-0000-0000-0000-0000000c7611'),
  ('00000000-0000-0000-0000-0000000c7621', 'Picaña', 1.24, 0, null),
  ('00000000-0000-0000-0000-0000000c7621', 'Asado', 20, 0, null);

do $$
declare v numeric;
begin
  -- Antes de la 176 el lomo quedaba en $308.219/kg. Ahora no se toca.
  select cost into v from products where id = '00000000-0000-0000-0000-0000000c7611';
  if v <> 8900 then raise exception 'lomo: no tenía que cambiar, quedó en %', v; end if;
  select cost into v from products where id = '00000000-0000-0000-0000-0000000c7612';
  if v <> 8900 then raise exception 'tapa de asado: no tenía que cambiar, quedó en %', v; end if;
  if (public.carcass_apply_costs_core('00000000-0000-0000-0000-0000000c7621', null) ->> 'blocked') is null then
    raise exception 'tenía que avisar que faltan precios';
  end if;
end $$;

-- Se completan los precios (el asado se une a su producto): la res vale más de lo que se pagó y se reparte normal.
update carcass_cuts set unit_price = 12000, product_id = '00000000-0000-0000-0000-0000000c7613', weight = 120
  where batch_id = '00000000-0000-0000-0000-0000000c7621' and cut_name = 'Asado';

do $$
declare v numeric;
begin
  -- Con los precios completos la res vale más de lo que se pagó: se reparte normal (cambia) y cada kilo cuesta menos que su precio.
  select cost into v from products where id = '00000000-0000-0000-0000-0000000c7611';
  if v = 8900 then raise exception 'lomo con precios completos: no se repartió'; end if;
  if v >= 20000 then raise exception 'lomo cuesta más que su precio: %', v; end if;
end $$;

-- Se borran casi todos los cortes (real 30/10): lo que queda pesa menos de la mitad de la res. No se toca Stock.
do $$
declare v numeric; antes numeric;
begin
  select cost into antes from products where id = '00000000-0000-0000-0000-0000000c7611';
  delete from carcass_cuts where batch_id = '00000000-0000-0000-0000-0000000c7621' and cut_name = 'Asado';
  select cost into v from products where id = '00000000-0000-0000-0000-0000000c7611';
  if v <> antes then raise exception 'con un solo corte el lomo cambió de % a %', antes, v; end if;
end $$;
insert into carcass_cuts (batch_id, cut_name, weight, unit_price, product_id) values
  ('00000000-0000-0000-0000-0000000c7621', 'Asado', 120, 12000, '00000000-0000-0000-0000-0000000c7613');

-- Una res que se vende algo por debajo de lo pagado (pérdida real, menos de 1,5 veces) se sigue repartiendo.
update carcass_batches set total_cost = 1700000 where id = '00000000-0000-0000-0000-0000000c7621';
do $$
declare v numeric;
begin
  select cost into v from products where id = '00000000-0000-0000-0000-0000000c7613';
  if v <= 12000 then raise exception 'pérdida real: el asado tenía que costar más que su precio, dio %', v; end if;
end $$;

rollback;
