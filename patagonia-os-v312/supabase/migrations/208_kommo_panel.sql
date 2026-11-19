-- Kommo en el panel (pedido del dueño, 2026-11-19):
-- * botón "Abrir en Kommo" en cada contacto que vino de Kommo: la lista de
--   interesados ahora devuelve kommo_contact_id (205) y la web arma
--   https://<subdominio>.kommo.com/contacts/detail/<id>;
-- * aviso si la sincronización (206) se corta (token vencido, Kommo caído, la
--   tarea no corre): kommo_sync_status() le da al panel la última corrida.
--
-- El subdominio de Kommo vive en el secreto KOMMO_SUBDOMAIN de las funciones; la
-- web no lo ve. kommo-sync lo anota en kommo_sync_schedule.subdomain en cada
-- corrida, y kommo_sync_status() lo devuelve solo a los administradores de Patagonia
-- (nunca el token ni la dirección).

alter table public.kommo_sync_schedule add column if not exists subdomain text;

-- Lista: + kommo_contact_id (cambia el tipo de retorno: drop + create, igual que la 132).
drop function if exists public.list_platform_leads();

create function public.list_platform_leads()
returns table (
  id uuid,
  business_name text,
  contact_name text,
  phone text,
  province text,
  city text,
  stage text,
  source text,
  note text,
  next_contact_on date,
  lost_reason text,
  company_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  attempts integer,
  last_contacted_at timestamptz,
  replied_at timestamptz,
  kommo_contact_id bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.business_name, l.contact_name, l.phone, l.province, l.city, l.stage, l.source, l.note,
         l.next_contact_on, l.lost_reason, l.company_id, l.created_at, l.updated_at,
         l.attempts, l.last_contacted_at, l.replied_at, l.kommo_contact_id
  from public.platform_leads l
  where public.am_i_platform_admin()
  order by l.created_at desc
$$;

revoke all on function public.list_platform_leads() from public, anon;
grant execute on function public.list_platform_leads() to authenticated;

-- Estado de la sincronización para el panel. Sin filas si no es administrador.
create or replace function public.kommo_sync_status()
returns table (
  configured boolean,
  subdomain text,
  last_run_at timestamptz,
  last_result jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select s.url is not null, s.subdomain, s.last_run_at, s.last_result
  from public.kommo_sync_schedule s
  where s.id = 1 and public.am_i_platform_admin()
$$;

revoke all on function public.kommo_sync_status() from public, anon;
grant execute on function public.kommo_sync_status() to authenticated;

insert into public.schema_migrations (version) values ('208_kommo_panel') on conflict do nothing;
