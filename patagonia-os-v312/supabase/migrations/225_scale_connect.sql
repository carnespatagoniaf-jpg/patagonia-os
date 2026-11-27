-- 225: Patagonia Scale Connect en la nube — vinculación segura de cada PC y cola de trabajos (plan balanzas v2,
-- secciones 5.4 y 5.7). 27/11/2026.
--
-- Por qué: Scale Connect (apps/connector, servicio de Windows) va a ser el dueño de los puertos de las balanzas de
-- cada PC. Para mandarle trabajos desde la web hace falta (1) saber que esa PC es de esa empresa, sin darle acceso a
-- la base, y (2) una cola de trabajos que la PC venga a buscar (solo conexiones salientes: no se abre nada en el
-- router del cliente).
--
-- Qué agrega (aditiva; lo de la 220 sigue igual para la web):
-- 1. scale_connectors: una fila por PC vinculada. Empresa, sucursal por defecto, nombre ("Caja 1"), huella de la PC
--    (hash: nombre del equipo + identificador de Windows; nunca el valor crudo), hash del secreto (el secreto lo
--    genera la Edge Function scale-connect-pair, se devuelve UNA vez y acá solo queda su SHA-256), versión, último
--    latido, balanzas que ve, estado (active | revoked).
-- 2. scale_connector_pairings: códigos de vinculación de 8 caracteres sin ambigüedad (sin 0/O/1/I), válidos 10
--    minutos, de un solo uso, creados por el dueño o un administrador. Se guardan como hash.
-- 3. scale_connector_pair_failures: intentos fallidos de canjear un código (por hash de la IP), para frenar a quien
--    pruebe códigos al azar. Nadie la lee desde la API.
-- 4. scale_jobs (220) suma: connector_id, estado 'queued', payload (lo que hay que mandar, armado del lado de la web
--    o del servidor), claimed_at, progress / progress_at / progress_seq (avance informado por el conector).
-- 5. RPC para la web (sesión de usuario):
--    - create_scale_connector_pairing, list_scale_connectors, revoke_scale_connector, rename_scale_connector:
--      dueño y administrador.
--    - queue_scale_job(scale_key, kind, payload, ...): quienes hoy mandan a las balanzas, SIN solo lectura y SIN
--      contador (dueño, administrador, encargado, producción, cajero).
-- 6. Funciones del conector, SOLO service_role (las llaman las Edge Functions scale-connect-pair y
--    scale-connect-api, nunca la web): canjear el código, latido, tomar el próximo trabajo, informar avance,
--    cerrar el trabajo y traer la configuración de sus balanzas. Todas validan la credencial (id + hash del
--    secreto) y quedan limitadas a la empresa, la sucursal y los trabajos de ESE conector.
--
-- Seguridad:
-- - Lectura por RLS por empresa. Los hashes (secreto, huella, código) no se pueden leer desde la API: permisos por
--   columna. Sin escrituras directas (175) y con zz_accountant_readonly en las tablas nuevas.
-- - Un código vencido, usado o inexistente da el mismo error (no se puede averiguar cuál). 10 intentos fallidos por
--   IP cada 10 minutos y 500 en total cada 10 minutos: con 32^8 códigos posibles, adivinar es inviable.
-- - Revocar cambia el hash guardado por uno al azar: el secreto viejo no vuelve a servir aunque alguien cambie el
--   estado a mano. Los trabajos pendientes de ese conector quedan fallidos.
-- - Tope de 240 pedidos por minuto por conector, 50 conectores activos por empresa, 30 códigos por empresa por día,
--   100 trabajos en cola por empresa, 300 envíos por sucursal por día (igual que la 220).
--
-- La web y el conector ignoran en silencio si esta migración todavía no está.
-- Vuelta atrás: 225_scale_connect.rollback.sql.

-- ------------------------------------------------------------------------------------------------- utilidades
create or replace function public.scale_connect_sha256(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(sha256(convert_to(coalesce(p_text, ''), 'UTF8')), 'hex');
$$;

-- 8 caracteres de 32 posibles (2-9 y A-Z sin I ni O). Azar de gen_random_uuid (pg_strong_random): se usa un byte
-- de cada 4, evitando el de la versión de cada uuid; 256 es múltiplo de 32, así que el módulo no sesga.
create or replace function public.scale_connect_new_code()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bytes bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  v_code text := '';
begin
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i * 4) % 32) + 1, 1);
  end loop;
  return v_code;
end;
$$;

create or replace function public.scale_connect_normalize_code(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g'));
$$;

revoke all on function public.scale_connect_sha256(text) from public, anon, authenticated;
revoke all on function public.scale_connect_new_code() from public, anon, authenticated;
revoke all on function public.scale_connect_normalize_code(text) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------- tablas
create table if not exists public.scale_connectors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 40),
  fingerprint_hash text check (fingerprint_hash is null or fingerprint_hash ~ '^[0-9a-f]{64}$'),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  version text check (version is null or length(version) <= 40),
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  seen_scales jsonb not null default '[]'::jsonb check (jsonb_typeof(seen_scales) = 'array' and jsonb_array_length(seen_scales) <= 50),
  api_window_at timestamptz not null default now(),
  api_calls integer not null default 0,
  paired_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  check ((status = 'revoked') = (revoked_at is not null))
);
create unique index if not exists scale_connectors_secret_idx on public.scale_connectors (secret_hash);
create index if not exists scale_connectors_company_idx on public.scale_connectors (company_id, created_at);
create index if not exists scale_connectors_fingerprint_idx on public.scale_connectors (company_id, fingerprint_hash) where status = 'active';

create table if not exists public.scale_connector_pairings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  connector_id uuid references public.scale_connectors(id) on delete set null,
  check (expires_at <= created_at + interval '10 minutes')
);
create index if not exists scale_connector_pairings_code_idx on public.scale_connector_pairings (code_hash) where used_at is null;
create index if not exists scale_connector_pairings_company_idx on public.scale_connector_pairings (company_id, created_at);

create table if not exists public.scale_connector_pair_failures (
  id bigint generated always as identity primary key,
  client_hash text not null check (client_hash ~ '^[0-9a-f]{64}$'),
  at timestamptz not null default now()
);
create index if not exists scale_connector_pair_failures_client_idx on public.scale_connector_pair_failures (client_hash, at);
create index if not exists scale_connector_pair_failures_at_idx on public.scale_connector_pair_failures (at);

-- ------------------------------------------------------------------------------------------------- scale_jobs
alter table public.scale_jobs add column if not exists connector_id uuid references public.scale_connectors(id) on delete set null;
alter table public.scale_jobs add column if not exists payload jsonb;
alter table public.scale_jobs add column if not exists claimed_at timestamptz;
alter table public.scale_jobs add column if not exists progress jsonb;
alter table public.scale_jobs add column if not exists progress_at timestamptz;
alter table public.scale_jobs add column if not exists progress_seq integer not null default 0;

-- Los checks de estado de la 220 no tienen nombre propio: se buscan por su definición y se reemplazan.
do $mig$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.scale_jobs'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%status%' and pg_get_constraintdef(c.oid) like '%running%'
  loop
    execute format('alter table public.scale_jobs drop constraint %I', v_name);
  end loop;
end $mig$;
alter table public.scale_jobs add constraint scale_jobs_status_check
  check (status in ('queued', 'running', 'done', 'partial', 'failed'));
alter table public.scale_jobs add constraint scale_jobs_finished_check
  check ((status in ('queued', 'running')) = (finished_at is null));
alter table public.scale_jobs drop constraint if exists scale_jobs_payload_check;
alter table public.scale_jobs add constraint scale_jobs_payload_check
  check (payload is null or (jsonb_typeof(payload) = 'object' and length(payload::text) <= 2000000));
alter table public.scale_jobs drop constraint if exists scale_jobs_progress_check;
alter table public.scale_jobs add constraint scale_jobs_progress_check
  check (progress is null or (jsonb_typeof(progress) = 'object' and length(progress::text) <= 2000));

create index if not exists scale_jobs_queue_idx on public.scale_jobs (company_id, started_at) where status = 'queued';
create index if not exists scale_jobs_connector_idx on public.scale_jobs (connector_id, status) where connector_id is not null;

-- ------------------------------------------------------------------------------------------------- RLS y permisos
alter table public.scale_connectors enable row level security;
alter table public.scale_connector_pairings enable row level security;
alter table public.scale_connector_pair_failures enable row level security;

drop policy if exists scale_connectors_read on public.scale_connectors;
create policy scale_connectors_read on public.scale_connectors for select to authenticated using (company_id = public.current_company_id());
drop policy if exists scale_connector_pairings_read on public.scale_connector_pairings;
create policy scale_connector_pairings_read on public.scale_connector_pairings for select to authenticated using (company_id = public.current_company_id());
-- scale_connector_pair_failures: sin políticas (nadie la lee desde la API).

revoke all on table public.scale_connectors, public.scale_connector_pairings, public.scale_connector_pair_failures from anon, authenticated;
-- Por columna: los hashes y el contador de pedidos no se leen desde la API.
grant select (id, company_id, branch_id, name, version, status, last_seen_at, seen_scales, paired_at, created_by, created_at, revoked_at, revoked_by)
  on table public.scale_connectors to authenticated;
grant select (id, company_id, branch_id, created_by, created_at, expires_at, used_at, connector_id)
  on table public.scale_connector_pairings to authenticated;

drop trigger if exists zz_accountant_readonly on public.scale_connectors;
create trigger zz_accountant_readonly before insert or update or delete on public.scale_connectors
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.scale_connector_pairings;
create trigger zz_accountant_readonly before insert or update or delete on public.scale_connector_pairings
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.scale_connector_pair_failures;
create trigger zz_accountant_readonly before insert or update or delete on public.scale_connector_pair_failures
  for each statement execute function public.accountant_readonly_guard();

-- ------------------------------------------------------------------------------------------------- núcleo interno
-- Valida la credencial de un conector y cuenta el pedido. Errores con SQLSTATE PTxxx (PostgREST los devuelve con
-- ese código HTTP): PT401 credencial inválida, PT403 conector revocado, PT429 demasiados pedidos.
create or replace function public.scale_connector_auth(p_connector_id uuid, p_secret_hash text)
returns public.scale_connectors
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype;
begin
  if p_connector_id is null or p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Credencial inválida' using errcode = 'PT401';
  end if;
  select * into v from public.scale_connectors where id = p_connector_id for update;
  if v.id is null or v.secret_hash <> p_secret_hash then
    raise exception 'Credencial inválida' using errcode = 'PT401';
  end if;
  if v.status <> 'active' then
    raise exception 'Esta computadora fue desvinculada' using errcode = 'PT403';
  end if;
  if v.api_window_at < now() - interval '1 minute' then
    update public.scale_connectors set api_window_at = now(), api_calls = 1 where id = v.id;
  elsif v.api_calls >= 240 then
    raise exception 'Demasiados pedidos: esperá un minuto' using errcode = 'PT429';
  else
    update public.scale_connectors set api_calls = api_calls + 1 where id = v.id;
  end if;
  return v;
end;
$$;

-- ¿Este trabajo en cola lo puede tomar este conector? El asignado, o (sin asignar) uno de la misma sucursal que en
-- su último latido dijo que ve esa balanza.
create or replace function public.scale_connector_can_take(p_conn public.scale_connectors, p_job public.scale_jobs)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_job.company_id = p_conn.company_id
     and p_job.status = 'queued'
     and (p_job.connector_id = p_conn.id
          or (p_job.connector_id is null
              and p_conn.branch_id is not null
              and p_job.branch_id = p_conn.branch_id
              and p_conn.seen_scales @> jsonb_build_array(jsonb_build_object('key', p_job.scale_key))));
$$;

-- Agrega resultados por producto a un trabajo (mismas reglas que finish_scale_job de la 220). Devuelve cuántos.
create or replace function public.scale_job_append_items(p_company uuid, p_job_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_n integer;
  v_bad integer;
begin
  if jsonb_typeof(v_items) <> 'array' then raise exception 'Productos inválidos'; end if;
  v_n := jsonb_array_length(v_items);
  if v_n = 0 then return 0; end if;
  if v_n + (select count(*) from public.scale_job_items where job_id = p_job_id) > 10000 then
    raise exception 'Hasta 10.000 productos por envío';
  end if;
  select count(*) into v_bad
  from jsonb_array_elements(v_items) e(x)
  where jsonb_typeof(e.x) <> 'object'
     or coalesce(e.x ->> 'action', '') not in ('write', 'replace', 'delete', 'read', 'verify')
     or coalesce(e.x ->> 'status', '') not in ('confirmed', 'failed', 'skipped', 'pending')
     or length(coalesce(e.x ->> 'plu', '')) > 40
     or (e.x -> 'sent' is not null and jsonb_typeof(e.x -> 'sent') not in ('object', 'null'))
     or (e.x -> 'read_back' is not null and jsonb_typeof(e.x -> 'read_back') not in ('object', 'null'))
     or length(coalesce(e.x ->> 'sent', '')) > 2000
     or length(coalesce(e.x ->> 'read_back', '')) > 2000
     or (coalesce(e.x ->> 'product_id', '') <> '' and (
          (e.x ->> 'product_id') !~ '^[0-9a-fA-F-]{36}$'
          or not exists (select 1 from public.products p where p.id = (e.x ->> 'product_id')::uuid and p.company_id = p_company)));
  if v_bad > 0 then raise exception 'Hay % productos con datos inválidos', v_bad; end if;

  insert into public.scale_job_items (job_id, company_id, product_id, plu, action, status, reason, sent, read_back)
  select p_job_id, p_company,
         nullif(e.x ->> 'product_id', '')::uuid,
         nullif(e.x ->> 'plu', ''),
         e.x ->> 'action',
         e.x ->> 'status',
         left(nullif(e.x ->> 'reason', ''), 300),
         case when jsonb_typeof(e.x -> 'sent') = 'object' then e.x -> 'sent' end,
         case when jsonb_typeof(e.x -> 'read_back') = 'object' then e.x -> 'read_back' end
  from jsonb_array_elements(v_items) e(x);
  return v_n;
end;
$$;

revoke all on function public.scale_connector_auth(uuid, text) from public, anon, authenticated;
revoke all on function public.scale_connector_can_take(public.scale_connectors, public.scale_jobs) from public, anon, authenticated;
revoke all on function public.scale_job_append_items(uuid, uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------- web: vincular
create or replace function public.create_scale_connector_pairing(p_branch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_profile_branch uuid;
  v_branch uuid;
  v_code text;
  v_expires timestamptz := now() + interval '10 minutes';
  v_id uuid;
  v_try integer := 0;
begin
  perform public.require_role(array['owner', 'admin']::text[]);
  select company_id, branch_id into v_company, v_profile_branch from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  v_branch := coalesce(p_branch_id, v_profile_branch);
  if v_branch is not null and (
       not exists (select 1 from public.branches where id = v_branch and company_id = v_company)
       or not public.my_branch_allowed(v_branch)) then
    raise exception 'Sucursal inválida';
  end if;
  if (select count(*) from public.scale_connector_pairings where company_id = v_company and created_at > now() - interval '1 day') >= 30 then
    raise exception 'Se pidieron demasiados códigos hoy. Probá mañana o escribile a soporte.';
  end if;

  -- Un código vigente por persona: pedir otro anula el anterior.
  update public.scale_connector_pairings set expires_at = now()
   where company_id = v_company and created_by = v_user and used_at is null and expires_at > now();

  loop
    v_code := public.scale_connect_new_code();
    exit when not exists (
      select 1 from public.scale_connector_pairings
      where code_hash = public.scale_connect_sha256(v_code) and used_at is null and expires_at > now());
    v_try := v_try + 1;
    if v_try > 5 then raise exception 'No se pudo generar el código. Probá de nuevo.'; end if;
  end loop;

  insert into public.scale_connector_pairings (company_id, branch_id, code_hash, created_by, expires_at)
  values (v_company, v_branch, public.scale_connect_sha256(v_code), v_user, v_expires)
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, v_branch, v_user, 'scale_connector.pairing', 'scale_connector_pairing', v_id::text,
          jsonb_build_object('expires_at', v_expires));

  return jsonb_build_object('code', v_code, 'expires_at', v_expires, 'branch_id', v_branch);
end;
$$;

create or replace function public.list_scale_connectors()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  perform public.require_role(array['owner', 'admin']::text[]);
  select company_id into v_company from public.profiles where id = auth.uid() and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id,
             'name', c.name,
             'branch_id', c.branch_id,
             'branch_name', b.name,
             'version', c.version,
             'status', c.status,
             'last_seen_at', c.last_seen_at,
             -- Latido cada 60 s: 150 s de margen antes de decir "sin conexión".
             'online', c.status = 'active' and c.last_seen_at is not null and c.last_seen_at > now() - interval '150 seconds',
             'scales', c.seen_scales,
             'paired_at', c.paired_at,
             'revoked_at', c.revoked_at)
           order by (c.status = 'revoked'), c.name)
    from public.scale_connectors c
    left join public.branches b on b.id = c.branch_id
    where c.company_id = v_company), '[]'::jsonb);
end;
$$;

create or replace function public.rename_scale_connector(p_connector_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_conn public.scale_connectors%rowtype;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
begin
  perform public.require_role(array['owner', 'admin']::text[]);
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if length(v_name) < 1 or length(v_name) > 40 then raise exception 'El nombre tiene que tener entre 1 y 40 letras'; end if;
  select * into v_conn from public.scale_connectors where id = p_connector_id and company_id = v_company for update;
  if v_conn.id is null then raise exception 'Computadora inexistente'; end if;
  if v_conn.status <> 'active' then raise exception 'Esa computadora está desvinculada'; end if;
  update public.scale_connectors set name = v_name where id = v_conn.id;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company, v_conn.branch_id, v_user, 'scale_connector.rename', 'scale_connector', v_conn.id::text,
          jsonb_build_object('name', v_conn.name), jsonb_build_object('name', v_name));
end;
$$;

create or replace function public.revoke_scale_connector(p_connector_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_conn public.scale_connectors%rowtype;
  v_jobs integer;
begin
  perform public.require_role(array['owner', 'admin']::text[]);
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  select * into v_conn from public.scale_connectors where id = p_connector_id and company_id = v_company for update;
  if v_conn.id is null then raise exception 'Computadora inexistente'; end if;
  if v_conn.status = 'revoked' then return; end if;

  -- El hash nuevo es de un valor al azar que nadie conoce: el secreto viejo deja de servir para siempre.
  update public.scale_connectors
     set status = 'revoked', revoked_at = now(), revoked_by = v_user,
         secret_hash = public.scale_connect_sha256(gen_random_uuid()::text || gen_random_uuid()::text)
   where id = v_conn.id;

  update public.scale_jobs
     set status = 'failed', finished_at = now(), error_code = 'conector_revocado'
   where connector_id = v_conn.id and status in ('queued', 'running');
  get diagnostics v_jobs = row_count;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company, v_conn.branch_id, v_user, 'scale_connector.revoke', 'scale_connector', v_conn.id::text,
          jsonb_build_object('name', v_conn.name, 'version', v_conn.version), jsonb_build_object('jobs_failed', v_jobs));
end;
$$;

-- ------------------------------------------------------------------------------------------------- web: encolar
-- p_payload: {"products": [{"product_id", "plu", "name", "price", ...}], ...}, hasta 10.000 productos y 2 MB.
-- Sin p_connector_id, lo toma el conector de la sucursal que ve esa balanza (latido).
create or replace function public.queue_scale_job(
  p_scale_key text,
  p_kind text,
  p_payload jsonb default '{}'::jsonb,
  p_branch_id uuid default null,
  p_connector_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_profile_branch uuid;
  v_branch uuid;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_products jsonb;
  v_requested integer := 0;
  v_bad integer;
  v_id uuid;
begin
  perform public.require_role(array['owner', 'admin', 'manager', 'production', 'cashier']::text[]);
  select company_id, branch_id into v_company, v_profile_branch from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  v_branch := coalesce(p_branch_id, v_profile_branch);
  if v_branch is null
     or not exists (select 1 from public.branches where id = v_branch and company_id = v_company)
     or not public.my_branch_allowed(v_branch) then
    raise exception 'Sucursal inválida';
  end if;
  if p_scale_key is null or length(btrim(p_scale_key)) = 0 or length(p_scale_key) > 120 then raise exception 'Balanza inválida'; end if;
  if p_kind is null or p_kind not in ('send', 'test', 'read') then raise exception 'Tipo de trabajo inválido'; end if;
  if jsonb_typeof(v_payload) <> 'object' or length(v_payload::text) > 2000000 then raise exception 'Datos del envío inválidos'; end if;

  v_products := v_payload -> 'products';
  if v_products is not null then
    if jsonb_typeof(v_products) <> 'array' then raise exception 'Datos del envío inválidos'; end if;
    v_requested := jsonb_array_length(v_products);
    if v_requested > 10000 then raise exception 'Hasta 10.000 productos por envío'; end if;
    select count(*) into v_bad
    from jsonb_array_elements(v_products) e(x)
    where jsonb_typeof(e.x) <> 'object'
       or (coalesce(e.x ->> 'product_id', '') <> '' and (
            (e.x ->> 'product_id') !~ '^[0-9a-fA-F-]{36}$'
            or not exists (select 1 from public.products p where p.id = (e.x ->> 'product_id')::uuid and p.company_id = v_company)));
    if v_bad > 0 then raise exception 'Hay % productos con datos inválidos', v_bad; end if;
  end if;

  if p_connector_id is not null and not exists (
       select 1 from public.scale_connectors where id = p_connector_id and company_id = v_company and status = 'active') then
    raise exception 'Computadora inválida';
  end if;

  if (select count(*) from public.scale_jobs where company_id = v_company and branch_id = v_branch and started_at > now() - interval '1 day') >= 300 then
    raise exception 'Demasiados envíos registrados hoy en esta sucursal';
  end if;
  if (select count(*) from public.scale_jobs where company_id = v_company and status = 'queued') >= 100 then
    raise exception 'Hay demasiados envíos esperando. Revisá que Scale Connect esté prendido.';
  end if;

  insert into public.scale_jobs (company_id, branch_id, scale_key, kind, created_by, source, status, requested_count, payload, connector_id)
  values (v_company, v_branch, p_scale_key, p_kind, v_user, 'connector', 'queued', v_requested, v_payload, p_connector_id)
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, v_branch, v_user, 'scale_job.queue', 'scale_job', v_id::text,
          jsonb_build_object('scale_key', p_scale_key, 'kind', p_kind, 'requested', v_requested, 'connector_id', p_connector_id));
  return v_id;
end;
$$;

revoke all on function public.create_scale_connector_pairing(uuid) from public, anon;
revoke all on function public.list_scale_connectors() from public, anon;
revoke all on function public.rename_scale_connector(uuid, text) from public, anon;
revoke all on function public.revoke_scale_connector(uuid) from public, anon;
revoke all on function public.queue_scale_job(text, text, jsonb, uuid, uuid) from public, anon;
grant execute on function public.create_scale_connector_pairing(uuid) to authenticated;
grant execute on function public.list_scale_connectors() to authenticated;
grant execute on function public.rename_scale_connector(uuid, text) to authenticated;
grant execute on function public.revoke_scale_connector(uuid) to authenticated;
grant execute on function public.queue_scale_job(text, text, jsonb, uuid, uuid) to authenticated;

-- ------------------------------------------------------------------------------------------------- conector (service_role)
-- Canjear el código. Nunca lanza por un código malo (el intento fallido tiene que quedar anotado): devuelve
-- {"ok": false, "error": "..."}. Si la huella coincide con una PC activa de la empresa y no se eligió nada, devuelve
-- {"ok": false, "error": "elegir", "candidates": [...]} SIN gastar el código ("¿Es Caja 1?").
create or replace function public.scale_connector_redeem_pairing(
  p_code text,
  p_name text,
  p_fingerprint_hash text,
  p_secret_hash text,
  p_version text,
  p_client_hash text,
  p_recover_id uuid default null,
  p_force_new boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.scale_connect_normalize_code(p_code);
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
  v_pair public.scale_connector_pairings%rowtype;
  v_conn public.scale_connectors%rowtype;
  v_candidates jsonb;
  v_id uuid;
begin
  if p_client_hash is null or p_client_hash !~ '^[0-9a-f]{64}$' then raise exception 'Origen inválido'; end if;
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then raise exception 'Secreto inválido'; end if;
  if p_fingerprint_hash is not null and p_fingerprint_hash !~ '^[0-9a-f]{64}$' then raise exception 'Huella inválida'; end if;

  if (select count(*) from public.scale_connector_pair_failures where client_hash = p_client_hash and at > now() - interval '10 minutes') >= 10
     or (select count(*) from public.scale_connector_pair_failures where at > now() - interval '10 minutes') >= 500 then
    return jsonb_build_object('ok', false, 'error', 'demasiados_intentos');
  end if;
  delete from public.scale_connector_pair_failures where at < now() - interval '1 day';

  if v_code !~ '^[2-9A-HJ-NP-Z]{8}$' then
    insert into public.scale_connector_pair_failures (client_hash) values (p_client_hash);
    return jsonb_build_object('ok', false, 'error', 'codigo_invalido');
  end if;
  select * into v_pair from public.scale_connector_pairings
   where code_hash = public.scale_connect_sha256(v_code) and used_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if v_pair.id is null then
    -- Vencido, usado o inexistente: mismo error, para no dar pistas.
    insert into public.scale_connector_pair_failures (client_hash) values (p_client_hash);
    return jsonb_build_object('ok', false, 'error', 'codigo_invalido');
  end if;

  -- "Sí, es Caja 1": misma empresa, activa y MISMA huella.
  if p_recover_id is not null then
    select * into v_conn from public.scale_connectors
     where id = p_recover_id and company_id = v_pair.company_id and status = 'active'
       and p_fingerprint_hash is not null and fingerprint_hash = p_fingerprint_hash
     for update;
    if v_conn.id is null then return jsonb_build_object('ok', false, 'error', 'no_se_puede_recuperar'); end if;
    update public.scale_connectors
       set secret_hash = p_secret_hash, version = coalesce(left(nullif(btrim(p_version), ''), 40), version),
           paired_at = now(), api_calls = 0, api_window_at = now()
     where id = v_conn.id;
    -- Lo que esta PC tenía tomado antes de reinstalar no se va a terminar: queda fallido.
    update public.scale_jobs set status = 'failed', finished_at = now(), error_code = 'reinstalado'
     where connector_id = v_conn.id and status = 'running';
    update public.scale_connector_pairings set used_at = now(), connector_id = v_conn.id where id = v_pair.id;
    insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
    values (v_pair.company_id, v_conn.branch_id, v_pair.created_by, 'scale_connector.recover', 'scale_connector', v_conn.id::text,
            jsonb_build_object('name', v_conn.name, 'version', left(p_version, 40)));
    return jsonb_build_object('ok', true, 'connector_id', v_conn.id, 'name', v_conn.name, 'branch_id', v_conn.branch_id, 'recovered', true);
  end if;

  if not coalesce(p_force_new, false) and p_fingerprint_hash is not null then
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'last_seen_at', c.last_seen_at) order by c.last_seen_at desc nulls last)
      into v_candidates
      from public.scale_connectors c
     where c.company_id = v_pair.company_id and c.status = 'active' and c.fingerprint_hash = p_fingerprint_hash;
    if v_candidates is not null then
      return jsonb_build_object('ok', false, 'error', 'elegir', 'candidates', v_candidates);
    end if;
  end if;

  if length(v_name) < 1 or length(v_name) > 40 then return jsonb_build_object('ok', false, 'error', 'nombre_invalido'); end if;
  if exists (select 1 from public.scale_connectors where company_id = v_pair.company_id and status = 'active' and lower(name) = lower(v_name)) then
    return jsonb_build_object('ok', false, 'error', 'nombre_repetido');
  end if;
  if (select count(*) from public.scale_connectors where company_id = v_pair.company_id and status = 'active') >= 50 then
    return jsonb_build_object('ok', false, 'error', 'demasiados_conectores');
  end if;

  insert into public.scale_connectors (company_id, branch_id, name, fingerprint_hash, secret_hash, version, created_by)
  values (v_pair.company_id, v_pair.branch_id, v_name, p_fingerprint_hash, p_secret_hash, left(nullif(btrim(p_version), ''), 40), v_pair.created_by)
  returning id into v_id;
  update public.scale_connector_pairings set used_at = now(), connector_id = v_id where id = v_pair.id;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_pair.company_id, v_pair.branch_id, v_pair.created_by, 'scale_connector.pair', 'scale_connector', v_id::text,
          jsonb_build_object('name', v_name, 'version', left(p_version, 40)));
  return jsonb_build_object('ok', true, 'connector_id', v_id, 'name', v_name, 'branch_id', v_pair.branch_id, 'recovered', false);
end;
$$;

-- Latido: versión y balanzas que ve ([{"key", "name", "online"}], hasta 50). Devuelve cuántos trabajos esperan.
create or replace function public.scale_connector_heartbeat(
  p_connector_id uuid,
  p_secret_hash text,
  p_version text default null,
  p_scales jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype := public.scale_connector_auth(p_connector_id, p_secret_hash);
  v_scales jsonb := coalesce(p_scales, '[]'::jsonb);
  v_clean jsonb;
  v_queued integer;
begin
  if jsonb_typeof(v_scales) <> 'array' or jsonb_array_length(v_scales) > 50 then raise exception 'Lista de balanzas inválida'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', left(e.x ->> 'key', 120),
           'name', left(coalesce(e.x ->> 'name', e.x ->> 'key'), 60),
           'online', coalesce((e.x ->> 'online')::boolean, false))), '[]'::jsonb)
    into v_clean
    from jsonb_array_elements(v_scales) e(x)
   where jsonb_typeof(e.x) = 'object' and length(btrim(coalesce(e.x ->> 'key', ''))) between 1 and 120;

  update public.scale_connectors
     set last_seen_at = now(), version = coalesce(left(nullif(btrim(p_version), ''), 40), version), seen_scales = v_clean
   where id = v.id
  returning * into v;

  select count(*) into v_queued from public.scale_jobs j where j.company_id = v.company_id and j.status = 'queued' and public.scale_connector_can_take(v, j);
  return jsonb_build_object('ok', true, 'name', v.name, 'branch_id', v.branch_id, 'queued', v_queued, 'server_time', now());
end;
$$;

-- Tomar el próximo trabajo (el más viejo). FOR UPDATE SKIP LOCKED: dos conectores nunca toman el mismo.
-- Antes cierra lo vencido de la empresa: en cola más de un día, o tomado sin avance hace más de 30 minutos.
create or replace function public.scale_connector_claim_job(p_connector_id uuid, p_secret_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype := public.scale_connector_auth(p_connector_id, p_secret_hash);
  v_job public.scale_jobs%rowtype;
begin
  update public.scale_jobs set status = 'failed', finished_at = now(), error_code = 'vencido'
   where company_id = v.company_id and status = 'queued' and started_at < now() - interval '1 day';
  update public.scale_jobs set status = 'failed', finished_at = now(), error_code = 'sin_avance'
   where company_id = v.company_id and status = 'running' and claimed_at is not null
     and coalesce(progress_at, claimed_at) < now() - interval '30 minutes';

  select j.* into v_job from public.scale_jobs j
   where j.company_id = v.company_id and j.status = 'queued' and public.scale_connector_can_take(v, j)
   order by j.started_at, j.id
   limit 1
   for update skip locked;
  if v_job.id is null then return null; end if;

  update public.scale_jobs
     set status = 'running', connector_id = v.id, claimed_at = now(), progress_at = now(), source = 'connector'
   where id = v_job.id;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v.company_id, v_job.branch_id, null, 'scale_job.claim', 'scale_job', v_job.id::text,
          jsonb_build_object('connector_id', v.id, 'scale_key', v_job.scale_key));
  return jsonb_build_object(
    'id', v_job.id, 'kind', v_job.kind, 'scale_key', v_job.scale_key, 'branch_id', v_job.branch_id,
    'requested', v_job.requested_count, 'payload', coalesce(v_job.payload, '{}'::jsonb), 'queued_at', v_job.started_at);
end;
$$;

-- Avance. p_seq crece con cada aviso: si un reintento llega repetido, se ignora (no duplica productos).
create or replace function public.scale_connector_job_progress(
  p_connector_id uuid,
  p_secret_hash text,
  p_job_id uuid,
  p_seq integer,
  p_done integer default 0,
  p_total integer default 0,
  p_text text default null,
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype := public.scale_connector_auth(p_connector_id, p_secret_hash);
  v_job public.scale_jobs%rowtype;
  v_n integer;
begin
  select * into v_job from public.scale_jobs where id = p_job_id and company_id = v.company_id and connector_id = v.id for update;
  if v_job.id is null then raise exception 'Trabajo inexistente' using errcode = 'PT404'; end if;
  if v_job.status <> 'running' then raise exception 'Ese trabajo ya está cerrado' using errcode = 'PT409'; end if;
  if p_seq is null or p_seq < 1 then raise exception 'Secuencia inválida'; end if;
  if p_seq <= v_job.progress_seq then return jsonb_build_object('ok', true, 'duplicate', true); end if;
  v_n := public.scale_job_append_items(v.company_id, v_job.id, p_items);
  update public.scale_jobs
     set progress = jsonb_build_object('done', least(greatest(coalesce(p_done, 0), 0), 10000),
                                       'total', least(greatest(coalesce(p_total, 0), 0), 10000),
                                       'text', left(p_text, 200)),
         progress_at = now(), progress_seq = p_seq
   where id = v_job.id;
  return jsonb_build_object('ok', true, 'items', v_n);
end;
$$;

-- Cierre. Los contadores que falten salen de contar todos los productos informados (avance + cierre).
create or replace function public.scale_connector_finish_job(
  p_connector_id uuid,
  p_secret_hash text,
  p_job_id uuid,
  p_status text,
  p_counters jsonb default '{}'::jsonb,
  p_items jsonb default '[]'::jsonb,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype := public.scale_connector_auth(p_connector_id, p_secret_hash);
  v_job public.scale_jobs%rowtype;
  v_counters jsonb := coalesce(p_counters, '{}'::jsonb);
  v_n integer;
  v_requested integer;
  v_confirmed integer;
  v_failed integer;
  v_skipped integer;
begin
  select * into v_job from public.scale_jobs where id = p_job_id and company_id = v.company_id and connector_id = v.id for update;
  if v_job.id is null then raise exception 'Trabajo inexistente' using errcode = 'PT404'; end if;
  if v_job.status <> 'running' then raise exception 'Ese trabajo ya está cerrado' using errcode = 'PT409'; end if;
  if p_status is null or p_status not in ('done', 'partial', 'failed') then raise exception 'Estado inválido'; end if;
  if jsonb_typeof(v_counters) <> 'object' then raise exception 'Contadores inválidos'; end if;
  v_n := public.scale_job_append_items(v.company_id, v_job.id, p_items);

  v_requested := least(greatest(coalesce((v_counters ->> 'requested')::integer, v_job.requested_count), 0), 10000);
  v_confirmed := least(greatest(coalesce((v_counters ->> 'confirmed')::integer, (select count(*) from public.scale_job_items where job_id = v_job.id and status = 'confirmed')::integer), 0), 10000);
  v_failed := least(greatest(coalesce((v_counters ->> 'failed')::integer, (select count(*) from public.scale_job_items where job_id = v_job.id and status = 'failed')::integer), 0), 10000);
  v_skipped := least(greatest(coalesce((v_counters ->> 'skipped')::integer, (select count(*) from public.scale_job_items where job_id = v_job.id and status = 'skipped')::integer), 0), 10000);

  update public.scale_jobs
     set status = p_status, finished_at = now(), requested_count = v_requested, confirmed_count = v_confirmed,
         failed_count = v_failed, skipped_count = v_skipped, error_code = left(nullif(btrim(p_error), ''), 80),
         app_version = coalesce(app_version, v.version)
   where id = v_job.id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v.company_id, v_job.branch_id, null, 'scale_job.finish', 'scale_job', v_job.id::text,
          jsonb_build_object('connector_id', v.id, 'scale_key', v_job.scale_key, 'status', p_status, 'requested', v_requested,
                             'confirmed', v_confirmed, 'failed', v_failed, 'skipped', v_skipped, 'items', v_n,
                             'error', left(nullif(btrim(p_error), ''), 80)));
  return jsonb_build_object('id', v_job.id, 'status', p_status, 'requested', v_requested, 'confirmed', v_confirmed, 'failed', v_failed, 'skipped', v_skipped);
end;
$$;

-- Configuración: el conector, su empresa (nombre) y las balanzas de SU sucursal. Nada de otras sucursales ni empresas.
create or replace function public.scale_connector_config(p_connector_id uuid, p_secret_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype := public.scale_connector_auth(p_connector_id, p_secret_hash);
begin
  return jsonb_build_object(
    'connector', jsonb_build_object('id', v.id, 'name', v.name, 'branch_id', v.branch_id),
    'company_name', (select name from public.companies where id = v.company_id),
    'branch_name', (select name from public.branches where id = v.branch_id and company_id = v.company_id),
    'scales', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', s.scale_key, 'name', s.name, 'family', s.family, 'brand', s.brand, 'model', s.model,
               'identity', s.identity, 'active', s.active)
             order by s.created_at)
      from public.scale_profiles s
      where v.branch_id is not null and s.company_id = v.company_id and s.branch_id = v.branch_id), '[]'::jsonb));
end;
$$;

revoke all on function public.scale_connector_redeem_pairing(text, text, text, text, text, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.scale_connector_heartbeat(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.scale_connector_claim_job(uuid, text) from public, anon, authenticated;
revoke all on function public.scale_connector_job_progress(uuid, text, uuid, integer, integer, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.scale_connector_finish_job(uuid, text, uuid, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.scale_connector_config(uuid, text) from public, anon, authenticated;
grant execute on function public.scale_connector_redeem_pairing(text, text, text, text, text, text, uuid, boolean) to service_role;
grant execute on function public.scale_connector_heartbeat(uuid, text, text, jsonb) to service_role;
grant execute on function public.scale_connector_claim_job(uuid, text) to service_role;
grant execute on function public.scale_connector_job_progress(uuid, text, uuid, integer, integer, integer, text, jsonb) to service_role;
grant execute on function public.scale_connector_finish_job(uuid, text, uuid, text, jsonb, jsonb, text) to service_role;
grant execute on function public.scale_connector_config(uuid, text) to service_role;

insert into public.schema_migrations (version) values ('225_scale_connect') on conflict do nothing;
