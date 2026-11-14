-- Pruebas de la migración 198 (punto de venta y domicilio por local en todos los planes). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values ('00000000-0000-0000-0000-0000000198c1', 'Estándar 198', 9981, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000198b1', '00000000-0000-0000-0000-0000000198c1', 'Centro'),
  ('00000000-0000-0000-0000-0000000198b2', '00000000-0000-0000-0000-0000000198c1', 'Barrio');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000198a1', 'dueno@198'), ('00000000-0000-0000-0000-0000000198a2', 'cajera@198');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000198a1', '00000000-0000-0000-0000-0000000198c1', '00000000-0000-0000-0000-0000000198b1', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000198a2', '00000000-0000-0000-0000-0000000198c1', '00000000-0000-0000-0000-0000000198b2', 'Cajera', 'cashier');

set local role authenticated;

-- Plan Estándar: el dueño le pone a "Barrio" su punto de venta 3 y su domicilio.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000198a1', true);
do $$
begin
  perform public.save_branch_fiscal_settings('00000000-0000-0000-0000-0000000198b2', 3, 'San Martín 450');
  if (select point_of_sale from branch_fiscal_settings where branch_id = '00000000-0000-0000-0000-0000000198b2') <> 3 then
    raise exception 'no guardó el punto de venta de Barrio';
  end if;
end $$;

-- La cajera no puede cambiarlo.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000198a2', true);
do $$
begin
  begin
    perform public.save_branch_fiscal_settings('00000000-0000-0000-0000-0000000198b2', 4, 'Otra 1');
    raise exception 'la cajera cambió el punto de venta';
  exception when others then
    if sqlerrm = 'la cajera cambió el punto de venta' then raise; end if;
  end;
end $$;

reset role;

-- La factura de Barrio sale con su punto de venta y domicilio; la de Centro, con los generales.
insert into invoices (id, company_id, branch_id, kind, letter, voucher_type, point_of_sale, customer_doc_type, customer_tax_condition, total, net) values
  ('00000000-0000-0000-0000-000000019801', '00000000-0000-0000-0000-0000000198c1', '00000000-0000-0000-0000-0000000198b2', 'factura', 'B', 6, 1, 99, 'consumidor_final', 1000, 826.45),
  ('00000000-0000-0000-0000-000000019802', '00000000-0000-0000-0000-0000000198c1', '00000000-0000-0000-0000-0000000198b1', 'factura', 'B', 6, 1, 99, 'consumidor_final', 1000, 826.45);
do $$
begin
  if (select point_of_sale from invoices where id = '00000000-0000-0000-0000-000000019801') <> 3 then raise exception 'Barrio no usó su punto de venta'; end if;
  if (select issuer_address from invoices where id = '00000000-0000-0000-0000-000000019801') <> 'San Martín 450' then raise exception 'Barrio sin su domicilio'; end if;
  if (select point_of_sale from invoices where id = '00000000-0000-0000-0000-000000019802') <> 1 then raise exception 'Centro cambió de punto de venta'; end if;
  if (select issuer_address from invoices where id = '00000000-0000-0000-0000-000000019802') is not null then raise exception 'Centro con domicilio propio'; end if;
  if exists (select 1 from pg_proc where proname in ('save_branch_fiscal_settings', 'invoices_branch_fiscal') and prosrc like '%''empresa''%') then
    raise exception 'todavía pide plan Empresa';
  end if;
end $$;

rollback;
