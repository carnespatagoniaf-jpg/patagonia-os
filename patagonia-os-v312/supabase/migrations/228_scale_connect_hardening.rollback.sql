-- VUELTA ATRÁS de 228_scale_connect_hardening.sql: la cola y el motor de Scale Connect vuelven a ser los de la 226 y
-- la 227, tal cual. Ojo: vuelven los huecos que cierra la 228 (el motor escribe con cualquier trabajo en curso y sin
-- vencimiento, sin anotar que lo hizo una PC; una PC puede tomar trabajos de balanzas vinculadas a otra PC).
-- No cambia ningún dato (las filas 'scale_connector.engine' de audit_log quedan).

-- 226 tal cual.
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
revoke all on function public.scale_connector_can_take(public.scale_connectors, public.scale_jobs) from public, anon, authenticated;

-- 227 tal cual.
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

delete from public.schema_migrations where version = '228_scale_connect_hardening';
