-- Pruebas de la migración 201 ("Paquetes" con etiquetas de cajas: solo las cajas restan). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- A: Carplat (paquetes + etiquetas de cajas). B: como M2 (solo paquetes).
insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c2101', 'Frigorifico', 9993, 'basico', '{paquetes,etiquetas_caja}'),
  ('00000000-0000-0000-0000-0000000c2111', 'Como M2', 9994, 'basico', '{paquetes}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c2102', '00000000-0000-0000-0000-0000000c2101', 'Local'),
  ('00000000-0000-0000-0000-0000000c2112', '00000000-0000-0000-0000-0000000c2111', 'Local');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c2103', 'admin@frigo201'), ('00000000-0000-0000-0000-0000000c2113', 'admin@m2-201');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c2103', '00000000-0000-0000-0000-0000000c2101', '00000000-0000-0000-0000-0000000c2102', 'Admin', 'admin'),
  ('00000000-0000-0000-0000-0000000c2113', '00000000-0000-0000-0000-0000000c2111', '00000000-0000-0000-0000-0000000c2112', 'Admin', 'admin');
insert into products (id, company_id, code, name, unit, cost, price_retail, track_packages) values
  ('00000000-0000-0000-0000-0000000c2104', '00000000-0000-0000-0000-0000000c2101', '219', 'ROAST BEEF (KG)', 'kg', 0, 14300, true),
  ('00000000-0000-0000-0000-0000000c2114', '00000000-0000-0000-0000-0000000c2111', '1', 'Vacio envasado', 'kg', 0, 15000, true);
insert into pos_sales (id, company_id, branch_id, total, created_by) values
  ('00000000-0000-0000-0000-0000000c2105', '00000000-0000-0000-0000-0000000c2101', '00000000-0000-0000-0000-0000000c2102', 1, '00000000-0000-0000-0000-0000000c2103'),
  ('00000000-0000-0000-0000-0000000c2115', '00000000-0000-0000-0000-0000000c2111', '00000000-0000-0000-0000-0000000c2112', 1, '00000000-0000-0000-0000-0000000c2113');

-- Carplat: 2 cajas + 1 renglón suelto a mano + 1 etiqueta de balanza (scale_tickets 1) del mismo corte.
insert into pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total, scale_ticket) values
  ('00000000-0000-0000-0000-0000000c2105', '00000000-0000-0000-0000-0000000c2104', 17.32, 14300, 0, 247676, 'CAJA-0711012717328'),
  ('00000000-0000-0000-0000-0000000c2105', '00000000-0000-0000-0000-0000000c2104', 19.76, 14300, 0, 282568, 'CAJA-0111012719764'),
  ('00000000-0000-0000-0000-0000000c2105', '00000000-0000-0000-0000-0000000c2104', 1.5, 14300, 0, 21450, null);
insert into pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total, scale_tickets) values
  ('00000000-0000-0000-0000-0000000c2105', '00000000-0000-0000-0000-0000000c2104', 0.8, 14300, 0, 11440, 1);
-- Como M2: igual que en 157 (renglón por kilo = 1; etiqueta = sus tickets).
insert into pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total) values
  ('00000000-0000-0000-0000-0000000c2115', '00000000-0000-0000-0000-0000000c2114', 1.2, 15000, 0, 18000);
insert into pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total, scale_tickets) values
  ('00000000-0000-0000-0000-0000000c2115', '00000000-0000-0000-0000-0000000c2114', 0.9, 15000, 0, 13500, 2);

do $$
declare a int; b int;
begin
  select coalesce(sum(delta), 0) into a from public.product_package_moves where product_id = '00000000-0000-0000-0000-0000000c2104';
  select coalesce(sum(delta), 0) into b from public.product_package_moves where product_id = '00000000-0000-0000-0000-0000000c2114';
  if a <> -2 then raise exception 'Carplat: restó % (tenían que ser solo las 2 cajas)', a; end if;
  if b <> -3 then raise exception 'Como M2: restó % (tenía que ser 1 + 2, como en 157)', b; end if;
end $$;

-- Anular la venta de Carplat devuelve las 2 cajas.
update pos_sales set voided_at = now(), voided_by = '00000000-0000-0000-0000-0000000c2103' where id = '00000000-0000-0000-0000-0000000c2105';
do $$
begin
  if (select sum(delta) from public.product_package_moves where product_id = '00000000-0000-0000-0000-0000000c2104') <> 0 then
    raise exception 'anular no devolvió las cajas';
  end if;
end $$;

rollback;
