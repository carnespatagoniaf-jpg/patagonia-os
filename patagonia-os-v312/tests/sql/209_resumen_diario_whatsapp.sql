-- Pruebas de la migración 209 (resumen diario por WhatsApp). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

do $$
declare v record;
begin
  if (select count(*) from daily_summary_schedule) <> 1 then raise exception 'esperaba una fila'; end if;
  select * into v from daily_summary_schedule;
  if length(v.token) < 64 then raise exception 'token corto: %', length(v.token); end if;
  if v.enabled or v.url is not null or v.send_hour <> 8 or cardinality(v.recipients) <> 0 then
    raise exception 'debería arrancar apagada y vacía: %', row_to_json(v);
  end if;
end $$;

do $$
begin
  insert into daily_summary_schedule (id) values (2);
  raise exception 'dejó agregar otra fila';
exception when check_violation then null;
end $$;

-- Apagada, la tarea no hace nada (y no falla aunque falte pg_net).
select public.daily_summary_tick();

-- Los datos del resumen salen con la forma que espera la función.
do $$
declare d jsonb;
begin
  d := public.platform_daily_summary_data();
  if not (d ? 'today' and d ? 'companies' and d ? 'collected_month' and d ? 'collected_yesterday') then
    raise exception 'faltan claves: %', d;
  end if;
  if jsonb_typeof(d->'companies') <> 'array' then raise exception 'companies no es lista: %', d->'companies'; end if;
end $$;

-- La web no puede leer los datos, ni la tabla, ni llamar la tarea.
set local role authenticated;
do $$
begin
  perform public.platform_daily_summary_data();
  raise exception 'authenticated pudo leer platform_daily_summary_data';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.daily_summary_tick();
  raise exception 'authenticated pudo llamar daily_summary_tick';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  if exists (select 1 from daily_summary_schedule) then raise exception 'authenticated ve el token'; end if;
exception when insufficient_privilege then null;
end $$;
-- Sin ser administrador de plataforma, las RPC del panel se niegan.
do $$
begin
  perform public.get_daily_summary_settings();
  raise exception 'un usuario común pudo leer la configuración';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.set_daily_summary_settings(true, array['2966555123'], 8);
  raise exception 'un usuario común pudo cambiar la configuración';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
