-- Pruebas de la migración 171 (Despiece: quitar una res que vino de una compra). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values ('00000000-0000-0000-0000-0000000c1701', 'Quitar res', 9811, 'full');
insert into branches (id, company_id, name) values ('00000000-0000-0000-0000-0000000c1702', '00000000-0000-0000-0000-0000000c1701', 'Única');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000c1703', 'duenio@quitar');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c1703', '00000000-0000-0000-0000-0000000c1701', '00000000-0000-0000-0000-0000000c1702', 'Dueño', 'owner');
insert into suppliers (id, company_id, name) values ('00000000-0000-0000-0000-0000000c1704', '00000000-0000-0000-0000-0000000c1701', 'Frigorífico');

-- Compra 1: solo una media res. Compra 2: media res + otro producto.
insert into purchases (id, company_id, branch_id, supplier_id, purchase_date, total, status, created_by) values
  ('00000000-0000-0000-0000-0000000c1711', '00000000-0000-0000-0000-0000000c1701', '00000000-0000-0000-0000-0000000c1702', '00000000-0000-0000-0000-0000000c1704', current_date, 500000, 'active', '00000000-0000-0000-0000-0000000c1703'),
  ('00000000-0000-0000-0000-0000000c1712', '00000000-0000-0000-0000-0000000c1701', '00000000-0000-0000-0000-0000000c1702', '00000000-0000-0000-0000-0000000c1704', current_date, 600000, 'active', '00000000-0000-0000-0000-0000000c1703');
insert into purchase_items (id, purchase_id, description, quantity, unit, unit_price, line_total, carcass_animal_type, carcass_weight) values
  ('00000000-0000-0000-0000-0000000c1721', '00000000-0000-0000-0000-0000000c1711', 'Media res', 1, 'unit', 500000, 500000, 'Vaca / media res', 110),
  ('00000000-0000-0000-0000-0000000c1722', '00000000-0000-0000-0000-0000000c1712', 'Media res', 1, 'unit', 500000, 500000, 'Vaca / media res', 110);
insert into purchase_items (purchase_id, description, quantity, unit, unit_price, line_total) values
  ('00000000-0000-0000-0000-0000000c1712', 'Otra cosa', 1, 'unit', 100000, 100000);
select public.carcass_batch_from_purchase_item('00000000-0000-0000-0000-0000000c1721', '00000000-0000-0000-0000-0000000c1703');
select public.carcass_batch_from_purchase_item('00000000-0000-0000-0000-0000000c1722', '00000000-0000-0000-0000-0000000c1703');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1703', true);
select public.delete_carcass_batch((select id from carcass_batches where purchase_item_id = '00000000-0000-0000-0000-0000000c1721'));
do $$
begin
  begin
    perform public.delete_carcass_batch((select id from carcass_batches where purchase_item_id = '00000000-0000-0000-0000-0000000c1722'));
    raise exception 'anuló una compra con otros productos';
  exception when raise_exception then
    if sqlerrm = 'anuló una compra con otros productos' then raise; end if;
  end;
end $$;
reset role;

do $$
begin
  if exists (select 1 from carcass_batches where purchase_item_id = '00000000-0000-0000-0000-0000000c1721') then
    raise exception 'la res de la compra 1 sigue en Despiece';
  end if;
  if (select status from purchases where id = '00000000-0000-0000-0000-0000000c1711') <> 'voided' then
    raise exception 'la compra 1 no quedó anulada';
  end if;
  if not exists (select 1 from carcass_batches where purchase_item_id = '00000000-0000-0000-0000-0000000c1722') then
    raise exception 'se borró la res de la compra con otros productos';
  end if;
  if (select status from purchases where id = '00000000-0000-0000-0000-0000000c1712') <> 'active' then
    raise exception 'se anuló la compra con otros productos';
  end if;
end $$;

rollback;
