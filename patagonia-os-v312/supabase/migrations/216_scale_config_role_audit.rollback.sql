-- VUELTA ATRÁS de 216_scale_config_role_audit.sql: saca la línea de require_role que la 216 inyectó en
-- save_branch_scale_config y delete_branch_scale_config (dejando el resto de la definición viva como está) y el
-- trigger de auditoría del borrado. No borra renglones de audit_log ya escritos.

do $mig$
declare
  v_proc regprocedure;
  v_def text;
  v_line constant text := E'  perform public.require_role(array[''owner'', ''admin'', ''manager'', ''production'', ''cashier'', ''readonly'']::text[]);\n';
begin
  for v_proc in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('save_branch_scale_config', 'delete_branch_scale_config')
  loop
    v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
    if position(v_line in v_def) = 0 then
      raise notice '216 rollback: % no tiene la línea de la 216 (no se toca)', v_proc;
      continue;
    end if;
    execute replace(v_def, v_line, '');
  end loop;
end
$mig$;

drop trigger if exists audit_branch_scale_config_delete on public.branch_scale_configs;
drop function if exists public.audit_branch_scale_config_delete();

delete from public.schema_migrations where version = '216_scale_config_role_audit';
