-- Pruebas de la migración 210 (costo del resumen diario en Finanzas). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

do $$
declare v record;
begin
  select * into v from daily_summary_schedule;
  if v.cost_account_id is not null or v.cost_per_message is not null then raise exception 'debería arrancar sin cuenta ni precio'; end if;
end $$;

-- La clave de WhatsApp no deja anotar dos veces el mismo envío.
do $$
declare v_acc uuid;
begin
  insert into platform_fin_accounts (name, currency) values ('Tarjeta prueba 210', 'ARS') returning id into v_acc;
  insert into platform_fin_movements (occurred_on, account_id, kind, direction, amount, category, whatsapp_key)
    values (current_date, v_acc, 'gasto', 'out', 0.06, 'WhatsApp', 'resumen|2026-11-20');
  begin
    insert into platform_fin_movements (occurred_on, account_id, kind, direction, amount, category, whatsapp_key)
      values (current_date, v_acc, 'gasto', 'out', 0.06, 'WhatsApp', 'resumen|2026-11-20');
    raise exception 'dejó anotar dos veces el mismo envío';
  exception when unique_violation then null;
  end;
  -- Un precio negativo no entra.
  begin
    update daily_summary_schedule set cost_per_message = -1;
    raise exception 'dejó un precio negativo';
  exception when check_violation then null;
  end;
end $$;

-- Sin ser administrador de plataforma, la RPC nueva se niega.
set local role authenticated;
do $$
begin
  perform public.set_daily_summary_settings(false, '{}', 8, null, 0.03);
  raise exception 'un usuario común pudo cambiar la configuración';
exception when insufficient_privilege then null;
end $$;
reset role;

-- La versión de 3 argumentos ya no existe.
do $$
begin
  if to_regprocedure('public.set_daily_summary_settings(boolean,text[],integer)') is not null then
    raise exception 'quedó la versión vieja';
  end if;
end $$;

rollback;
