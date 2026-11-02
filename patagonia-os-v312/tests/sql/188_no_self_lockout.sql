-- Pruebas de la migración 188 (nadie se saca permisos a sí mismo). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c8801', 'Sin autoencierro', 9881, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c8802', '00000000-0000-0000-0000-0000000c8801', 'Centro'),
  ('00000000-0000-0000-0000-0000000c8803', '00000000-0000-0000-0000-0000000c8801', 'Norte');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c8804', 'admin@a'), ('00000000-0000-0000-0000-0000000c8805', 'cajera@a');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c8804', '00000000-0000-0000-0000-0000000c8801', '00000000-0000-0000-0000-0000000c8802', 'Admin', 'admin'),
  ('00000000-0000-0000-0000-0000000c8805', '00000000-0000-0000-0000-0000000c8801', '00000000-0000-0000-0000-0000000c8802', 'Cajera', 'cashier');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c8804', true);

do $$
begin
  -- A sí mismo: nombre y sucursal sí.
  perform public.update_staff_user('00000000-0000-0000-0000-0000000c8804', 'Admin Nuevo', 'admin', '00000000-0000-0000-0000-0000000c8803', true, '{}');
  -- El propio rol no.
  begin
    perform public.update_staff_user('00000000-0000-0000-0000-0000000c8804', 'Admin', 'cashier', '00000000-0000-0000-0000-0000000c8802', true, '{}');
    raise exception 'se cambió su propio rol';
  exception when raise_exception then
    if sqlerrm = 'se cambió su propio rol' then raise; end if;
  end;
  -- Sacarse pantallas a sí mismo no.
  begin
    perform public.update_staff_user('00000000-0000-0000-0000-0000000c8804', 'Admin', 'admin', '00000000-0000-0000-0000-0000000c8802', true, '{users.manage}');
    raise exception 'se sacó pantallas a sí mismo';
  exception when raise_exception then
    if sqlerrm = 'se sacó pantallas a sí mismo' then raise; end if;
  end;
  -- A otra persona, todo como siempre.
  perform public.update_staff_user('00000000-0000-0000-0000-0000000c8805', 'Cajera', 'manager', '00000000-0000-0000-0000-0000000c8803', true, '{reports.view}');
end $$;

reset role;
do $$
begin
  if (select role || '|' || full_name from profiles where id = '00000000-0000-0000-0000-0000000c8804') <> 'admin|Admin Nuevo' then
    raise exception 'el admin quedó mal';
  end if;
  if (select role from profiles where id = '00000000-0000-0000-0000-0000000c8805') <> 'manager' then
    raise exception 'no se pudo editar a otra persona';
  end if;
end $$;

rollback;
