-- Pruebas de la migración 191 (encargado de varios locales, empleados que rotan, facturación por local). Se deshace.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c9101', 'Cadena 191', 9911, 'empresa', '{pedidos}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c910a', '00000000-0000-0000-0000-0000000c9101', 'Chacabuco'),
  ('00000000-0000-0000-0000-0000000c910b', '00000000-0000-0000-0000-0000000c9101', 'Cañada'),
  ('00000000-0000-0000-0000-0000000c910c', '00000000-0000-0000-0000-0000000c9101', 'Trejo');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c9105', 'duenio@191'), ('00000000-0000-0000-0000-0000000c9106', 'juan@191'),
  ('00000000-0000-0000-0000-0000000c9107', 'admin@191');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c9105', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910a', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000c9106', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910a', 'Juan', 'manager'),
  ('00000000-0000-0000-0000-0000000c9107', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910a', 'Admin', 'admin');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c9108', '00000000-0000-0000-0000-0000000c9101', '1', 'Asado', 'kg', 9000, 15000);
insert into employees (id, company_id, branch_id, full_name) values
  ('00000000-0000-0000-0000-0000000c9109', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910a', 'Lucía');
insert into employee_pos_pins (employee_id, company_id, pin_hash) values
  ('00000000-0000-0000-0000-0000000c9109', '00000000-0000-0000-0000-0000000c9101', extensions.crypt('1234', extensions.gen_salt('bf')));

-- Antes de sumarle locales: Lucía solo tiene PIN en Chacabuco.
do $$
begin
  if public.pos_cashier_required('00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910b') then
    raise exception 'Cañada pide PIN sin cajeros propios';
  end if;
end $$;

set local role authenticated;

-- 1. El dueño le da a Juan Cañada (además de Chacabuco); a sí mismo / al administrador no se le asignan.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9105', true);
do $$
begin
  perform public.set_profile_branches('00000000-0000-0000-0000-0000000c9106',
    array['00000000-0000-0000-0000-0000000c910b', '00000000-0000-0000-0000-0000000c910a']::uuid[]);
  if (select count(*) from profile_branches where profile_id = '00000000-0000-0000-0000-0000000c9106') <> 1 then
    raise exception 'el local principal no va en profile_branches';
  end if;
  begin
    perform public.set_profile_branches('00000000-0000-0000-0000-0000000c9107', array['00000000-0000-0000-0000-0000000c910b']::uuid[]);
    raise exception 'le asignó locales al administrador';
  exception when raise_exception then
    if sqlerrm = 'le asignó locales al administrador' then raise; end if;
  end;
  perform public.set_employee_branches('00000000-0000-0000-0000-0000000c9109', array['00000000-0000-0000-0000-0000000c910b']::uuid[]);
  perform public.save_branch_fiscal_settings('00000000-0000-0000-0000-0000000c910b', 5, 'Av. Cañada 77');
  begin
    perform public.save_branch_fiscal_settings('00000000-0000-0000-0000-0000000c910c', 6, '');
    raise exception 'guardó un punto de venta sin domicilio';
  exception when raise_exception then
    if sqlerrm = 'guardó un punto de venta sin domicilio' then raise; end if;
  end;
end $$;

-- 2. Juan actúa por Chacabuco y Cañada, no por Trejo; no puede asignar locales.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9106', true);
do $$
begin
  if not public.my_branch_allowed('00000000-0000-0000-0000-0000000c910a') then raise exception 'su local principal'; end if;
  if not public.my_branch_allowed('00000000-0000-0000-0000-0000000c910b') then raise exception 'el local a cargo'; end if;
  if public.my_branch_allowed('00000000-0000-0000-0000-0000000c910c') then raise exception 'un local ajeno'; end if;

  -- Pide mercadería para Cañada (antes de la 191 solo podía para Chacabuco); para Trejo, no.
  perform public.request_branch_transfer('00000000-0000-0000-0000-0000000c910c', '00000000-0000-0000-0000-0000000c910b', null, null,
    '[{"product_id":"00000000-0000-0000-0000-0000000c9108","quantity":3}]');
  begin
    perform public.request_branch_transfer('00000000-0000-0000-0000-0000000c910a', '00000000-0000-0000-0000-0000000c910c', null, null,
      '[{"product_id":"00000000-0000-0000-0000-0000000c9108","quantity":3}]');
    raise exception 'pidió para un local ajeno';
  exception when raise_exception then
    if sqlerrm = 'pidió para un local ajeno' then raise; end if;
  end;

  -- Pedidos de clientes en Cañada, sí; en Trejo, no.
  perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c910b', null, 'Cliente', null, date '2026-12-24', null, null, null, 0,
    '[{"product_id":"00000000-0000-0000-0000-0000000c9108","quantity":1}]'::jsonb);
  if (select count(*) from customer_orders) <> 1 then raise exception 'no ve el pedido de Cañada'; end if;
  begin
    perform public.save_customer_order(null, '00000000-0000-0000-0000-0000000c910c', null, 'Cliente', null, date '2026-12-24', null, null, null, 0,
      '[{"product_id":"00000000-0000-0000-0000-0000000c9108","quantity":1}]'::jsonb);
    raise exception 'cargó un pedido en un local ajeno';
  exception when raise_exception then
    if sqlerrm = 'cargó un pedido en un local ajeno' then raise; end if;
  end;

  -- Lucía aparece para abrir caja en Cañada.
  if not exists (select 1 from public.list_pos_cashiers('00000000-0000-0000-0000-0000000c910b')) then raise exception 'Lucía no aparece en Cañada'; end if;
  if exists (select 1 from public.list_pos_cashiers('00000000-0000-0000-0000-0000000c910c')) then raise exception 'Lucía aparece en Trejo'; end if;

  begin
    perform public.set_profile_branches('00000000-0000-0000-0000-0000000c9106', array['00000000-0000-0000-0000-0000000c910c']::uuid[]);
    raise exception 'el encargado se asignó locales';
  exception when raise_exception then
    if sqlerrm = 'el encargado se asignó locales' then raise; end if;
  end;
end $$;

reset role;

-- 3. PIN de Lucía en Cañada sí, en Trejo no; Cañada ahora pide PIN.
do $$
begin
  perform public.pos_verify_cashier('00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910b', '00000000-0000-0000-0000-0000000c9109', '1234');
  if not public.pos_cashier_required('00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910b') then
    raise exception 'Cañada no pide PIN';
  end if;
  begin
    perform public.pos_verify_cashier('00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910c', '00000000-0000-0000-0000-0000000c9109', '1234');
    raise exception 'el PIN valió en Trejo';
  exception when raise_exception then
    if sqlerrm = 'el PIN valió en Trejo' then raise; end if;
  end;
end $$;

-- 4. Factura de Cañada: su punto de venta y domicilio; de Chacabuco: los generales. La nota de crédito copia el domicilio.
insert into invoices (id, company_id, branch_id, kind, letter, voucher_type, point_of_sale, customer_doc_type, customer_tax_condition, total, net) values
  ('00000000-0000-0000-0000-0000000c9110', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910b', 'factura', 'B', 6, 1, 99, 'consumidor_final', 1000, 826.45),
  ('00000000-0000-0000-0000-0000000c9111', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910a', 'factura', 'B', 6, 1, 99, 'consumidor_final', 1000, 826.45);
insert into invoices (id, company_id, branch_id, kind, letter, voucher_type, point_of_sale, customer_doc_type, customer_tax_condition, total, net, related_invoice_id) values
  ('00000000-0000-0000-0000-0000000c9112', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910b', 'nota_credito', 'B', 8, 5, 99, 'consumidor_final', 1000, 826.45, '00000000-0000-0000-0000-0000000c9110');
do $$
begin
  if (select point_of_sale from invoices where id = '00000000-0000-0000-0000-0000000c9110') <> 5 then raise exception 'punto de venta del local'; end if;
  if (select issuer_address from invoices where id = '00000000-0000-0000-0000-0000000c9110') <> 'Av. Cañada 77' then raise exception 'domicilio del local'; end if;
  if (select point_of_sale from invoices where id = '00000000-0000-0000-0000-0000000c9111') <> 1 then raise exception 'Chacabuco cambió de punto de venta'; end if;
  if (select issuer_address from invoices where id = '00000000-0000-0000-0000-0000000c9111') is not null then raise exception 'Chacabuco con domicilio propio'; end if;
  if (select issuer_address from invoices where id = '00000000-0000-0000-0000-0000000c9112') <> 'Av. Cañada 77' then raise exception 'la nota de crédito sin domicilio'; end if;
end $$;

-- 5. Dónde trabajó Lucía.
insert into pos_shifts (id, company_id, branch_id, status, opened_by, cashier_employee_id) values
  ('00000000-0000-0000-0000-0000000c9120', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910b', 'closed', '00000000-0000-0000-0000-0000000c9105', '00000000-0000-0000-0000-0000000c9109');
insert into pos_sales (company_id, branch_id, total, created_by, pos_shift_id) values
  ('00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910b', 5000, '00000000-0000-0000-0000-0000000c9105', '00000000-0000-0000-0000-0000000c9120');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9105', true);
do $$
declare r record;
begin
  select * into r from public.employee_branch_activity('00000000-0000-0000-0000-0000000c9109', public.today_ar() - 30, public.today_ar());
  if r.branch_id <> '00000000-0000-0000-0000-0000000c910b' or r.shifts <> 1 or r.sales_total <> 5000 then raise exception 'actividad: %', r; end if;
end $$;
reset role;

-- 6. Si la empresa baja a Full, lo de Empresa deja de valer (sin borrar nada).
update companies set plan = 'full' where id = '00000000-0000-0000-0000-0000000c9101';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9106', true);
do $$
begin
  if public.my_branch_allowed('00000000-0000-0000-0000-0000000c910b') then raise exception 'con Full sigue a cargo de Cañada'; end if;
  if not public.my_branch_allowed('00000000-0000-0000-0000-0000000c910a') then raise exception 'con Full perdió su local'; end if;
end $$;
reset role;
insert into invoices (id, company_id, branch_id, kind, letter, voucher_type, point_of_sale, customer_doc_type, customer_tax_condition, total, net) values
  ('00000000-0000-0000-0000-0000000c9113', '00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c910b', 'factura', 'B', 6, 1, 99, 'consumidor_final', 1000, 826.45);
do $$
begin
  if (select point_of_sale from invoices where id = '00000000-0000-0000-0000-0000000c9113') <> 1 then raise exception 'con Full usó el punto del local'; end if;
end $$;

rollback;
