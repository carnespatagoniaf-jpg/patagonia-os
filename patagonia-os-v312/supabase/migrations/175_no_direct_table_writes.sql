-- 175: Nadie escribe directo en las tablas: todo pasa por las funciones del sistema (auditoría 29/10/2026, crítico C1).
--
-- Antes, cualquier usuario logueado (también un cajero) tenía permiso de INSERT/UPDATE/DELETE sobre las tablas de
-- su empresa (treasury_movements, inventory_movements, products, pos_shifts, customer_payments, invoices, ...).
-- La regla de cada tabla solo miraba la empresa, no el rol: con el token de su sesión, un cajero podía borrar un
-- faltante de caja o un vale, bajar una deuda de fiado, cambiar precios y costos o el stock, sin pasar por el PIN
-- ni dejar nada en Auditoría. La 149 ya lo había cerrado solo para pos_sales*.
--
-- Por qué no rompe nada (revisado en producción el 29/10):
-- - La web no escribe directo en ninguna tabla: todo es supabase.rpc(...) (grep de .insert/.update/.delete/.upsert).
-- - Todas las funciones que escriben son SECURITY DEFINER y son de postgres: escriben como postgres, no como el
--   usuario. No hay ninguna función SECURITY INVOKER que escriba.
-- - Las Edge Functions escriben con service_role, que no se toca.
-- - No hay ninguna regla (policy) de INSERT/UPDATE/DELETE pensada para anon.
-- Leer (SELECT) sigue igual. Tampoco cambia ningún dato.
--
-- Las tablas que se creen después también nacen sin estos permisos (default privileges de postgres).

do $mig$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from anon, authenticated', t.relname);
  end loop;
end
$mig$;

alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

insert into public.schema_migrations (version) values ('175_no_direct_table_writes') on conflict do nothing;
