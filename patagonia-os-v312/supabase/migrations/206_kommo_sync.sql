-- Kommo -> embudo de interesados SIN webhooks (pedido del dueño, 2026-11-19: los
-- webhooks de Kommo piden el plan Avanzado y no lo quiere pagar).
--
-- En vez de que Kommo avise, la base llama cada 5 minutos a la Edge Function
-- `kommo-sync` (pg_cron + pg_net, igual que mp-sync en la 199), que lee la API de
-- Kommo con el token de una integración privada (secretos KOMMO_TOKEN y
-- KOMMO_SUBDOMAIN) y carga lo nuevo con kommo_lead_event() (205), sin cambiarla:
-- * contactos creados o cambiados desde la última vez -> interesado nuevo;
-- * eventos "mensaje entrante" -> "contestó" (la API común no trae el texto).
-- El webhook de la 205 queda como estaba (sirve si algún día se pasa a Avanzado).
--
-- kommo_sync_schedule (una sola fila): la dirección de la función, un token al
-- azar que la función compara con el encabezado x-kommo-sync-token, hasta dónde
-- leyó (cursores) y cómo le fue la última vez. La dirección se anota a mano una
-- vez por proyecto después de publicar la función:
--   update kommo_sync_schedule set url = 'https://<ref>.supabase.co/functions/v1/kommo-sync';
-- Hasta entonces la tarea no hace nada. Los cursores arrancan vacíos: la primera
-- corrida con token los pone en "ahora" (no trae la historia de Kommo).
-- Si pg_cron o pg_net no están (la base de prueba del CI), se crea la tabla y nada más.

create table if not exists public.kommo_sync_schedule (
  id integer primary key default 1 check (id = 1),
  url text,
  token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  contacts_since bigint,
  events_since bigint,
  events_seen jsonb not null default '[]'::jsonb,
  last_run_at timestamptz,
  last_result jsonb
);

insert into public.kommo_sync_schedule (id) values (1) on conflict (id) do nothing;

alter table public.kommo_sync_schedule enable row level security;
-- Sin policies a propósito.

drop trigger if exists zz_accountant_readonly on public.kommo_sync_schedule;
create trigger zz_accountant_readonly before insert or update or delete on public.kommo_sync_schedule
  for each statement execute function public.accountant_readonly_guard();

-- La llama pg_cron. Interna: revocada de todos.
create or replace function public.kommo_sync_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  select url, token into v from public.kommo_sync_schedule where id = 1;
  if v.url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2, timeout_milliseconds := 120000)'
    using v.url, jsonb_build_object('Content-Type', 'application/json', 'x-kommo-sync-token', v.token);
end;
$$;

revoke all on function public.kommo_sync_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('kommo-sync-cada-5-min', '*/5 * * * *', 'select public.kommo_sync_tick()');
  end if;
end $$;

insert into public.schema_migrations (version) values ('206_kommo_sync') on conflict do nothing;
