-- Cobros de Mercado Pago sin abrir el panel (pedido del dueño, 2026-11-16:
-- "para no estar avisando cada vez que entra el pago").
--
-- Hasta acá la Edge Function mp-sync (migración 129) corría solo cuando un
-- platform admin abría el panel o tocaba "Actualizar". Ahora la base la llama
-- sola cada hora con pg_cron + pg_net:
-- * mp_sync_schedule (una sola fila) guarda la dirección de la función, un token
--   al azar que la función compara con el encabezado x-mp-sync-token, y cómo le
--   fue la última vez (last_run_at / last_result, los escribe la función).
-- * La dirección la anota mp-sync la primera vez que la llama un platform admin
--   (cada proyecto tiene la suya; así esta migración sirve igual en staging y en
--   producción). Hasta entonces la tarea no hace nada.
-- * El token se genera acá y nunca sale de la base ni llega al navegador: RLS
--   sin policies, solo lo leen la service role (mp-sync) y la tarea.
-- Si pg_cron o pg_net no están disponibles (la base de prueba del CI), se crea
-- la tabla y nada más.

create table if not exists public.mp_sync_schedule (
  id integer primary key default 1 check (id = 1),
  url text,
  token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  last_run_at timestamptz,
  last_result jsonb
);

insert into public.mp_sync_schedule (id) values (1) on conflict (id) do nothing;

alter table public.mp_sync_schedule enable row level security;
-- Sin policies a propósito (como mp_subscriptions).

do $$
begin
  if to_regprocedure('public.accountant_readonly_guard()') is not null then
    drop trigger if exists zz_accountant_readonly on public.mp_sync_schedule;
    create trigger zz_accountant_readonly before insert or update or delete on public.mp_sync_schedule
      for each statement execute function public.accountant_readonly_guard();
  end if;
end $$;

-- La llama pg_cron. Interna: revocada de todos.
create or replace function public.mp_sync_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  select url, token into v from public.mp_sync_schedule where id = 1;
  if v.url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2, timeout_milliseconds := 120000)'
    using v.url, jsonb_build_object('Content-Type', 'application/json', 'x-mp-sync-token', v.token);
end;
$$;

revoke all on function public.mp_sync_tick() from public, anon, authenticated;

-- Para el panel: cuándo corrió sola por última vez y qué dio. Solo platform admins.
create or replace function public.mp_sync_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  select url, last_run_at, last_result into v from public.mp_sync_schedule where id = 1;
  return jsonb_build_object(
    'scheduled', v.url is not null and exists (select 1 from pg_extension where extname = 'pg_cron'),
    'last_run_at', v.last_run_at,
    'last_result', v.last_result
  );
end;
$$;

revoke all on function public.mp_sync_status() from public, anon;
grant execute on function public.mp_sync_status() to authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    -- Minuto 7 de cada hora (no a la hora en punto, cuando corre todo lo demás).
    perform cron.schedule('mp-sync-cada-hora', '7 * * * *', 'select public.mp_sync_tick()');
  end if;
end $$;

insert into public.schema_migrations (version) values ('199_mp_sync_cada_hora') on conflict do nothing;
