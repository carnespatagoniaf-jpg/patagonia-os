-- Pruebas de la migración 174 (importar no pisa costo/precio/mínimo con 0). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c7401', 'Importa', 9741, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7402', '00000000-0000-0000-0000-0000000c7401', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c7403', 'duenio@importa');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c7403', '00000000-0000-0000-0000-0000000c7401', '00000000-0000-0000-0000-0000000c7402', 'Dueño', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail, min_stock) values
  ('00000000-0000-0000-0000-0000000c7404', '00000000-0000-0000-0000-0000000c7401', '10', 'Vacío', 'kg', 9000, 15000, 5),
  ('00000000-0000-0000-0000-0000000c7405', '00000000-0000-0000-0000-0000000c7401', '11', 'Vacío oferta', 'kg', 0, 14000, 0);
update products set stock_source_id = '00000000-0000-0000-0000-0000000c7404', stock_factor = 1
  where id = '00000000-0000-0000-0000-0000000c7405';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7403', true);

do $$
declare r jsonb; p record;
begin
  -- Archivo con solo código, nombre y precio (sin columna de costo ni mínimo): el costo NO se pierde.
  set local role authenticated;
  r := public.import_products('00000000-0000-0000-0000-0000000c7402',
    '[{"row":1,"code":"10","name":"Vacío novillo","price_retail":16000,"cost":null,"min_stock":null}]'::jsonb, true);
  -- Desde la 175 (y antes para products) el usuario no lee las tablas directo: se comprueba como postgres.
  reset role;
  select cost, price_retail, min_stock, name into p from products where id = '00000000-0000-0000-0000-0000000c7404';
  if p.cost <> 9000 then raise exception 'se perdió el costo: %', p.cost; end if;
  if p.price_retail <> 16000 then raise exception 'no actualizó el precio: %', p.price_retail; end if;
  if p.min_stock <> 5 then raise exception 'se perdió el mínimo: %', p.min_stock; end if;
  if p.name <> 'Vacío novillo' then raise exception 'no actualizó el nombre: %', p.name; end if;

  -- Un valor que sí viene se actualiza.
  set local role authenticated;
  r := public.import_products('00000000-0000-0000-0000-0000000c7402',
    '[{"row":1,"code":"10","name":"Vacío novillo","cost":9500}]'::jsonb, true);
  -- Desde la 175 (y antes para products) el usuario no lee las tablas directo: se comprueba como postgres.
  reset role;
  select cost, price_retail into p from products where id = '00000000-0000-0000-0000-0000000c7404';
  if p.cost <> 9500 or p.price_retail <> 16000 then raise exception 'costo %, precio %', p.cost, p.price_retail; end if;

  -- Producto nuevo sin precio ni costo: arranca en 0 (como antes).
  set local role authenticated;
  r := public.import_products('00000000-0000-0000-0000-0000000c7402',
    '[{"row":1,"code":"12","name":"Chorizo"}]'::jsonb, false);
  -- Desde la 175 (y antes para products) el usuario no lee las tablas directo: se comprueba como postgres.
  reset role;
  select cost, price_retail, min_stock into p from products where company_id = '00000000-0000-0000-0000-0000000c7401' and code = '12';
  if p.cost <> 0 or p.price_retail <> 0 or p.min_stock <> 0 then raise exception 'nuevo: %', p; end if;

  -- Stock de una presentación: se saltea en vez de abortar todo el archivo; el principal sí se carga.
  set local role authenticated;
  r := public.import_products('00000000-0000-0000-0000-0000000c7402',
    '[{"row":1,"code":"10","name":"Vacío novillo","stock":20},{"row":2,"code":"11","name":"Vacío oferta","stock":7}]'::jsonb, true);
  -- Desde la 175 (y antes para products) el usuario no lee las tablas directo: se comprueba como postgres.
  reset role;
  if (r ->> 'stock_adjusted')::int <> 1 then raise exception 'stock ajustado: %', r; end if;
  if (select coalesce(sum(quantity), 0) from inventory_movements where product_id = '00000000-0000-0000-0000-0000000c7404') <> 20 then
    raise exception 'stock del principal mal';
  end if;
end $$;

rollback;
