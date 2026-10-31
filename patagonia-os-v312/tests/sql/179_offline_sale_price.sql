-- Pruebas de la migración 179 (venta sin internet con el precio de antes). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c7901', 'Offline', 9791, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7902', '00000000-0000-0000-0000-0000000c7901', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c7903', 'duenio@offline');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c7903', '00000000-0000-0000-0000-0000000c7901', '00000000-0000-0000-0000-0000000c7902', 'Dueño', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c7904', '00000000-0000-0000-0000-0000000c7901', '1', 'Vacío', 'kg', 9000, 15000);
insert into treasury_accounts (id, company_id, name, payment_method) values
  ('00000000-0000-0000-0000-0000000c7905', '00000000-0000-0000-0000-0000000c7901', 'Efectivo', 'cash');

-- El cambio de precio queda en el historial.
update products set price_retail = 16000 where id = '00000000-0000-0000-0000-0000000c7904';
do $$
begin
  if not exists (select 1 from product_price_history where product_id = '00000000-0000-0000-0000-0000000c7904' and old_price = 15000 and new_price = 16000) then
    raise exception 'el cambio de precio no quedó en el historial';
  end if;
  -- Sin las listas de precios inyectadas (base de prueba vacía) la venta queda como antes: no hay nada más que probar.
  if not exists (select 1 from pg_proc where proname = 'create_pos_sale' and prosrc like '%pos_charged_unit_price%') then
    raise notice '179: create_pos_sale sin la inyección en esta base';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7903', true);

do $$
declare r jsonb; v_shift uuid;
begin
  if not exists (select 1 from pg_proc where proname = 'create_pos_sale' and prosrc like '%pos_charged_unit_price%') then return; end if;
  r := public.open_pos_shift('00000000-0000-0000-0000-0000000c7902', 0);
  v_shift := (r ->> 'id')::uuid;
  -- Vendida sin internet con el precio de antes: entra con ese precio.
  r := public.create_pos_sale('00000000-0000-0000-0000-0000000c7902',
    '[{"product_id":"00000000-0000-0000-0000-0000000c7904","quantity":1,"charged_unit_price":15000}]'::jsonb,
    '[{"account_id":"00000000-0000-0000-0000-0000000c7905","amount":15000}]'::jsonb, v_shift, 0, 0, gen_random_uuid());
  if (r ->> 'total')::numeric <> 15000 then raise exception 'no aceptó el precio de antes: %', r; end if;
  -- Un precio que el producto nunca tuvo se ignora: se cobra el actual y los pagos no cierran.
  begin
    r := public.create_pos_sale('00000000-0000-0000-0000-0000000c7902',
      '[{"product_id":"00000000-0000-0000-0000-0000000c7904","quantity":1,"charged_unit_price":1}]'::jsonb,
      '[{"account_id":"00000000-0000-0000-0000-0000000c7905","amount":1}]'::jsonb, v_shift, 0, 0, gen_random_uuid());
    raise exception 'aceptó un precio inventado';
  exception when others then
    if sqlerrm = 'aceptó un precio inventado' then raise; end if;
  end;
end $$;

rollback;
