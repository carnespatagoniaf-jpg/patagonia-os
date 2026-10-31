-- Pruebas de la migración 177 (turno bloqueado al vender, cambiar medio de pago solo dueño/admin). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c7701', 'Caja177', 9771, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7702', '00000000-0000-0000-0000-0000000c7701', 'Centro');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c7703', 'duenio@caja177'),
  ('00000000-0000-0000-0000-0000000c7704', 'cajera@caja177');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c7703', '00000000-0000-0000-0000-0000000c7701', '00000000-0000-0000-0000-0000000c7702', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000c7704', '00000000-0000-0000-0000-0000000c7701', '00000000-0000-0000-0000-0000000c7702', 'Cajera', 'cashier');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-0000000c7705', '00000000-0000-0000-0000-0000000c7701', '1', 'Vacío', 'kg', 9000, 15000);
insert into treasury_accounts (id, company_id, name, payment_method) values
  ('00000000-0000-0000-0000-0000000c7706', '00000000-0000-0000-0000-0000000c7701', 'Efectivo', 'cash'),
  ('00000000-0000-0000-0000-0000000c7707', '00000000-0000-0000-0000-0000000c7701', 'Mercado Pago', 'transfer');

-- La consulta del turno en create_pos_sale ahora lo bloquea (FOR SHARE).
do $$
begin
  if exists (select 1 from pg_proc where proname = 'create_pos_sale' and prosrc not like '%for share%') then
    raise exception 'create_pos_sale no bloquea el turno';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7704', true);

do $$
declare r jsonb; v_shift uuid; v_pay uuid;
begin
  r := public.open_pos_shift('00000000-0000-0000-0000-0000000c7702', 0);
  v_shift := (r ->> 'id')::uuid;
  r := public.create_pos_sale('00000000-0000-0000-0000-0000000c7702',
    '[{"product_id":"00000000-0000-0000-0000-0000000c7705","quantity":1}]'::jsonb,
    '[{"account_id":"00000000-0000-0000-0000-0000000c7706","amount":15000}]'::jsonb, v_shift, 0, 0, gen_random_uuid());
  select psp.id into v_pay from pos_sale_payments psp join pos_sales s on s.id = psp.sale_id where s.pos_shift_id = v_shift;

  -- Una cajera no pasa un cobro en efectivo a otra cuenta.
  begin
    perform public.change_pos_sale_payment_account(v_pay, '00000000-0000-0000-0000-0000000c7707');
    raise exception 'la cajera cambió el medio de pago';
  exception when others then
    if sqlerrm = 'la cajera cambió el medio de pago' then raise; end if;
  end;

  -- Con el turno cerrado, no entra ninguna venta.
  update pos_shifts set status = 'closed', closed_at = now() where id = v_shift;
  begin
    r := public.create_pos_sale('00000000-0000-0000-0000-0000000c7702',
      '[{"product_id":"00000000-0000-0000-0000-0000000c7705","quantity":1}]'::jsonb,
      '[{"account_id":"00000000-0000-0000-0000-0000000c7706","amount":15000}]'::jsonb, v_shift, 0, 0, gen_random_uuid());
    raise exception 'vendió en un turno cerrado';
  exception when others then
    if sqlerrm = 'vendió en un turno cerrado' then raise; end if;
  end;
end $$;

rollback;
