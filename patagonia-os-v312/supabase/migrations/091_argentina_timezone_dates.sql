-- La base corre en UTC pero todos los clientes estan en Argentina (UTC-3): pasadas
-- las 21:00 locales, current_date ya es "manana". Un cierre de turno, un vale, un
-- pago a proveedor o una transferencia hechos de noche quedaban con fecha del dia
-- siguiente en Tesoreria, y close_profitability_period agrupaba las ventas de
-- Mostrador por fecha UTC (created_at::date).
--
-- En vez de re-tipear cada funcion (lo que ya causo regresiones: 057 pisaba las
-- guardas de 037), se reescriben a partir de su definicion ACTUAL en la base,
-- reemplazando solo la parte de la fecha.
create or replace function public.today_ar()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'America/Argentina/Buenos_Aires')::date
$$;

revoke all on function public.today_ar() from public;
grant execute on function public.today_ar() to authenticated;

do $$
declare
  r record;
  v_def text;
  v_count int := 0;
begin
  for r in
    select p.oid, p.proname
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and p.proname <> 'today_ar'
      and (pg_get_functiondef(p.oid) ~* '\mcurrent_date\M' or pg_get_functiondef(p.oid) ~ 'ps\.created_at::date')
  loop
    v_def := regexp_replace(pg_get_functiondef(r.oid), '\mcurrent_date\M', 'public.today_ar()', 'gi');
    v_def := replace(v_def, 'ps.created_at::date', '(ps.created_at at time zone ''America/Argentina/Buenos_Aires'')::date');
    execute v_def;
    v_count := v_count + 1;
    raise notice 'Actualizada: %', r.proname;
  end loop;
  raise notice 'Funciones actualizadas: %', v_count;
end $$;

notify pgrst, 'reload schema';
