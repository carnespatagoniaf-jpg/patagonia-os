-- 228: Scale Connect, ajustes de seguridad de la revisión del 27/11/2026 (sobre 226 y 227).
--
-- Por qué: el motor del conector (227, scale_connector_engine) escribe por las RPC de la web EN NOMBRE DE QUIEN ENCOLÓ
-- el trabajo (request.jwt.claim.sub = scale_jobs.created_by). Revisado como "una PC robada o con el servicio
-- manipulado", tenía tres huecos:
--
-- 1. Escribía con CUALQUIER trabajo en curso, también con una prueba ("test") o una búsqueda de balanzas ("read"), que
--    nunca escriben nada en Patagonia. Una PC que el dueño usa para probar la balanza quedaba con el usuario del dueño
--    para cambiar el formato de etiqueta del local o el catálogo Systel. Ahora: las escrituras solo con un envío
--    ("send"); el reporte a soporte, con cualquiera (es lo que se manda cuando algo falla).
-- 2. Sin vencimiento: un trabajo sigue "running" mientras el conector mande avances (scale_connector_job_progress
--    renueva progress_at), así que una PC manipulada podía tener el usuario de quien encoló para siempre. Ahora el motor
--    se niega con un trabajo tomado hace más de 3 horas (un envío de 10.000 productos tarda mucho menos).
-- 3. La auditoría quedaba a nombre de la persona sin decir que lo hizo una PC. Ahora cada escritura del motor anota
--    además 'scale_connector.engine' (PC, trabajo y acción), a nombre de quien encoló.
--
-- Y en la cola (226, scale_connector_can_take): un trabajo SIN PC asignada lo toma cualquier PC de la sucursal que diga
-- en su latido que ve esa balanza. El latido lo arma la PC, así que una PC podía "decir" que ve todas y quedarse con los
-- envíos de las balanzas de OTRA PC (y con el motor, en nombre de quien los encoló). Ahora, si la balanza está
-- vinculada a una PC (227, scale_profiles.connector_id), solo esa PC toma sus trabajos sin asignar.
--
-- Errores del motor con P0001 (HTTP 400), nunca PT401/PT403 (harían que el conector borre su credencial).
-- No cambia ningún dato. Vuelta atrás: 228_scale_connect_hardening.rollback.sql.

-- ------------------------------------------------------------------------------------------------- cola
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
              and p_conn.seen_scales @> jsonb_build_array(jsonb_build_object('key', p_job.scale_key))
              -- Una balanza vinculada a OTRA PC no es de esta, diga lo que diga su latido.
              and not exists (
                select 1 from public.scale_profiles s
                where s.company_id = p_job.company_id and s.branch_id = p_job.branch_id and s.scale_key = p_job.scale_key
                  and s.connector_id is not null and s.connector_id <> p_conn.id)));
$$;
revoke all on function public.scale_connector_can_take(public.scale_connectors, public.scale_jobs) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------- motor (227 + 1, 2 y 3)
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
  -- (2) Nada de "trabajos eternos": el motor anda solo las primeras 3 horas desde que la PC lo tomó.
  if v_job.claimed_at is null or v_job.claimed_at < now() - interval '3 hours' then
    raise exception 'Este trabajo lleva demasiado tiempo abierto: volvé a mandarlo desde Mis balanzas';
  end if;
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
  -- (1) Escribir en Patagonia es parte de un ENVÍO. Una prueba o una búsqueda de balanzas solo leen.
  if p_action <> 'report' and v_job.kind <> 'send' then
    raise exception 'Este trabajo no es un envío: no puede cambiar nada en Patagonia';
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

  -- (3) Quedó hecho por una PC, no a mano desde la web.
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v.company_id, v_job.branch_id, v_job.created_by, 'scale_connector.engine', 'scale_job', v_job.id::text,
          jsonb_build_object('connector_id', v.id, 'connector_name', v.name, 'action', p_action, 'scale_key', v_job.scale_key));

  perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_prev_claims, ''), true);
  return jsonb_build_object('result', v_result);
end;
$$;

revoke all on function public.scale_connector_engine(uuid, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.scale_connector_engine(uuid, text, uuid, text, jsonb) to service_role;

insert into public.schema_migrations (version) values ('228_scale_connect_hardening') on conflict do nothing;
