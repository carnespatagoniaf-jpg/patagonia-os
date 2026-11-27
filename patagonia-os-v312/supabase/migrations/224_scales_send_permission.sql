-- 224: "solo lectura" ya no modifica ni manda productos a las balanzas (decisión del dueño, 27/11/2026).
--
-- El dueño: "el usuario de solo lectura no debe poder modificar ni enviar productos a las balanzas".
--
-- La web suma el permiso scales.send (permissions.ts): dueño, administrador, encargado, producción y cajero. NO
-- solo lectura ni contador. Sin ese permiso "Mis balanzas" muestra el estado de cada balanza, pero no los botones
-- que escriben en la balanza ni los que cambian el formato de etiqueta (engranaje de Mostrador, herramientas técnicas).
--
-- Acá se hace lo mismo en la base. La línea de rol que inyectó la 221 en save_branch_scale_config /
-- delete_branch_scale_config, y la que traen start_scale_job / finish_scale_job (220), pasan a la misma lista SIN
-- 'readonly':
--   perform public.require_role(array['owner', 'admin', 'manager', 'production', 'cashier']::text[]);
--
-- Cómo: se reemplaza esa línea sobre la definición VIVA de cada función (como la 178 y la 221): no se pisa nada más
-- de lo que tenga cada base. Si una función no tiene la línea esperada, se frena para revisarla a mano.
--
-- Usuarios actuales: en producción hay UN solo usuario "solo lectura" (Carplat) y nunca usó balanzas (sin envíos en
-- scale_jobs ni cambios de formato en audit_log). No hace falta migrar a nadie.
-- No cambia ningún dato. Vuelta atrás: 224_scales_send_permission.rollback.sql.

do $mig$
declare
  v_proc regprocedure;
  v_def text;
  v_count int := 0;
  v_old constant text := E'  perform public.require_role(array[''owner'', ''admin'', ''manager'', ''production'', ''cashier'', ''readonly'']::text[]);\n';
  v_new constant text := E'  perform public.require_role(array[''owner'', ''admin'', ''manager'', ''production'', ''cashier'']::text[]);\n';
begin
  for v_proc in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('save_branch_scale_config', 'delete_branch_scale_config', 'start_scale_job', 'finish_scale_job')
  loop
    v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
    if position(v_new in v_def) > 0 and position(v_old in v_def) = 0 then
      raise notice '224: % ya tiene la lista sin solo lectura', v_proc;
      v_count := v_count + 1;
      continue;
    end if;
    if position(v_old in v_def) = 0 then
      raise exception '224: % no tiene la línea de rol de la 220/221 (revisar a mano)', v_proc;
    end if;
    execute replace(v_def, v_old, v_new);
    v_count := v_count + 1;
  end loop;
  if v_count < 4 then
    raise exception '224: se esperaban 4 funciones (formato de etiqueta y envíos), se encontraron %', v_count;
  end if;
end
$mig$;

insert into public.schema_migrations (version) values ('224_scales_send_permission') on conflict do nothing;
