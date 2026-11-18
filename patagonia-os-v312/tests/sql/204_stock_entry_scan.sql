-- Pruebas de la migración 204 (Ingreso de stock por escaneo). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c2401', 'Frigorifico 204', 9941, 'basico', '{paquetes,etiquetas_caja}'),
  ('00000000-0000-0000-0000-0000000c2411', 'Otra 204', 9942, 'basico', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c2402', '00000000-0000-0000-0000-0000000c2401', 'Local'),
  ('00000000-0000-0000-0000-0000000c2412', '00000000-0000-0000-0000-0000000c2411', 'Local');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c2403', 'admin@204'), ('00000000-0000-0000-0000-0000000c2404', 'caja@204'),
  ('00000000-0000-0000-0000-0000000c2413', 'admin@otra204');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c2403', '00000000-0000-0000-0000-0000000c2401', '00000000-0000-0000-0000-0000000c2402', 'Admin', 'admin'),
  ('00000000-0000-0000-0000-0000000c2404', '00000000-0000-0000-0000-0000000c2401', '00000000-0000-0000-0000-0000000c2402', 'Caja', 'cashier'),
  ('00000000-0000-0000-0000-0000000c2413', '00000000-0000-0000-0000-0000000c2411', '00000000-0000-0000-0000-0000000c2412', 'Admin', 'admin');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c2405', '00000000-0000-0000-0000-0000000c2401', '1', 'MATAMBRE (CAJA)', 'kg', 0, 16900),
  ('00000000-0000-0000-0000-0000000c2406', '00000000-0000-0000-0000-0000000c2401', '5', 'PALETA (CAJA)', 'kg', 0, 12000),
  ('00000000-0000-0000-0000-0000000c2407', '00000000-0000-0000-0000-0000000c2401', '226', 'HUESOS', 'unit', 0, 100),
  ('00000000-0000-0000-0000-0000000c2415', '00000000-0000-0000-0000-0000000c2411', '1', 'Ajeno', 'kg', 0, 100);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2403', true);

-- 2 cajas de matambre + 1 de paleta escaneadas + 3 huesos a mano.
do $$
declare r jsonb;
begin
  r := public.register_stock_entry('00000000-0000-0000-0000-0000000c2402', jsonb_build_array(
    jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000c2405', 'quantity', 21.70, 'code', '0105012721704', 'box', true),
    jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000c2405', 'quantity', 19.76, 'code', '0111012719764', 'box', true),
    jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000c2406', 'quantity', 20.70, 'code', '0511012720701', 'box', true),
    jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000c2407', 'quantity', 3)
  ), 'Remito 123');
  if (r->>'lines')::int <> 4 or (r->>'boxes')::int <> 3 or (r->>'kg')::numeric <> 62.16 then raise exception 'resumen mal: %', r; end if;
  perform set_config('test.entry', r->>'id', false);
end $$;

reset role;
do $$
begin
  if (select sum(quantity) from inventory_movements where product_id = '00000000-0000-0000-0000-0000000c2405') <> 41.46 then raise exception 'kilos de matambre mal'; end if;
  if (select sum(quantity) from inventory_movements where product_id = '00000000-0000-0000-0000-0000000c2407') <> 3 then raise exception 'huesos mal'; end if;
  if (select sum(delta) from product_package_moves where product_id = '00000000-0000-0000-0000-0000000c2405') <> 2 then raise exception 'cajas de matambre mal'; end if;
  if exists (select 1 from product_package_moves where product_id = '00000000-0000-0000-0000-0000000c2407') then raise exception 'los huesos no son cajas'; end if;
  if not (select track_packages from products where id = '00000000-0000-0000-0000-0000000c2406') then raise exception 'paleta no empezó a contar cajas'; end if;
end $$;

set local role authenticated;
-- Errores: producto de otra empresa, unidad con decimales, cajero, lista vacía.
do $$
begin
  begin
    perform public.register_stock_entry('00000000-0000-0000-0000-0000000c2402', jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000c2415', 'quantity', 1)));
    raise exception 'aceptó un producto ajeno';
  exception when others then if sqlerrm not like 'Producto inválido%' then raise; end if; end;
  begin
    perform public.register_stock_entry('00000000-0000-0000-0000-0000000c2402', jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000c2407', 'quantity', 1.5)));
    raise exception 'aceptó 1,5 huesos';
  exception when others then if sqlerrm not like '%entera%' then raise; end if; end;
  begin
    perform public.register_stock_entry('00000000-0000-0000-0000-0000000c2402', '[]'::jsonb);
    raise exception 'aceptó una lista vacía';
  exception when others then if sqlerrm not like 'No hay nada%' then raise; end if; end;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2404', true);
do $$
begin
  perform public.register_stock_entry('00000000-0000-0000-0000-0000000c2402', jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-0000-0000-0000000c2405', 'quantity', 1)));
  raise exception 'un cajero ingresó stock';
exception when others then if sqlerrm not like 'No tenés permiso%' then raise; end if;
end $$;

-- La otra empresa no ve el ingreso.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2413', true);
do $$
begin
  if exists (select 1 from public.stock_entries) or exists (select 1 from public.stock_entry_items) then raise exception 'otra empresa ve el ingreso'; end if;
end $$;

-- Deshacer: vuelve todo a cero y no se puede dos veces.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2403', true);
select public.undo_stock_entry(current_setting('test.entry')::uuid);
reset role;
do $$
begin
  if (select sum(quantity) from inventory_movements where product_id in ('00000000-0000-0000-0000-0000000c2405', '00000000-0000-0000-0000-0000000c2406', '00000000-0000-0000-0000-0000000c2407')) <> 0 then raise exception 'deshacer no dejó los kilos en cero'; end if;
  if (select sum(delta) from product_package_moves where product_id in ('00000000-0000-0000-0000-0000000c2405', '00000000-0000-0000-0000-0000000c2406')) <> 0 then raise exception 'deshacer no sacó las cajas'; end if;
end $$;
set local role authenticated;
do $$
begin
  perform public.undo_stock_entry(current_setting('test.entry')::uuid);
  raise exception 'se deshizo dos veces';
exception when others then if sqlerrm not like '%ya se deshizo%' then raise; end if;
end $$;

rollback;
