-- Pruebas de la migración 193 (precio mayorista en todos los planes). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values ('00000000-0000-0000-0000-0000000193c1', 'Estándar', 9931, 'estandar');
insert into branches (id, company_id, name) values ('00000000-0000-0000-0000-0000000193b1', '00000000-0000-0000-0000-0000000193c1', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000193a1', 'dueno@std'), ('00000000-0000-0000-0000-0000000193a2', 'cajera@std');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000193a1', '00000000-0000-0000-0000-0000000193c1', '00000000-0000-0000-0000-0000000193b1', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000193a2', '00000000-0000-0000-0000-0000000193c1', '00000000-0000-0000-0000-0000000193b1', 'Cajera', 'cashier');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-000000193101', '00000000-0000-0000-0000-0000000193c1', '5', 'Pechuga', 'kg', 5000, 6900),
  ('00000000-0000-0000-0000-000000193102', '00000000-0000-0000-0000-0000000193c1', '12', 'Alitas', 'kg', 2000, 3200);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000193a1', true);

do $$
declare v_list uuid; v numeric;
begin
  -- Plan Estándar: la lista "Mayorista" se crea (antes pedía plan Full), en 0% = sin precio escrito se cobra el normal.
  v_list := public.save_price_list(null, 'Mayorista', 'retail', 0, true);
  perform public.set_product_list_prices(jsonb_build_array(jsonb_build_object(
    'product_id', '00000000-0000-0000-0000-000000193101', 'list_id', v_list, 'price', 6200)));
  select price into v from product_list_prices_view where product_id = '00000000-0000-0000-0000-000000193101' and list_id = v_list;
  if v <> 6200 then raise exception 'precio escrito: esperaba 6200, dio %', v; end if;
  select price into v from product_list_prices_view where product_id = '00000000-0000-0000-0000-000000193102' and list_id = v_list;
  if v <> 3200 then raise exception 'sin precio escrito: esperaba el normal 3200, dio %', v; end if;
end
$$;

-- La cajera sigue sin poder crear listas.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000193a2', true);
do $$
begin
  begin
    perform public.save_price_list(null, 'Otra', 'retail', 0, true);
    raise exception 'la cajera creó una lista';
  exception when others then
    if sqlerrm = 'la cajera creó una lista' then raise; end if;
  end;
end
$$;

rollback;
