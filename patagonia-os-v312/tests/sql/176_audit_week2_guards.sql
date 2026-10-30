-- Pruebas de la migración 176 (empresa dada de baja, auditoría de cobros, borrar gastos). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c7601', 'Semana2', 9761, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7602', '00000000-0000-0000-0000-0000000c7601', 'Centro');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c7603', 'duenio@semana2'),
  ('00000000-0000-0000-0000-0000000c7604', 'cajera@semana2');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c7603', '00000000-0000-0000-0000-0000000c7601', '00000000-0000-0000-0000-0000000c7602', 'Dueño', 'owner'),
  ('00000000-0000-0000-0000-0000000c7604', '00000000-0000-0000-0000-0000000c7601', '00000000-0000-0000-0000-0000000c7602', 'Cajera', 'cashier');
insert into customers (id, company_id, branch_id, name) values
  ('00000000-0000-0000-0000-0000000c7605', '00000000-0000-0000-0000-0000000c7601', '00000000-0000-0000-0000-0000000c7602', 'Juan');
insert into customer_charges (id, company_id, customer_id, charge_date, amount, reason) values
  ('00000000-0000-0000-0000-0000000c7606', '00000000-0000-0000-0000-0000000c7601', '00000000-0000-0000-0000-0000000c7605', current_date, 5000, 'fiado');
insert into treasury_accounts (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c7607', '00000000-0000-0000-0000-0000000c7601', 'Caja');
insert into treasury_movements (id, company_id, branch_id, account_id, direction, amount, movement_type, occurred_on) values
  ('00000000-0000-0000-0000-0000000c7608', '00000000-0000-0000-0000-0000000c7601', '00000000-0000-0000-0000-0000000c7602',
   '00000000-0000-0000-0000-0000000c7607', 'out', 100, 'gasto', current_date);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7603', true);

do $$
begin
  -- Empresa dada de baja: sin empresa para la base (no lee ni escribe nada).
  if public.current_company_id() is distinct from '00000000-0000-0000-0000-0000000c7601' then raise exception 'activa sin empresa'; end if;
  update companies set active = false where id = '00000000-0000-0000-0000-0000000c7601';
  if public.current_company_id() is not null then raise exception 'dada de baja sigue con acceso'; end if;
  update companies set active = true where id = '00000000-0000-0000-0000-0000000c7601';

  -- Editar y borrar un cargo de cliente queda en Auditoría con el antes.
  update customer_charges set amount = 4000 where id = '00000000-0000-0000-0000-0000000c7606';
  delete from customer_charges where id = '00000000-0000-0000-0000-0000000c7606';
  if (select count(*) from audit_log where entity_id = '00000000-0000-0000-0000-0000000c7606'
        and action in ('customer_charge.update', 'customer_charge.delete')) <> 2 then
    raise exception 'el cargo editado/borrado no quedó en Auditoría';
  end if;
end $$;

-- Una cajera no borra gastos; el dueño sí.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7604', true);
do $$
begin
  perform public.delete_treasury_expense('00000000-0000-0000-0000-0000000c7608');
  raise exception 'la cajera borró un gasto';
exception when others then
  if sqlerrm = 'la cajera borró un gasto' then raise; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c7603', true);
do $$
begin
  perform public.delete_treasury_expense('00000000-0000-0000-0000-0000000c7608');
  if exists (select 1 from treasury_movements where id = '00000000-0000-0000-0000-0000000c7608') then
    raise exception 'el dueño no pudo borrar el gasto';
  end if;
end $$;

rollback;
