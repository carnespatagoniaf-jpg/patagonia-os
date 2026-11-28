-- VUELTA ATRÁS de 227_scale_connect_engine.sql. Saca el motor de Scale Connect contra la nube y qué balanza está en
-- qué PC; el latido y la configuración del conector vuelven a ser los de la 226.
-- Ojo: se pierde a qué PC estaba vinculada cada balanza (scale_profiles.connector_id/connector_device); los envíos por
-- Scale Connect dejan de ofrecerse en la web hasta reaplicar la 227 y volver a agregar cada balanza "en esta
-- computadora". Las balanzas, sus vínculos Systel y su formato de etiqueta NO se tocan.

drop function if exists public.scale_connector_engine(uuid, text, uuid, text, jsonb);
drop function if exists public.scale_connect_status(uuid);
drop function if exists public.bind_scale_to_connector(uuid, text, uuid, jsonb);

-- 226 tal cual.
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

-- Lo que el latido nuevo guardaba de más (huella, marca, modelo) se limpia: queda {key, name, online} como en la 226.
update public.scale_connectors c
   set seen_scales = coalesce((
     select jsonb_agg(jsonb_build_object('key', e.x ->> 'key', 'name', e.x ->> 'name', 'online', coalesce((e.x ->> 'online')::boolean, false)))
     from jsonb_array_elements(c.seen_scales) e(x)), '[]'::jsonb);

drop function if exists public.scale_connect_clean_device(jsonb);
drop index if exists public.scale_profiles_connector_idx;
alter table public.scale_profiles drop constraint if exists scale_profiles_connector_device_check;
alter table public.scale_profiles drop column if exists connector_device;
alter table public.scale_profiles drop column if exists connector_id;

delete from public.schema_migrations where version = '227_scale_connect_engine';
