-- Pruebas de la migración 178 (las funciones sensibles controlan el rol). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c7801', 'Roles', 9781, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7802', '00000000-0000-0000-0000-0000000c7801', 'Centro');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c7803', 'duenio@roles'),
  ('00000000-0000-0000-0000-0000000c7804', 'cajera@roles'),
  ('00000000-0000-0000-0000-0000000c7805', 'encargado@roles');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c7803', '00000000-0000-0000-0000-0000000c7801', '00000000-0000-0000-0000-0000000c7802', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000c7804', '00000000-0000-0000-0000-0000000c7801', '00000000-0000-0000-0000-0000000c7802', 'Cajera', 'cashier'),
  ('00000000-0000-0000-0000-0000000c7805', '00000000-0000-0000-0000-0000000c7801', '00000000-0000-0000-0000-0000000c7802', 'Encargado', 'manager');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c7806', '00000000-0000-0000-0000-0000000c7801', '1', 'Vacío', 'kg', 9000, 15000);
insert into treasury_accounts (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7807', '00000000-0000-0000-0000-0000000c7801', 'Caja');

-- Las 13 funciones tienen el control de rol.
do $$
declare v text;
begin
  select string_agg(n, ', ') into v
  from unnest(array['adjust_treasury_account', 'transfer_treasury_funds', 'update_product', 'set_product_active', 'delete_product',
                    'set_products_vat_rate', 'adjust_product_stock', 'void_purchase', 'update_purchase_item',
                    'update_customer_payment', 'delete_customer_payment', 'update_customer_charge', 'delete_customer_charge']) n
  where not exists (select 1 from pg_proc p where p.proname = n and p.prosrc like '%public.require_role(%');
  if v is not null then raise exception 'sin control de rol: %', v; end if;
end $$;

-- Cajera: ni ajusta el saldo de una cuenta ni ajusta stock.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7804', true);
do $$
begin
  begin
    perform public.adjust_treasury_account('00000000-0000-0000-0000-0000000c7807', '00000000-0000-0000-0000-0000000c7802', 1000, 'in', 'x');
    raise exception 'la cajera ajustó el saldo';
  exception when others then
    if sqlerrm = 'la cajera ajustó el saldo' then raise; end if;
  end;
  begin
    perform public.adjust_product_stock('00000000-0000-0000-0000-0000000c7802', '00000000-0000-0000-0000-0000000c7806', 999, 'x');
    raise exception 'la cajera ajustó el stock';
  exception when others then
    if sqlerrm = 'la cajera ajustó el stock' then raise; end if;
  end;
end $$;

-- Encargado: ajusta stock.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7805', true);
do $$
begin
  perform public.adjust_product_stock('00000000-0000-0000-0000-0000000c7802', '00000000-0000-0000-0000-0000000c7806', 10, 'conteo');
end $$;

-- Dueño: ajusta el saldo.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7803', true);
do $$
begin
  perform public.adjust_treasury_account('00000000-0000-0000-0000-0000000c7807', '00000000-0000-0000-0000-0000000c7802', 1000, 'in', 'saldo inicial');
end $$;

rollback;
