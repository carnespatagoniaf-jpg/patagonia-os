-- Pruebas de la migración 186 (Hoy en tus locales). Se deshace al final.
\set ON_ERROR_STOP 1
begin;
do $$
begin
  if has_function_privilege('anon', 'public.owner_today()', 'execute') then
    raise exception 'anon puede ver el resumen del día';
  end if;
  if not exists (select 1 from pg_proc where proname = 'owner_today' and prosrc like '%(''owner'', ''admin'')%') then
    raise exception 'owner_today no es solo para dueño/administrador';
  end if;
end $$;
rollback;
