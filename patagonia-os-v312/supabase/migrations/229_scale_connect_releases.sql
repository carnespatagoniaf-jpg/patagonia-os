-- 229: Patagonia Scale Connect — actualización automática con despliegue gradual (plan balanzas v2 §5.6). 27/11/2026.
--
-- Por qué: cada PC con Scale Connect (servicio de Windows, apps/connector) tiene que poder actualizarse sola, sin que
-- nadie vaya a la carnicería, y sin que una versión nueva le llegue a todos a la vez. La AUTENTICIDAD no la da esta
-- base: el manifiesto (latest.json) está firmado con Ed25519 en el CI y la PC lo verifica con la clave pública que
-- trae dentro del ejecutable (firma, SHA-256 del instalador, versión mínima, nunca bajar de versión). Si este servidor
-- quedara comprometido, lo peor que puede hacer es NO ofrecer una versión u ofrecer una vieja ya firmada (que la PC
-- rechaza por ser más vieja). Lo que decide esta base es A QUIÉN y CUÁNDO.
--
-- Qué agrega (aditiva):
-- 1. companies.scale_connect_channel: 'stable' (por omisión) | 'pilot'. Una empresa piloto recibe también lo piloto.
-- 2. scale_connect_releases: versión, canal (pilot | stable), url, sha256, tamaño, versión mínima, el manifiesto firmado
--    COMPLETO (la PC verifica eso, no las columnas), porcentaje de despliegue 0-100 y activa. Una (versión, canal) no
--    se puede volver a publicar con otro instalador: para cambiar el binario hay que subir la versión.
--    scale_connect_release_log: quién publicó, frenó o cambió el porcentaje (no tiene empresa: no va en audit_log).
-- 3. scale_connectors.update_status / update_reported_at: lo último que informó el actualizador de esa PC.
-- 4. Oferta para una PC (scale_connector_update_offer, solo service_role, ruta /update y /config de
--    scale-connect-api): la versión activa más nueva que la que tiene la PC, de su canal, y solo si la PC cae dentro
--    del porcentaje: balde = primeros 4 bytes del SHA-256 del id del conector, módulo 100 (estable: subir de 10 % a
--    50 % mantiene a los primeros 10 %). Entra si balde < porcentaje (0 % = nadie, 100 % = todos).
-- 5. scale_connector_report_update (solo service_role, ruta /update-report): guarda el resultado; si la versión nueva
--    no anduvo (revertida / fallo_reversion) o fue rechazada, queda en audit_log de la empresa.
-- 6. Bucket público de Storage "scale-connect" (instaladores + latest.json; los sube el CI con la clave de servicio).
-- 7. RPC de administradores de plataforma (am_i_platform_admin): publish_scale_connect_release,
--    set_scale_connect_release (frenar / reactivar / porcentaje), set_company_scale_connect_channel,
--    list_scale_connect_releases.
--
-- Publicar desde el editor SQL (no hay sesión: se usa la del administrador, dentro de una transacción):
--   begin;
--   select set_config('request.jwt.claim.sub', '<user_id de platform_admins>', true);
--   select public.publish_scale_connect_release('<latest.json>'::jsonb, 'pilot', 100);
--   commit;
--
-- La web y el conector ignoran en silencio si esta migración todavía no está.
-- Vuelta atrás: 229_scale_connect_releases.rollback.sql.

-- ------------------------------------------------------------------------------------------------- utilidades
-- "X.Y.Z" o "X.Y.Z-algo" → {X,Y,Z} (el sufijo no cuenta, igual que compareVersions del conector). null si no es una versión.
create or replace function public.scale_connect_version_key(p_version text)
returns integer[]
language sql
immutable
set search_path = public
as $$
  select case when p_version ~ '^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,30})?$'
    then array[split_part(p_version, '.', 1)::integer, split_part(p_version, '.', 2)::integer,
               split_part(split_part(p_version, '.', 3), '-', 1)::integer]
  end;
$$;

-- Balde 0..99 de un conector: estable (no depende de la versión ni del día).
create or replace function public.scale_connect_rollout_bucket(p_connector_id uuid)
returns integer
language sql
immutable
set search_path = public
as $$
  select (((get_byte(d, 0)::bigint << 24) | (get_byte(d, 1)::bigint << 16) | (get_byte(d, 2)::bigint << 8) | get_byte(d, 3)::bigint) % 100)::integer
  from (select sha256(convert_to(p_connector_id::text, 'UTF8')) as d) x;
$$;

revoke all on function public.scale_connect_version_key(text) from public, anon, authenticated;
revoke all on function public.scale_connect_rollout_bucket(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------- tablas
alter table public.companies add column if not exists scale_connect_channel text not null default 'stable';
alter table public.companies drop constraint if exists companies_scale_connect_channel_check;
alter table public.companies add constraint companies_scale_connect_channel_check check (scale_connect_channel in ('pilot', 'stable'));

create table if not exists public.scale_connect_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null check (public.scale_connect_version_key(version) is not null),
  channel text not null check (channel in ('pilot', 'stable')),
  url text not null check (url ~ '^https://[^[:space:]]+$' and length(url) <= 500),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint not null check (size > 0 and size <= 314572800),
  min_version text not null check (public.scale_connect_version_key(min_version) is not null),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and length(manifest::text) <= 4000),
  rollout_percent integer not null default 0 check (rollout_percent between 0 and 100),
  active boolean not null default true,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (version, channel),
  -- Las columnas son las del manifiesto firmado (las usa la base; la PC verifica el manifiesto).
  check (manifest ->> 'version' = version and manifest ->> 'url' = url and manifest ->> 'sha256' = sha256
         and manifest ->> 'minVersion' = min_version and (manifest ->> 'size')::bigint = size)
);
create index if not exists scale_connect_releases_active_idx on public.scale_connect_releases (channel) where active;

create table if not exists public.scale_connect_release_log (
  id bigint generated always as identity primary key,
  release_id uuid references public.scale_connect_releases(id) on delete set null,
  action text not null check (action in ('publish', 'update')),
  user_id uuid references auth.users(id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.scale_connectors add column if not exists update_status jsonb
  check (update_status is null or (jsonb_typeof(update_status) = 'object' and length(update_status::text) <= 1000));
alter table public.scale_connectors add column if not exists update_reported_at timestamptz;

-- Bucket PÚBLICO de los instaladores y manifiestos (el repo es privado: la PC no puede bajar de GitHub). Se lee por
-- URL pública sin políticas; nadie escribe salvo la clave de servicio que usa el CI (sin políticas de insert/update).
-- La integridad no depende del bucket: la PC verifica la firma del manifiesto y el SHA-256 del instalador.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scale-connect', 'scale-connect', true, 314572800, array['application/octet-stream', 'application/json'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ------------------------------------------------------------------------------------------------- RLS y permisos
-- Las versiones no las lee nadie desde la API (solo la RPC de administradores y las funciones del conector).
alter table public.scale_connect_releases enable row level security;
alter table public.scale_connect_release_log enable row level security;
revoke all on table public.scale_connect_releases, public.scale_connect_release_log from anon, authenticated;
-- La empresa puede ver cómo le fue a cada PC (scale_connectors ya tiene RLS por empresa y permisos por columna).
grant select (update_status, update_reported_at) on table public.scale_connectors to authenticated;

drop trigger if exists zz_accountant_readonly on public.scale_connect_releases;
create trigger zz_accountant_readonly before insert or update or delete on public.scale_connect_releases
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.scale_connect_release_log;
create trigger zz_accountant_readonly before insert or update or delete on public.scale_connect_release_log
  for each statement execute function public.accountant_readonly_guard();

-- ------------------------------------------------------------------------------------------------- oferta (conector)
-- La versión que le toca a este conector: activa, de su canal (una empresa piloto recibe también lo estable), más
-- nueva que la que tiene, y dentro del porcentaje. null si no hay.
create or replace function public.scale_connect_offer_for(p_conn public.scale_connectors, p_current_version text)
returns public.scale_connect_releases
language sql
stable
security definer
set search_path = public
as $$
  select r.*
    from public.scale_connect_releases r,
         (select coalesce((select c.scale_connect_channel from public.companies c where c.id = p_conn.company_id), 'stable') as ch) co
   where r.active
     and r.rollout_percent > public.scale_connect_rollout_bucket(p_conn.id)
     and (r.channel = 'stable' or (r.channel = 'pilot' and co.ch = 'pilot'))
     and (public.scale_connect_version_key(coalesce(p_current_version, p_conn.version)) is null
          or public.scale_connect_version_key(r.version) > public.scale_connect_version_key(coalesce(p_current_version, p_conn.version)))
   order by public.scale_connect_version_key(r.version) desc, (r.channel = 'stable') desc
   limit 1;
$$;
revoke all on function public.scale_connect_offer_for(public.scale_connectors, text) from public, anon, authenticated;

create or replace function public.scale_connector_update_offer(
  p_connector_id uuid,
  p_secret_hash text,
  p_current_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype := public.scale_connector_auth(p_connector_id, p_secret_hash);
  v_channel text;
  r public.scale_connect_releases%rowtype;
begin
  select coalesce(c.scale_connect_channel, 'stable') into v_channel from public.companies c where c.id = v.company_id;
  r := public.scale_connect_offer_for(v, nullif(btrim(coalesce(p_current_version, '')), ''));
  return jsonb_build_object(
    'ok', true,
    'channel', coalesce(v_channel, 'stable'),
    'offer', case when r.id is null then null else jsonb_build_object(
      'version', r.version, 'channel', r.channel, 'url', r.url, 'sha256', r.sha256, 'size', r.size, 'manifest', r.manifest) end);
end;
$$;

create or replace function public.scale_connector_report_update(p_connector_id uuid, p_secret_hash text, p_report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype := public.scale_connector_auth(p_connector_id, p_secret_hash);
  v_result text := p_report ->> 'result';
  v_clean jsonb;
begin
  if jsonb_typeof(p_report) <> 'object'
     or v_result is null
     or v_result not in ('rechazada', 'bloqueada', 'sin_respaldo', 'ocupado', 'instalada', 'revertida', 'fallo_reversion', 'error') then
    raise exception 'Resultado de actualización inválido';
  end if;
  v_clean := jsonb_build_object(
    'result', v_result,
    'from', case when public.scale_connect_version_key(p_report ->> 'from') is not null then left(p_report ->> 'from', 40) end,
    'to', case when public.scale_connect_version_key(p_report ->> 'to') is not null then left(p_report ->> 'to', 40) end,
    'message', left(p_report ->> 'message', 300),
    'at', now());
  update public.scale_connectors set update_status = v_clean, update_reported_at = now() where id = v.id;
  if v_result in ('rechazada', 'revertida', 'fallo_reversion') then
    insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
    values (v.company_id, v.branch_id, null, 'scale_connector.update', 'scale_connector', v.id::text, v_clean);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.scale_connector_update_offer(uuid, text, text) from public, anon, authenticated;
revoke all on function public.scale_connector_report_update(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.scale_connector_update_offer(uuid, text, text) to service_role;
grant execute on function public.scale_connector_report_update(uuid, text, jsonb) to service_role;

-- ------------------------------------------------------------------------------------------------- administradores
-- Publica una versión (o, si esa versión y canal ya existen CON EL MISMO instalador, la reactiva y cambia el
-- porcentaje). El manifiesto se guarda completo; acá se revisa la forma, no la firma (la firma la verifica la PC).
-- Canal firmado vs. canal de despliegue: 'stable' exige un manifiesto 'general'; 'pilot' acepta 'piloto' o 'general'.
create or replace function public.publish_scale_connect_release(
  p_manifest jsonb,
  p_channel text,
  p_rollout_percent integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  m jsonb := p_manifest;
  v_id uuid;
  v_existing public.scale_connect_releases%rowtype;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('pilot', 'stable') then raise exception 'Canal inválido (pilot | stable)'; end if;
  if p_rollout_percent is null or p_rollout_percent not between 0 and 100 then raise exception 'El porcentaje va de 0 a 100'; end if;
  if m is null or jsonb_typeof(m) <> 'object' then raise exception 'El manifiesto no es un objeto'; end if;
  if (m ->> 'schema') is distinct from '1' or (m ->> 'product') is distinct from 'patagonia-scale-connect' then
    raise exception 'No es un manifiesto de Patagonia Scale Connect';
  end if;
  if public.scale_connect_version_key(m ->> 'version') is null or public.scale_connect_version_key(m ->> 'minVersion') is null then
    raise exception 'Versión inválida en el manifiesto';
  end if;
  if public.scale_connect_version_key(m ->> 'minVersion') > public.scale_connect_version_key(m ->> 'version') then
    raise exception 'minVersion no puede ser mayor que version';
  end if;
  if coalesce(m ->> 'url', '') !~ '^https://[^[:space:]]+$' then raise exception 'La url tiene que ser https'; end if;
  if coalesce(m ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then raise exception 'sha256 inválido'; end if;
  if jsonb_typeof(m -> 'size') <> 'number' or (m ->> 'size')::numeric <= 0 then raise exception 'Tamaño inválido'; end if;
  if coalesce(m ->> 'keyId', '') !~ '^[0-9a-f]{16}$' or length(coalesce(m ->> 'signature', '')) <> 88 then
    raise exception 'El manifiesto no está firmado';
  end if;
  if (p_channel = 'stable' and (m ->> 'channel') is distinct from 'general')
     or (p_channel = 'pilot' and coalesce(m ->> 'channel', '') not in ('piloto', 'general')) then
    raise exception 'El manifiesto está firmado para el canal % y se quiere publicar en %', m ->> 'channel', p_channel;
  end if;

  select * into v_existing from public.scale_connect_releases where version = m ->> 'version' and channel = p_channel for update;
  if v_existing.id is not null then
    if v_existing.sha256 <> m ->> 'sha256' then
      raise exception 'La % ya se publicó en % con otro instalador: subí la versión', m ->> 'version', p_channel;
    end if;
    update public.scale_connect_releases
       set manifest = m, rollout_percent = p_rollout_percent, active = true, updated_at = now()
     where id = v_existing.id
    returning id into v_id;
  else
    insert into public.scale_connect_releases (version, channel, url, sha256, size, min_version, manifest, rollout_percent, published_by)
    values (m ->> 'version', p_channel, m ->> 'url', m ->> 'sha256', (m ->> 'size')::bigint, m ->> 'minVersion', m, p_rollout_percent, v_user)
    returning id into v_id;
  end if;
  insert into public.scale_connect_release_log (release_id, action, user_id, data)
  values (v_id, 'publish', v_user, jsonb_build_object('version', m ->> 'version', 'channel', p_channel, 'rollout_percent', p_rollout_percent, 'sha256', m ->> 'sha256'));
  return v_id;
end;
$$;

-- Frenar (p_active false), reactivar o cambiar el porcentaje de una versión publicada.
create or replace function public.set_scale_connect_release(p_release_id uuid, p_active boolean, p_rollout_percent integer default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connect_releases%rowtype;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_active is null then raise exception 'Falta si queda activa'; end if;
  if p_rollout_percent is not null and p_rollout_percent not between 0 and 100 then raise exception 'El porcentaje va de 0 a 100'; end if;
  update public.scale_connect_releases
     set active = p_active, rollout_percent = coalesce(p_rollout_percent, rollout_percent), updated_at = now()
   where id = p_release_id
  returning * into v;
  if v.id is null then raise exception 'No existe esa versión'; end if;
  insert into public.scale_connect_release_log (release_id, action, user_id, data)
  values (v.id, 'update', auth.uid(), jsonb_build_object('active', v.active, 'rollout_percent', v.rollout_percent));
end;
$$;

create or replace function public.set_company_scale_connect_channel(p_company_id uuid, p_channel text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('pilot', 'stable') then raise exception 'Canal inválido (pilot | stable)'; end if;
  select scale_connect_channel into v_old from public.companies where id = p_company_id for update;
  if not found then raise exception 'No existe esa empresa'; end if;
  update public.companies set scale_connect_channel = p_channel where id = p_company_id;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (p_company_id, null, auth.uid(), 'scale_connect.channel', 'company', p_company_id::text,
          jsonb_build_object('channel', v_old), jsonb_build_object('channel', p_channel));
end;
$$;

-- Versiones publicadas, con cuántas PC ya la tienen y cuántas volvieron atrás.
create or replace function public.list_scale_connect_releases()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.am_i_platform_admin() then coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'version', r.version, 'channel', r.channel, 'url', r.url, 'sha256', r.sha256, 'size', r.size,
             'min_version', r.min_version, 'rollout_percent', r.rollout_percent, 'active', r.active,
             'published_at', r.published_at, 'updated_at', r.updated_at,
             'installed', (select count(*) from public.scale_connectors c where c.status = 'active' and c.version = r.version),
             'rolled_back', (select count(*) from public.scale_connectors c
                              where c.update_status ->> 'to' = r.version and c.update_status ->> 'result' in ('revertida', 'fallo_reversion')))
           order by public.scale_connect_version_key(r.version) desc, r.channel)
      from public.scale_connect_releases r), '[]'::jsonb)
  end;
$$;

revoke all on function public.publish_scale_connect_release(jsonb, text, integer) from public, anon;
revoke all on function public.set_scale_connect_release(uuid, boolean, integer) from public, anon;
revoke all on function public.set_company_scale_connect_channel(uuid, text) from public, anon;
revoke all on function public.list_scale_connect_releases() from public, anon;
grant execute on function public.publish_scale_connect_release(jsonb, text, integer) to authenticated;
grant execute on function public.set_scale_connect_release(uuid, boolean, integer) to authenticated;
grant execute on function public.set_company_scale_connect_channel(uuid, text) to authenticated;
grant execute on function public.list_scale_connect_releases() to authenticated;

insert into public.schema_migrations (version) values ('229_scale_connect_releases') on conflict do nothing;
