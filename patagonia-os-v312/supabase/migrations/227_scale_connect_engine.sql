-- 227: Scale Connect de punta a punta — qué balanzas tiene cada PC y el motor de "Mi balanza" corriendo en el servicio
-- de Windows contra la nube (plan balanzas v2 §5.4–5.7). 27/11/2026.
--
-- Por qué: con la 226 la PC se vincula y toma trabajos, pero (1) la web no sabe qué balanza está en qué PC y (2) el
-- motor de "Mi balanza" del conector no puede guardar en Patagonia lo que hoy guarda la web al pasar productos (formato
-- de etiqueta de la sucursal, catálogo y vínculos Systel, reporte a soporte). Sin eso, "Enviar productos" por Scale
-- Connect no deja a Mostrador leyendo los tickets.
--
-- Qué agrega (aditiva; la web vieja y el envío por cable siguen igual):
-- 1. scale_profiles.connector_id + connector_device: la balanza está en ESA PC, en ESE puerto. connector_device es la
--    huella física que informó el conector (id local, serie del USB o ubicación, COM, IP:puerto, MAC si la sabe). Nunca
--    datos de la empresa.
-- 2. bind_scale_to_connector (web, dueño/administrador, como register_branch_scale): vincula (o desvincula) una balanza
--    registrada a una PC activa de LA MISMA sucursal. Un mismo puerto de una PC queda en una sola balanza.
-- 3. scale_connect_status (web, quienes encolan: dueño, administrador, encargado, producción, cajero): las PC de la
--    sucursal con "en línea" calculado en el servidor (latido de menos de 2 minutos, sin depender del reloj de la PC del
--    local) y qué balanza está en cuál.
-- 4. scale_connector_heartbeat y scale_connector_config (226) se redefinen: el latido guarda también la huella, la
--    marca, el modelo y la identidad de cada balanza que ve; la configuración devuelve a qué puerto de ESTA PC está
--    vinculada cada balanza.
-- 5. scale_connector_engine (SOLO service_role, la llama scale-connect-api/engine): lo que el motor le pide a Patagonia
--    mientras corre un trabajo. Lee el formato de etiqueta, las balanzas y el catálogo Systel de la sucursal del trabajo,
--    y ESCRIBE por las MISMAS RPC que usa la web (save_branch_scale_config, save_scale_catalog, set_scale_links,
--    set_scale_profile_active, submit_scale_support_report) EN NOMBRE DE QUIEN ENCOLÓ el trabajo: auth.uid() pasa a ser
--    scale_jobs.created_by solo durante esa llamada. Así los roles (178, 221, 224) y la auditoría quedan exactamente
--    como si lo hubiera hecho esa persona desde Mis balanzas. Una cajera que no puede guardar el catálogo Systel desde la
--    web tampoco puede por Scale Connect.
--
-- Seguridad del motor:
-- - Credencial del conector (scale_connector_auth: id + hash, revocado, 240 pedidos/min).
-- - Solo con un trabajo EN CURSO tomado por ESE conector (status running, connector_id = él). Cerrado = 409.
-- - Sucursal = la del trabajo (la eligió la persona al encolar, con my_branch_allowed). Nada de otras sucursales ni
--   empresas.
-- - Lo de una balanza (catálogo, vínculos, encendido) solo para la balanza del trabajo (scale_key).
-- - Errores de validación con P0001 (HTTP 400): nunca PT401/PT403, que harían que el conector borre su credencial.
--
-- La web y el conector ignoran en silencio si esta migración todavía no está (sin columnas = sin Scale Connect en la
-- lista de balanzas; el conector sigue con el motor en memoria).
-- Vuelta atrás: 227_scale_connect_engine.rollback.sql.

-- ------------------------------------------------------------------------------------------------- columnas
alter table public.scale_profiles add column if not exists connector_id uuid references public.scale_connectors(id) on delete set null;
alter table public.scale_profiles add column if not exists connector_device jsonb;
alter table public.scale_profiles drop constraint if exists scale_profiles_connector_device_check;
alter table public.scale_profiles add constraint scale_profiles_connector_device_check
  check (connector_device is null or (jsonb_typeof(connector_device) = 'object' and length(connector_device::text) <= 2000));
create index if not exists scale_profiles_connector_idx on public.scale_profiles (connector_id) where connector_id is not null;

-- ------------------------------------------------------------------------------------------------- huella
-- Deja solo lo que sirve para reconocer el puerto (y acota cada campo). Sin "id" = no sirve.
create or replace function public.scale_connect_clean_device(p_device jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p_device is null or jsonb_typeof(p_device) <> 'object' or length(btrim(coalesce(p_device ->> 'id', ''))) = 0 then null
    else jsonb_strip_nulls(jsonb_build_object(
      'id', left(btrim(p_device ->> 'id'), 80),
      'kind', case when p_device ->> 'kind' in ('serial', 'tcp') then p_device ->> 'kind' end,
      'fingerprint', left(p_device ->> 'fingerprint', 200),
      'source', left(p_device ->> 'source', 20),
      'path', left(p_device ->> 'path', 20),
      'chip', left(p_device ->> 'chip', 40),
      'host', left(p_device ->> 'host', 60),
      'port', case when jsonb_typeof(p_device -> 'port') = 'number' then (p_device -> 'port') end,
      'mac', left(p_device ->> 'mac', 20)))
  end;
$$;
revoke all on function public.scale_connect_clean_device(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------- web: vincular balanza ↔ PC
create or replace function public.bind_scale_to_connector(
  p_branch_id uuid,
  p_scale_key text,
  p_connector_id uuid,
  p_device jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_role text;
  v_conn public.scale_connectors%rowtype;
  v_device jsonb := public.scale_connect_clean_device(p_device);
  v_old public.scale_profiles%rowtype;
begin
  select company_id, role into v_company, v_role from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede cambiar dónde está la balanza'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company) or not public.my_branch_allowed(p_branch_id) then
    raise exception 'Sucursal inválida';
  end if;
  select * into v_old from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key for update;
  if v_old.scale_key is null then raise exception 'La balanza no está registrada en esa sucursal'; end if;

  if p_connector_id is not null then
    select * into v_conn from public.scale_connectors where id = p_connector_id and company_id = v_company and status = 'active';
    if v_conn.id is null then raise exception 'Computadora inválida'; end if;
    if v_conn.branch_id is distinct from p_branch_id then raise exception 'Esa computadora es de otra sucursal'; end if;
    if v_device is null then raise exception 'Falta el puerto de la balanza en esa computadora'; end if;
    -- Un puerto de una PC es una sola balanza: si estaba en otra, se le saca.
    update public.scale_profiles set connector_id = null, connector_device = null
     where company_id = v_company and connector_id = v_conn.id and connector_device ->> 'id' = v_device ->> 'id'
       and not (branch_id = p_branch_id and scale_key = p_scale_key);
  else
    v_device := null;
  end if;

  update public.scale_profiles set connector_id = p_connector_id, connector_device = v_device, updated_by = v_user, updated_at = now()
   where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company, p_branch_id, v_user, 'scale_profile.connector', 'scale_profile', p_scale_key,
          jsonb_build_object('connector_id', v_old.connector_id, 'device', v_old.connector_device),
          jsonb_build_object('connector_id', p_connector_id, 'device', v_device));
end;
$$;

-- ------------------------------------------------------------------------------------------------- web: estado
-- "En línea" = latido de menos de 2 minutos (el conector late cada 60 s), calculado con la hora del servidor.
create or replace function public.scale_connect_status(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  perform public.require_role(array['owner', 'admin', 'manager', 'production', 'cashier']::text[]);
  select company_id into v_company from public.profiles where id = auth.uid() and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company) or not public.my_branch_allowed(p_branch_id) then
    raise exception 'Sucursal inválida';
  end if;
  return jsonb_build_object(
    'server_time', now(),
    'connectors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'version', c.version, 'last_seen_at', c.last_seen_at,
               'online', c.last_seen_at is not null and c.last_seen_at > now() - interval '2 minutes',
               'scales', c.seen_scales)
             order by c.name)
      from public.scale_connectors c
      where c.company_id = v_company and c.status = 'active' and c.branch_id = p_branch_id), '[]'::jsonb),
    'bindings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'scale_key', s.scale_key, 'connector_id', c.id, 'connector_name', c.name,
               'online', c.last_seen_at is not null and c.last_seen_at > now() - interval '2 minutes',
               'last_seen_at', c.last_seen_at, 'device', s.connector_device))
      from public.scale_profiles s
      join public.scale_connectors c on c.id = s.connector_id and c.company_id = v_company and c.status = 'active'
      where s.company_id = v_company and s.branch_id = p_branch_id), '[]'::jsonb));
end;
$$;

revoke all on function public.bind_scale_to_connector(uuid, text, uuid, jsonb) from public, anon;
revoke all on function public.scale_connect_status(uuid) from public, anon;
grant execute on function public.bind_scale_to_connector(uuid, text, uuid, jsonb) to authenticated;
grant execute on function public.scale_connect_status(uuid) to authenticated;

-- ------------------------------------------------------------------------------------------------- conector: latido (226 + huella)
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
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'key', left(e.x ->> 'key', 120),
           'name', left(coalesce(e.x ->> 'name', e.x ->> 'key'), 60),
           'online', coalesce((e.x ->> 'online')::boolean, false),
           'device', public.scale_connect_clean_device(e.x -> 'device'),
           'family', case when e.x ->> 'family' in ('kretz', 'systel') then e.x ->> 'family' end,
           'model', left(e.x ->> 'model', 40),
           'label', left(e.x ->> 'label', 60),
           'identity', case when jsonb_typeof(e.x -> 'identity') = 'object' and length((e.x -> 'identity')::text) <= 300 then e.x -> 'identity' end))), '[]'::jsonb)
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

-- ------------------------------------------------------------------------------------------------- conector: configuración (226 + puerto)
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
               'identity', s.identity, 'active', s.active,
               -- El puerto solo si la balanza está en ESTA PC.
               'device', case when s.connector_id = v.id then s.connector_device end)
             order by s.created_at)
      from public.scale_profiles s
      where v.branch_id is not null and s.company_id = v.company_id and s.branch_id = v.branch_id), '[]'::jsonb));
end;
$$;

-- ------------------------------------------------------------------------------------------------- conector: motor
create or replace function public.scale_connector_engine(
  p_connector_id uuid,
  p_secret_hash text,
  p_job_id uuid,
  p_action text,
  p_args jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.scale_connectors%rowtype := public.scale_connector_auth(p_connector_id, p_secret_hash);
  v_job public.scale_jobs%rowtype;
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_cfg jsonb;
  v_result jsonb := null;
  v_prev_sub text;
  v_prev_claims text;
  v_prev_role text;
begin
  select * into v_job from public.scale_jobs where id = p_job_id and company_id = v.company_id and connector_id = v.id;
  if v_job.id is null then raise exception 'Trabajo inexistente' using errcode = 'PT404'; end if;
  if v_job.status <> 'running' then raise exception 'Ese trabajo ya está cerrado' using errcode = 'PT409'; end if;
  if v_job.branch_id is null then raise exception 'El trabajo no tiene sucursal'; end if;
  if jsonb_typeof(v_args) <> 'object' then raise exception 'Datos inválidos'; end if;
  if p_action in ('load_scale_setup', 'save_scale_catalog', 'set_scale_links', 'set_scale_profile_active')
     and coalesce(v_args ->> 'scale_key', '') <> v_job.scale_key then
    raise exception 'Esa balanza no es la de este trabajo';
  end if;

  -- ---------------------------------------------------------------- lecturas (sucursal del trabajo)
  if p_action = 'load_branch_config' then
    select to_jsonb(x) into v_result from (
      select prefix_length, plu_length, weight_length, weight_divisor, total_length, payload_type
      from public.branch_scale_configs where company_id = v.company_id and branch_id = v_job.branch_id) x;
    return jsonb_build_object('config', v_result);
  elsif p_action = 'list_branch_scales' then
    return jsonb_build_object('scales', coalesce((
      select jsonb_agg(jsonb_build_object('key', s.scale_key, 'active', s.active) order by s.created_at)
      from public.scale_profiles s where s.company_id = v.company_id and s.branch_id = v_job.branch_id), '[]'::jsonb));
  elsif p_action = 'load_scale_setup' then
    select to_jsonb(x) into v_result from (
      select scale_key, brand, weighed_format, unit_format, total_format, amount_decimals, generic_codes, read_at, repeat_window_minutes, active
      from public.scale_profiles where company_id = v.company_id and branch_id = v_job.branch_id and scale_key = v_job.scale_key) x;
    if v_result is null then return jsonb_build_object('profile', null, 'items', '[]'::jsonb); end if;
    return jsonb_build_object('profile', v_result, 'items', coalesce((
      select jsonb_agg(jsonb_build_object('code', i.code, 'name', i.name, 'sale_type', i.sale_type, 'prices', to_jsonb(i.prices),
                                          'ean_type', i.ean_type, 'ean_config', i.ean_config, 'link_kind', i.link_kind, 'product_id', i.product_id)
                       order by i.code)
      from public.scale_catalog_items i
      where i.company_id = v.company_id and i.branch_id = v_job.branch_id and i.scale_key = v_job.scale_key), '[]'::jsonb));
  end if;

  if p_action not in ('save_branch_config', 'save_scale_catalog', 'set_scale_links', 'set_scale_profile_active', 'report') then
    raise exception 'Acción desconocida';
  end if;

  -- ---------------------------------------------------------------- escrituras: las RPC de la web, como quien encoló
  if v_job.created_by is null or not exists (
       select 1 from public.profiles where id = v_job.created_by and company_id = v.company_id and active = true) then
    raise exception 'Quien pidió el envío ya no tiene usuario activo';
  end if;
  v_prev_sub := current_setting('request.jwt.claim.sub', true);
  v_prev_claims := current_setting('request.jwt.claims', true);
  v_prev_role := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.sub', v_job.created_by::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_job.created_by, 'role', 'authenticated')::text, true);

  if p_action = 'save_branch_config' then
    v_cfg := v_args -> 'config';
    if v_cfg is null or jsonb_typeof(v_cfg) <> 'object' then raise exception 'Formato inválido'; end if;
    v_result := to_jsonb(public.save_branch_scale_config(
      v_job.branch_id,
      (v_cfg ->> 'prefixLength')::int,
      (v_cfg ->> 'pluLength')::int,
      (v_cfg ->> 'weightLength')::int,
      (v_cfg ->> 'weightDivisor')::numeric,
      (v_cfg ->> 'totalLength')::int,
      coalesce(v_cfg ->> 'payloadType', 'weight')));
  elsif p_action = 'save_scale_catalog' then
    v_result := public.save_scale_catalog(v_job.branch_id, v_job.scale_key, v_args -> 'profile', v_args -> 'items');
  elsif p_action = 'set_scale_links' then
    v_result := public.set_scale_links(v_job.branch_id, v_job.scale_key, v_args -> 'links');
  elsif p_action = 'set_scale_profile_active' then
    if jsonb_typeof(v_args -> 'active') <> 'boolean' then raise exception 'Valor inválido'; end if;
    perform public.set_scale_profile_active(v_job.branch_id, v_job.scale_key, (v_args ->> 'active')::boolean);
  else
    v_result := to_jsonb(public.submit_scale_support_report(
      left(coalesce(v_args ->> 'note', 'Scale Connect'), 500),
      left(coalesce(v_args ->> 'log_text', ''), 200000),
      '[]'::jsonb,
      left('Patagonia Scale Connect ' || coalesce(v.version, ''), 200),
      v_job.branch_id));
  end if;

  perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);
  return jsonb_build_object('result', v_result);
end;
$$;

revoke all on function public.scale_connector_engine(uuid, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.scale_connector_engine(uuid, text, uuid, text, jsonb) to service_role;
-- La 226 ya dejó latido y configuración solo para service_role; create or replace conserva esos permisos.

insert into public.schema_migrations (version) values ('227_scale_connect_engine') on conflict do nothing;
