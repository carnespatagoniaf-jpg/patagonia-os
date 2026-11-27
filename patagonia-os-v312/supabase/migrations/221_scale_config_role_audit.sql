-- 221: el formato de etiqueta de la sucursal controla el rol, y borrarlo queda auditado (plan balanzas v2, C25).
-- 26/11/2026.
--
-- save_branch_scale_config (070/071) y delete_branch_scale_config (070) solo miraban que el usuario fuera de la
-- empresa y la sucursal de la empresa. Ese formato decide cómo lee Mostrador cada etiqueta (kilos e importe que se
-- cobran), así que ahora:
--
-- 1. Las dos controlan el ROL con require_role (178), con los roles que HOY la usan desde la web:
--    - Engranaje de Mostrador → "Detectar formato" / "Borrar calibración" (SaleConfigPanel): pos.sell = dueño,
--      administrador y CAJERO. El cajero calibra la balanza en el local: es un uso legítimo, no se le corta.
--    - "Mis balanzas" → "PASAR PRODUCTOS" (Kretz Aura y Report, engine/adapters/kretz.ts): al sincronizar deja a
--      Mostrador leyendo el formato que se le mandó a la balanza. Se llega desde Stock (dueño, administrador,
--      encargado, producción, solo lectura) y desde Productos (dueño, administrador, cajero), sin otro filtro de rol.
--    - Herramientas técnicas (ScaleSyncPanel), solo con el acceso de soporte prendido: mismas pantallas.
--    Queda: owner, admin, manager, production, cashier, readonly. Afuera: el contador (que igual ya lo frenaba
--    zz_accountant_readonly) y cualquier rol nuevo que se agregue sin pensarlo. "Solo lectura" queda adentro porque
--    hoy la pantalla le deja pasar productos, y sacárselo haría fallar a la mitad el código de barras de su envío;
--    si el dueño decide que no, primero se le esconde el botón en la web y después se lo saca de esta lista.
-- 2. Todo borrado de branch_scale_configs anota audit_log ('branch_scale_config.delete', con el formato que tenía),
--    con un trigger AFTER DELETE: alcanza a delete_branch_scale_config y a cualquier otro camino que borre.
--
-- Cómo: la línea "perform public.require_role(...)" se INYECTA al principio del cuerpo de la definición viva de cada
-- función, igual que la 178. No se reescriben las funciones porque cada base puede tener una definición distinta
-- (la 101 inyectó require_plan en vivo y staging ya derivó de producción más de una vez): así no se pisa nada de lo
-- que tengan. La auditoría va por trigger por el mismo motivo (meter un insert en medio del cuerpo vivo es frágil).
-- No cambia ningún dato. Vuelta atrás: 221_scale_config_role_audit.rollback.sql.

do $mig$
declare
  v_proc regprocedure;
  v_def text;
  v_pos int;
  v_count int := 0;
  v_roles constant text := E'  perform public.require_role(array[''owner'', ''admin'', ''manager'', ''production'', ''cashier'', ''readonly'']::text[]);\n';
begin
  for v_proc in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('save_branch_scale_config', 'delete_branch_scale_config')
  loop
    v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
    if position('public.require_role(' in v_def) > 0 then
      raise notice '221: % ya controla el rol', v_proc;
      v_count := v_count + 1;
      continue;
    end if;
    -- El cuerpo empieza en la primera línea "begin" después de "AS $function$" (como en la 178).
    v_pos := position(E'\nbegin\n' in substr(v_def, position('$function$' in v_def)));
    if v_pos = 0 then
      raise exception '221: % no tiene el "begin" esperado (revisar a mano)', v_proc;
    end if;
    v_pos := v_pos + position('$function$' in v_def) - 1;
    v_def := substr(v_def, 1, v_pos + 6) || v_roles || substr(v_def, v_pos + 7);
    execute v_def;
    v_count := v_count + 1;
  end loop;
  if v_count < 2 then
    raise exception '221: se esperaban save_branch_scale_config y delete_branch_scale_config, se encontraron %', v_count;
  end if;
end
$mig$;

create or replace function public.audit_branch_scale_config_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data)
  values (
    old.company_id, old.branch_id, auth.uid(), 'branch_scale_config.delete', 'branch_scale_config', old.id::text,
    jsonb_build_object(
      'prefix_length', old.prefix_length, 'plu_length', old.plu_length, 'weight_length', old.weight_length,
      'weight_divisor', old.weight_divisor, 'total_length', old.total_length, 'payload_type', old.payload_type
    )
  );
  return old;
end;
$$;
revoke all on function public.audit_branch_scale_config_delete() from public, anon, authenticated;

drop trigger if exists audit_branch_scale_config_delete on public.branch_scale_configs;
create trigger audit_branch_scale_config_delete after delete on public.branch_scale_configs
  for each row execute function public.audit_branch_scale_config_delete();

insert into public.schema_migrations (version) values ('221_scale_config_role_audit') on conflict do nothing;
