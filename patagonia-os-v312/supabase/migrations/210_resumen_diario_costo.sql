-- El costo del resumen diario por WhatsApp se anota solo en Finanzas (pedido del dueño, 2026-11-20).
--
-- Cada vez que la función daily-summary manda el resumen, anota un gasto "WhatsApp" en la cuenta de Finanzas que
-- elija el dueño (por ejemplo, la tarjeta), por mensajes mandados × precio por mensaje (en la moneda de esa cuenta).
-- Igual que el gasto de Meta Ads (159): una fila por envío con una clave única, así no se duplica si se reintenta.
--   whatsapp_key = 'resumen|<día>' para el envío de todas las mañanas, 'resumen-prueba|<momento>' para "Probar ahora".
-- Sin cuenta o sin precio no anota nada. Solo agrega columnas y cambia las dos RPC del panel de la 209.

alter table public.daily_summary_schedule
  add column if not exists cost_account_id uuid references public.platform_fin_accounts(id) on delete set null,
  add column if not exists cost_per_message numeric(12,4) check (cost_per_message is null or cost_per_message >= 0);

alter table public.platform_fin_movements add column if not exists whatsapp_key text unique;

create or replace function public.get_daily_summary_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v record;
begin
  if not public.am_i_platform_admin() then
    raise exception 'Solo un administrador de la plataforma puede ver esto.' using errcode = '42501';
  end if;
  select * into v from public.daily_summary_schedule where id = 1;
  return jsonb_build_object(
    'enabled', v.enabled,
    'recipients', to_jsonb(v.recipients),
    'send_hour', v.send_hour,
    'url_set', v.url is not null,
    'last_sent_on', v.last_sent_on,
    'last_run_at', v.last_run_at,
    'last_result', v.last_result,
    'cost_account_id', v.cost_account_id,
    'cost_per_message', v.cost_per_message
  );
end;
$$;

revoke all on function public.get_daily_summary_settings() from public, anon;
grant execute on function public.get_daily_summary_settings() to authenticated;

drop function if exists public.set_daily_summary_settings(boolean, text[], integer);

create or replace function public.set_daily_summary_settings(
  p_enabled boolean,
  p_recipients text[],
  p_send_hour integer,
  p_cost_account_id uuid default null,
  p_cost_per_message numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean text[];
begin
  if not public.am_i_platform_admin() then
    raise exception 'Solo un administrador de la plataforma puede cambiar esto.' using errcode = '42501';
  end if;
  if p_send_hour is null or p_send_hour < 0 or p_send_hour > 23 then
    raise exception 'La hora tiene que ser entre 0 y 23.';
  end if;
  if p_cost_per_message is not null and p_cost_per_message < 0 then
    raise exception 'El precio por mensaje no puede ser negativo.';
  end if;
  if p_cost_account_id is not null and not exists (select 1 from public.platform_fin_accounts a where a.id = p_cost_account_id) then
    raise exception 'Esa cuenta de Finanzas no existe.';
  end if;
  select coalesce(array_agg(distinct n), '{}') into v_clean
  from (select regexp_replace(x, '\D', '', 'g') as n from unnest(coalesce(p_recipients, '{}')) as x) t
  where length(n) between 8 and 15;
  if array_length(v_clean, 1) > 5 then
    raise exception 'Como mucho 5 números.';
  end if;
  if p_enabled and coalesce(array_length(v_clean, 1), 0) = 0 then
    raise exception 'Para prenderlo, cargá al menos un número de WhatsApp.';
  end if;
  update public.daily_summary_schedule
  set enabled = p_enabled, recipients = v_clean, send_hour = p_send_hour,
      cost_account_id = p_cost_account_id, cost_per_message = p_cost_per_message
  where id = 1;
end;
$$;

revoke all on function public.set_daily_summary_settings(boolean, text[], integer, uuid, numeric) from public, anon;
grant execute on function public.set_daily_summary_settings(boolean, text[], integer, uuid, numeric) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('210_resumen_diario_costo') on conflict do nothing;
