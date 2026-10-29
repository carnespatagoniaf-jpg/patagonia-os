-- Pruebas de la migración 170 (Despiece: costo parejo por kilo a elección). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- Dos carnicerías con la misma media: A como siempre (por valor), B con 'costo_parejo'.
insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-00000000aa01', 'Por valor', 9801, 'full', '{}'),
  ('00000000-0000-0000-0000-00000000bb01', 'La cosa es con carne (prueba)', 9802, 'full', '{costo_parejo}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa01', 'A'),
  ('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-00000000bb01', 'B');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000aa01', '1', 'Asado', 'kg', 0, 10000),
  ('00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-00000000aa01', '2', 'Vacío', 'kg', 0, 12000),
  ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-00000000bb01', '1', 'Asado', 'kg', 0, 10000),
  ('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-00000000bb01', '2', 'Vacío', 'kg', 0, 12000),
  ('00000000-0000-0000-0000-0000000b0003', '00000000-0000-0000-0000-00000000bb01', '3', 'Hueso', 'kg', 100, 0);

-- Media de 50 kg pagada $500.000: asado 20 kg, vacío 20 kg, hueso 10 kg (sin precio = merma).
insert into carcass_batches (id, company_id, branch_id, batch_date, animal_type, total_weight, total_cost) values
  ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa02', current_date, 'Vaca / media res', 50, 500000),
  ('00000000-0000-0000-0000-00000000bb03', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000bb02', current_date, 'Vaca / media res', 50, 500000);
insert into carcass_cuts (batch_id, cut_name, weight, unit_price, product_id) values
  ('00000000-0000-0000-0000-00000000aa03', 'Asado', 20, 10000, '00000000-0000-0000-0000-0000000a0001'),
  ('00000000-0000-0000-0000-00000000aa03', 'Vacío', 20, 12000, '00000000-0000-0000-0000-0000000a0002'),
  ('00000000-0000-0000-0000-00000000aa03', 'Hueso', 10, 0, null),
  ('00000000-0000-0000-0000-00000000bb03', 'Asado', 20, 10000, '00000000-0000-0000-0000-0000000b0001'),
  ('00000000-0000-0000-0000-00000000bb03', 'Vacío', 20, 12000, '00000000-0000-0000-0000-0000000b0002'),
  ('00000000-0000-0000-0000-00000000bb03', 'Hueso', 10, 0, '00000000-0000-0000-0000-0000000b0003');

do $$
declare v numeric;
begin
  -- A (por valor, como siempre): 500.000 × 200.000/440.000 / 20 kg = 11.363,64 ; vacío 13.636,36.
  select cost into v from products where id = '00000000-0000-0000-0000-0000000a0001';
  if v <> 11363.64 then raise exception 'por valor, asado: esperaba 11363.64, dio %', v; end if;
  select cost into v from products where id = '00000000-0000-0000-0000-0000000a0002';
  if v <> 13636.36 then raise exception 'por valor, vacío: esperaba 13636.36, dio %', v; end if;
  -- B (costo parejo): 500.000 / 40 kg vendibles = 12.500 para los dos.
  select cost into v from products where id = '00000000-0000-0000-0000-0000000b0001';
  if v <> 12500 then raise exception 'parejo, asado: esperaba 12500, dio %', v; end if;
  select cost into v from products where id = '00000000-0000-0000-0000-0000000b0002';
  if v <> 12500 then raise exception 'parejo, vacío: esperaba 12500, dio %', v; end if;
  -- El hueso (sin precio) no le borra el costo que ya tenía.
  select cost into v from products where id = '00000000-0000-0000-0000-0000000b0003';
  if v <> 100 then raise exception 'parejo, hueso: no tenía que tocarse, dio %', v; end if;
end $$;

-- El botón "Actualizar costos en Stock": dueño sí, cajera no, otra empresa no.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000bb04', 'duenio@b'), ('00000000-0000-0000-0000-00000000bb05', 'cajera@b');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-00000000bb04', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000bb02', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-00000000bb05', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000bb02', 'Cajera', 'cashier');
update products set cost = 1 where id = '00000000-0000-0000-0000-0000000b0001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000bb04', true);
select public.apply_carcass_costs('00000000-0000-0000-0000-00000000bb03');
do $$
begin
  begin
    perform public.apply_carcass_costs('00000000-0000-0000-0000-00000000aa03');
    raise exception 'actualizó una res de otra empresa';
  exception when raise_exception then
    if sqlerrm = 'actualizó una res de otra empresa' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000bb05', true);
do $$
begin
  begin
    perform public.apply_carcass_costs('00000000-0000-0000-0000-00000000bb03');
    raise exception 'la cajera actualizó costos';
  exception when raise_exception then
    if sqlerrm = 'la cajera actualizó costos' then raise; end if;
  end;
end $$;
reset role;
do $$
declare v numeric;
begin
  select cost into v from products where id = '00000000-0000-0000-0000-0000000b0001';
  if v <> 12500 then raise exception 'el botón no recalculó: dio %', v; end if;
end $$;

rollback;
