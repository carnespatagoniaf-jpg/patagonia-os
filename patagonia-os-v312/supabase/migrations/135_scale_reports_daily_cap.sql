-- 135: tope de reportes de balanza por empresa, de 20 a 200 por día (19/10/2026).
--
-- Por qué: en Los gringos, mientras se conectaba una Systel nueva, se llegó a 20 reportes en el día y los siguientes
-- se rechazaron EN SILENCIO (Mi balanza dice "El detalle técnico ya le llegó a soporte" aunque no llegó). Justo se
-- perdieron los registros que hacían falta para el diagnóstico. Cada reporte pesa a lo sumo 20 kB.
--
-- Se cambia SOLO ese número en la definición vigente de la función (cada base puede tenerla distinta), igual que la
-- 101 y la 104. Sin el texto esperado no se toca nada.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'submit_scale_support_report';
  if v_def is null then
    raise notice 'submit_scale_support_report no existe en esta base: nada que cambiar';
    return;
  end if;
  v_new := replace(v_def, 'v_today_count >= 20 then', 'v_today_count >= 200 then');
  if v_new = v_def then
    raise notice 'submit_scale_support_report no tiene el tope de 20: nada que cambiar';
    return;
  end if;
  execute v_new;
end;
$$;

insert into public.schema_migrations (version) values ('135_scale_reports_daily_cap') on conflict do nothing;
