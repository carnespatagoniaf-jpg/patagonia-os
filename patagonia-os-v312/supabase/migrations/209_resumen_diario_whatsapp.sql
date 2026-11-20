-- Resumen diario del panel de plataforma por WhatsApp (pedido del dueño, 2026-11-20, Etapa 4 del rediseño).
--
-- Todas las mañanas, a la hora que elija el dueño, la Edge Function `daily-summary` arma el resumen
-- (cobrado, quién debe, quién vence, quién puede irse) y lo manda con la API de WhatsApp de Meta, desde un
-- número propio (no el de Kommo: un número de WhatsApp Business no se conecta a dos sistemas).
--
-- daily_summary_schedule (una sola fila, como kommo_sync_schedule en la 206):
--   url        dirección de la función; se anota a mano una vez por proyecto después de publicarla:
--              update daily_summary_schedule set url = 'https://<ref>.supabase.co/functions/v1/daily-summary';
--   token      al azar; la función lo compara con el encabezado x-daily-summary-token.
--   enabled    apagado hasta que el dueño lo prenda desde el panel.
--   recipients números de WhatsApp que lo reciben (los escribe el dueño en el panel).
--   send_hour  hora argentina (0-23); la tarea corre cada hora y la función manda una sola vez por día.
-- Los secretos de Meta (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID) van en la función, no en la base.
-- Si pg_cron o pg_net no están (la base de prueba del CI), se crea todo menos la tarea.

create table if not exists public.daily_summary_schedule (
  id integer primary key default 1 check (id = 1),
  url text,
  token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  enabled boolean not null default false,
  recipients text[] not null default '{}',
  send_hour smallint not null default 8 check (send_hour between 0 and 23),
  last_sent_on date,
  last_run_at timestamptz,
  last_result jsonb
);

insert into public.daily_summary_schedule (id) values (1) on conflict (id) do nothing;

alter table public.daily_summary_schedule enable row level security;
-- Sin policies a propósito: solo la función (service role) y las RPC de abajo.

drop trigger if exists zz_accountant_readonly on public.daily_summary_schedule;
create trigger zz_accountant_readonly before insert or update or delete on public.daily_summary_schedule
  for each statement execute function public.accountant_readonly_guard();

-- Datos del resumen. Solo para la función (service role): no revisa quién llama, así que se revoca de todos.
create or replace function public.platform_daily_summary_data()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with today as (
    select (now() at time zone 'America/Argentina/Buenos_Aires')::date as d
  )
  select jsonb_build_object(
    'today', (select d from today),
    'collected_month', (
      select coalesce(sum(cp.amount), 0) from public.company_payments cp, today
      where cp.payment_date >= date_trunc('month', today.d)::date and cp.payment_date <= today.d
    ),
    'collected_yesterday', (
      select coalesce(sum(cp.amount), 0) from public.company_payments cp, today where cp.payment_date = today.d - 1
    ),
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'created_at', c.created_at,
        'paid_until', c.paid_until,
        'trial_ends_at', c.trial_ends_at,
        'last_payment_amount', (select cp.amount from public.company_payments cp where cp.company_id = c.id order by cp.created_at desc limit 1),
        'mp_ok', exists (select 1 from public.mp_subscriptions m where m.company_id = c.id and m.status = 'authorized'),
        'usage', jsonb_build_object(
          'product_count', (select count(*) from public.products p where p.company_id = c.id),
          'sale_count', s.sale_count,
          'sales_last_7d', s.sales_last_7d,
          'first_sale_at', s.first_sale_at,
          'last_sale_at', s.last_sale_at,
          'last_sign_in_at', (select max(au.last_sign_in_at) from public.profiles pr join auth.users au on au.id = pr.id where pr.company_id = c.id)
        )
      ) order by c.name)
      from public.companies c
      left join lateral (
        select count(*) as sale_count,
               count(*) filter (where ps.created_at > now() - interval '7 days') as sales_last_7d,
               min(ps.created_at) as first_sale_at,
               max(ps.created_at) as last_sale_at
        from public.pos_sales ps where ps.company_id = c.id
      ) s on true
      where c.active
    ), '[]'::jsonb)
  )
$$;

revoke all on function public.platform_daily_summary_data() from public, anon, authenticated;

-- Panel: leer y cambiar la configuración (solo administradores de plataforma). El token no se muestra.
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
    'last_result', v.last_result
  );
end;
$$;

revoke all on function public.get_daily_summary_settings() from public, anon;
grant execute on function public.get_daily_summary_settings() to authenticated;

create or replace function public.set_daily_summary_settings(p_enabled boolean, p_recipients text[], p_send_hour integer)
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
  -- Solo dígitos, sin repetidos ni vacíos; como mucho 5 números.
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
  set enabled = p_enabled, recipients = v_clean, send_hour = p_send_hour
  where id = 1;
end;
$$;

revoke all on function public.set_daily_summary_settings(boolean, text[], integer) from public, anon;
grant execute on function public.set_daily_summary_settings(boolean, text[], integer) to authenticated;

-- La llama pg_cron cada hora. Interna: revocada de todos. Solo llama si está prendido y con dirección;
-- la función decide si ya es la hora y si hoy ya se mandó.
create or replace function public.daily_summary_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  select url, token, enabled into v from public.daily_summary_schedule where id = 1;
  if not v.enabled or v.url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2, timeout_milliseconds := 60000)'
    using v.url, jsonb_build_object('Content-Type', 'application/json', 'x-daily-summary-token', v.token);
end;
$$;

revoke all on function public.daily_summary_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('resumen-diario-cada-hora', '0 * * * *', 'select public.daily_summary_tick()');
  end if;
end $$;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('209_resumen_diario_whatsapp') on conflict do nothing;
