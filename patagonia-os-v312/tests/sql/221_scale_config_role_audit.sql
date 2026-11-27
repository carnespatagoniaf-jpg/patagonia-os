-- Pruebas de la migración 221 (formato de etiqueta de la sucursal: rol y auditoría del borrado). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000d2001', 'Carnicería A', 9921, 'estandar'),
  ('00000000-0000-0000-0000-0000000d2011', 'Carnicería B', 9922, 'estandar');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000d2002', '00000000-0000-0000-0000-0000000d2001', 'Centro'),
  ('00000000-0000-0000-0000-0000000d2012', '00000000-0000-0000-0000-0000000d2011', 'Única B');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000d2005', 'duenio@a'), ('00000000-0000-0000-0000-0000000d2006', 'cajera@a'),
  ('00000000-0000-0000-0000-0000000d2007', 'encargado@a'), ('00000000-0000-0000-0000-0000000d2008', 'contador@a'),
  ('00000000-0000-0000-0000-0000000d2009', 'inactiva@a'), ('00000000-0000-0000-0000-0000000d2015', 'duenio@b');
insert into profiles (id, company_id, branch_id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000d2005', '00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d2002', 'Dueño', 'owner', true),
  ('00000000-0000-0000-0000-0000000d2006', '00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d2002', 'Cajera', 'cashier', true),
  ('00000000-0000-0000-0000-0000000d2007', '00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d2002', 'Encargado', 'manager', true),
  ('00000000-0000-0000-0000-0000000d2008', '00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d2002', 'Contador', 'accountant', true),
  ('00000000-0000-0000-0000-0000000d2009', '00000000-0000-0000-0000-0000000d2001', '00000000-0000-0000-0000-0000000d2002', 'Ex cajera', 'cashier', false),
  ('00000000-0000-0000-0000-0000000d2015', '00000000-0000-0000-0000-0000000d2011', '00000000-0000-0000-0000-0000000d2012', 'Dueño B', 'owner', true);

create function pg_temp.must_fail(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return;
  end;
  raise exception 'Tendría que haber fallado: %', p_label;
end $$;
grant execute on function pg_temp.must_fail(text, text) to authenticated;

-- La línea quedó una sola vez al principio de cada función, y el resto de la definición sigue igual.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as f, p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('save_branch_scale_config', 'delete_branch_scale_config') loop
    if (length(r.prosrc) - length(replace(r.prosrc, 'public.require_role(', ''))) / length('public.require_role(') <> 1 then raise exception '% sin require_role (o repetido)', r.f; end if;
    if position('Perfil inválido' in r.prosrc) = 0 then raise exception '% perdió su cuerpo', r.f; end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgname = 'audit_branch_scale_config_delete' and tgrelid = 'public.branch_scale_configs'::regclass) then raise exception 'falta el trigger'; end if;
  if has_function_privilege('authenticated', 'public.audit_branch_scale_config_delete()', 'execute') then raise exception 'la función del trigger quedó abierta'; end if;
end $$;

set local role authenticated;

-- 1. La cajera calibra en el engranaje de Mostrador (uso legítimo): guarda y borra.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2006', true);
do $$
begin
  perform public.save_branch_scale_config('00000000-0000-0000-0000-0000000d2002', 2, 3, 7, 100, 13, 'amount');
  perform public.delete_branch_scale_config('00000000-0000-0000-0000-0000000d2002');
end $$;

-- 2. El encargado (Mis balanzas desde Stock) también guarda; el borrado queda en audit_log con el formato que tenía.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2007', true);
do $$
begin
  perform public.save_branch_scale_config('00000000-0000-0000-0000-0000000d2002', 1, 6, 5, 1, 13, 'amount');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2005', true);
do $$
begin
  perform public.delete_branch_scale_config('00000000-0000-0000-0000-0000000d2002');
  if (select count(*) from audit_log where action = 'branch_scale_config.delete' and branch_id = '00000000-0000-0000-0000-0000000d2002') <> 2 then raise exception 'faltan borrados en la auditoría'; end if;
  if not exists (select 1 from audit_log where action = 'branch_scale_config.delete' and user_id = '00000000-0000-0000-0000-0000000d2005'
                 and old_data ->> 'prefix_length' = '1' and old_data ->> 'weight_divisor' = '1' and old_data ->> 'payload_type' = 'amount') then
    raise exception 'el borrado no dice quién ni qué formato tenía';
  end if;
  -- Borrar algo que no existe no anota nada.
  perform public.delete_branch_scale_config('00000000-0000-0000-0000-0000000d2002');
  if (select count(*) from audit_log where action = 'branch_scale_config.delete' and branch_id = '00000000-0000-0000-0000-0000000d2002') <> 2 then raise exception 'anotó un borrado vacío'; end if;
end $$;

-- 3. El contador, un usuario inactivo y la otra empresa: no.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2008', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.save_branch_scale_config('00000000-0000-0000-0000-0000000d2002', 2, 3, 7, 100, 13, 'amount')$q$, 'contador guarda');
  perform pg_temp.must_fail($q$select public.delete_branch_scale_config('00000000-0000-0000-0000-0000000d2002')$q$, 'contador borra');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2009', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.save_branch_scale_config('00000000-0000-0000-0000-0000000d2002', 2, 3, 7, 100, 13, 'amount')$q$, 'usuario inactivo');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2015', true);
do $$
begin
  perform pg_temp.must_fail($q$select public.save_branch_scale_config('00000000-0000-0000-0000-0000000d2002', 2, 3, 7, 100, 13, 'amount')$q$, 'otra empresa');
end $$;

reset role;
rollback;
