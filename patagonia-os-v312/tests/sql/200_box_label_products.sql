-- Pruebas de la migración 200 (número de caja → producto). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c2001', 'Frigorifico', 9991, 'basico', '{etiquetas_caja}'),
  ('00000000-0000-0000-0000-0000000c2011', 'Otra', 9992, 'full', '{etiquetas_caja}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c2002', '00000000-0000-0000-0000-0000000c2001', 'Planta'),
  ('00000000-0000-0000-0000-0000000c2012', '00000000-0000-0000-0000-0000000c2011', 'Local');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c2003', 'admin@frigo200'), ('00000000-0000-0000-0000-0000000c2004', 'cajero@frigo200'),
  ('00000000-0000-0000-0000-0000000c2013', 'duenio@otra200');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c2003', '00000000-0000-0000-0000-0000000c2001', '00000000-0000-0000-0000-0000000c2002', 'Admin', 'admin'),
  ('00000000-0000-0000-0000-0000000c2004', '00000000-0000-0000-0000-0000000c2001', '00000000-0000-0000-0000-0000000c2002', 'Cajero', 'cashier'),
  ('00000000-0000-0000-0000-0000000c2013', '00000000-0000-0000-0000-0000000c2011', '00000000-0000-0000-0000-0000000c2012', 'Dueño otra', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c2005', '00000000-0000-0000-0000-0000000c2001', '219', 'ROAST BEEF (KG)', 'kg', 0, 14300),
  ('00000000-0000-0000-0000-0000000c2006', '00000000-0000-0000-0000-0000000c2001', '61', 'MATAMBRE (ENVASADO)', 'kg', 0, 17500),
  ('00000000-0000-0000-0000-0000000c2015', '00000000-0000-0000-0000-0000000c2011', '219', 'Otro roast beef', 'kg', 0, 1);

set local role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2003', true);
do $$
declare v uuid; m jsonb;
begin
  v := public.save_box_label_format(null, 'Carplat', 13, 0, 2, 2, '', 8, 4, 100);
  perform set_config('test.fmt', v::text, false);
  if (select product_map from public.box_label_formats where id = v) <> '{}'::jsonb then raise exception 'arranca con algo'; end if;

  m := public.set_box_label_product(v, '07', '00000000-0000-0000-0000-0000000c2005');
  m := public.set_box_label_product(v, '01', '00000000-0000-0000-0000-0000000c2006');
  if m <> '{"07": "00000000-0000-0000-0000-0000000c2005", "01": "00000000-0000-0000-0000-0000000c2006"}'::jsonb then
    raise exception 'mapa inesperado: %', m;
  end if;
  -- "7" es la misma caja que "07": reemplaza, no duplica.
  m := public.set_box_label_product(v, '7', '00000000-0000-0000-0000-0000000c2006');
  if m ? '07' or (m->>'7') <> '00000000-0000-0000-0000-0000000c2006' then raise exception 'no reemplazó 07 por 7: %', m; end if;
  -- Soltar.
  m := public.set_box_label_product(v, '01', null);
  if m ? '01' then raise exception 'no soltó el 01'; end if;
  if (select count(*) from public.audit_log where entity_id = v::text and action = 'box_label_format.product') <> 4 then raise exception 'falta auditoría'; end if;

  -- Producto de otra empresa o número raro: no.
  begin
    perform public.set_box_label_product(v, '15', '00000000-0000-0000-0000-0000000c2015');
    raise exception 'aceptó un producto de otra empresa';
  exception when raise_exception then
    if sqlerrm = 'aceptó un producto de otra empresa' then raise; end if;
  end;
  begin
    perform public.set_box_label_product(v, '1a', '00000000-0000-0000-0000-0000000c2005');
    raise exception 'aceptó un número raro';
  exception when raise_exception then
    if sqlerrm = 'aceptó un número raro' then raise; end if;
  end;
end $$;

-- El cajero no asocia; otra empresa no toca el formato.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2004', true);
do $$
begin
  begin
    perform public.set_box_label_product(current_setting('test.fmt')::uuid, '15', '00000000-0000-0000-0000-0000000c2005');
    raise exception 'el cajero asoció';
  exception when raise_exception then
    if sqlerrm = 'el cajero asoció' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2013', true);
do $$
begin
  begin
    perform public.set_box_label_product(current_setting('test.fmt')::uuid, '15', '00000000-0000-0000-0000-0000000c2015');
    raise exception 'otra empresa asoció';
  exception when raise_exception then
    if sqlerrm = 'otra empresa asoció' then raise; end if;
  end;
end $$;

rollback;
