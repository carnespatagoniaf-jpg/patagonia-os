-- VUELTA ATRÁS de 224_scales_send_permission.sql: "solo lectura" vuelve a la lista de roles de
-- save_branch_scale_config, delete_branch_scale_config, start_scale_job y finish_scale_job (como las dejaron la 220
-- y la 221). Solo cambia esa línea; el resto de la definición viva queda como está.

do $mig$
declare
  v_proc regprocedure;
  v_def text;
  v_old constant text := E'  perform public.require_role(array[''owner'', ''admin'', ''manager'', ''production'', ''cashier'', ''readonly'']::text[]);\n';
  v_new constant text := E'  perform public.require_role(array[''owner'', ''admin'', ''manager'', ''production'', ''cashier'']::text[]);\n';
begin
  for v_proc in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('save_branch_scale_config', 'delete_branch_scale_config', 'start_scale_job', 'finish_scale_job')
  loop
    v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
    if position(v_new in v_def) = 0 then
      raise notice '224 rollback: % no tiene la línea de la 224 (no se toca)', v_proc;
      continue;
    end if;
    execute replace(v_def, v_new, v_old);
  end loop;
end
$mig$;

delete from public.schema_migrations where version = '224_scales_send_permission';
