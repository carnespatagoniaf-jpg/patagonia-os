-- 230 - Centro de diagnóstico de balanzas (panel de plataforma, 2026-11-27).
--
-- Para que soporte vea qué pasa con las balanzas de cada cliente SIN entrar a la PC del local: cuántas balanzas
-- tiene, qué PC con Scale Connect está en línea, cómo salieron los últimos envíos, qué productos rechaza la balanza
-- y qué reportes mandó el cliente con "Enviar a soporte".
--
-- Todo es de LECTURA y solo para administradores de la plataforma (am_i_platform_admin, migración 025). No escribe
-- nada en balanzas, conectores ni en la configuración del cliente. "Marcar resuelto" sigue siendo
-- set_scale_support_report_resolved (migración 100).
--
--   admin_scale_overview()                 una fila por empresa + sucursal con balanzas, Scale Connect, envíos o
--                                          reportes, con un semáforo (verde / amarillo / rojo) y el motivo.
--   admin_scale_company_detail(empresa)    balanzas, conectores, últimos 50 envíos, productos que fallan, últimos
--                                          50 reportes. Las ambigüedades de lectura no se guardan en la base todavía
--                                          ("ambiguities_supported": false).
--   admin_scale_report_log(reporte)        el registro técnico completo, LIMPIO (sin contraseñas, tokens, emails,
--                                          teléfonos ni importes). La web lo vuelve a limpiar (scale-center.ts).
--
-- Las reglas del semáforo son las mismas que scaleTrafficLight() en apps/web/src/features/admin/scale-center.ts.
-- Si cambia una, cambiar la otra (y sus pruebas: tests/sql/230_admin_scale_center.sql, scale-center.test.ts).
--
-- Funciones internas (admin_scale_redact, admin_scale_try_json, admin_scale_semver) revocadas de anon y
-- authenticated: solo las usan las tres de arriba.

-- ------------------------------------------------------------------------------------------------- internas

/** Saca del texto lo que no tiene que ver soporte: credenciales, tokens, emails, teléfonos, CUIT e importes. */
create or replace function public.admin_scale_redact(p_text text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := p_text;
begin
  if v is null then return null; end if;
  -- 1. JSON "clave": valor con una clave sensible → "[oculto]" (el JSON sigue siendo válido).
  v := regexp_replace(v,
    '("(?:password|passwd|contrase(?:ñ|n)a|secret|secreto|secret_hash|code_hash|token|access_token|refresh_token|api_?key|apikey|authorization|service_role(?:_key)?|credential|credencial|cookie|email|mail|correo|tel|telefono|teléfono|phone|celular|whatsapp|cuit|dni|importe|monto|saldo|amount|total_venta|ticket_total|cobrado|pagado|venta|ventas)"\s*:\s*)("(?:[^"\\]|\\.)*"|-?[0-9][0-9.eE+-]*|true|false)',
    '\1"[oculto]"', 'gi');
  -- 2. Texto suelto: token=..., password: ...
  v := regexp_replace(v,
    '\y(password|passwd|contrase(?:ñ|n)a|secret|secreto|token|access_token|refresh_token|api_?key|apikey|service_role_key)(\s*[=:]\s*)(?!\[)[^\s"'',;&}\]]+',
    '\1\2[oculto]', 'gi');
  v := regexp_replace(v, 'Bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [oculto]', 'gi');
  -- 3. JWT y la credencial de Scale Connect (<id>.<secreto>, encabezado x-scale-connector).
  v := regexp_replace(v, 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[token]', 'g');
  v := regexp_replace(v, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[A-Za-z0-9_-]{16,}', '[credencial]', 'g');
  -- 4. Tokens largos al azar (mayúsculas, minúsculas y números, 32 o más): claves de Mercado Pago, secretos.
  v := regexp_replace(v, '\y(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}', '[token]', 'g');
  -- 5. Emails.
  v := regexp_replace(v, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g');
  -- 6. Teléfonos: +54 ... o "11 2787-1634" / "(0299) 15 555-1234" (con guion antes de los últimos 4; así no se
  --    confunden con IP, fechas ni bytes).
  v := regexp_replace(v, '\+54[ -]?9?[ -]?[0-9]{2,4}[ -]?[0-9]{3,4}[ -]?[0-9]{4}(?![0-9])', '[teléfono]', 'g');
  v := regexp_replace(v, '(^|[^0-9.:/-])\(?0?(?:11|2[0-9]{2,3}|3[0-9]{2,3})\)?[ -]?(?:15[ -]?)?[0-9]{3,4}-[0-9]{4}(?![0-9])', '\1[teléfono]', 'g');
  -- 7. CUIT con guiones.
  v := regexp_replace(v, '\y(?:20|23|24|27|30|33|34)-[0-9]{8}-[0-9]\y', '[cuit]', 'g');
  -- 8. Importes con signo $.
  v := regexp_replace(v, '\$ ?-?[0-9][0-9.,]*', '$ [importe]', 'g');
  return v;
end;
$$;

/** El texto como JSON, o null si no es JSON (los reportes viejos son texto suelto). */
create or replace function public.admin_scale_try_json(p_text text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_text is null or p_text !~ '^\s*[\{\[]' then return null; end if;
  return p_text::jsonb;
exception when others then
  return null;
end;
$$;

/** Versión "0.10.2" → {0,10,2} para ordenar bien (como texto "0.10" < "0.9"). */
create or replace function public.admin_scale_semver(p_version text)
returns int[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(coalesce(nullif(regexp_replace(x, '[^0-9]', '', 'g'), ''), '0')::int order by n), '{}'::int[])
  from unnest(string_to_array(split_part(coalesce(p_version, ''), '-', 1), '.')) with ordinality as t(x, n)
  where x <> '';
$$;

revoke all on function public.admin_scale_redact(text) from public, anon, authenticated;
revoke all on function public.admin_scale_try_json(text) from public, anon, authenticated;
revoke all on function public.admin_scale_semver(text) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------- resumen

drop function if exists public.admin_scale_overview();
create or replace function public.admin_scale_overview()
returns table (
  company_id uuid,
  company_name text,
  company_active boolean,
  plan text,
  balanzas_v2 boolean,
  branch_id uuid,
  branch_name text,
  scales_active integer,
  scales_by_brand jsonb,
  duplicate_groups integer,
  connectors_active integer,
  connectors_online integer,
  connectors_stale integer,
  connector_version_min text,
  connector_version_max text,
  connector_last_seen timestamptz,
  last_job_at timestamptz,
  last_job_status text,
  last_job_confirmed integer,
  last_job_requested integer,
  jobs_failed_7d integer,
  jobs_stuck integer,
  reports_open integer,
  last_report_at timestamptz,
  last_open_report_stage text,
  last_open_report_message text,
  light text,
  light_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not coalesce(public.am_i_platform_admin(), false) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  return query
  with keys as (
    select p.company_id, p.branch_id from public.scale_profiles p where p.active and p.merged_into is null
    union select x.company_id, x.branch_id from public.scale_connectors x where x.status = 'active'
    union select r.company_id, r.branch_id from public.scale_support_reports r
    union select j.company_id, j.branch_id from public.scale_jobs j
  ),
  base as (
    select k.company_id, c.name as company_name, c.active as company_active, c.plan,
           coalesce('balanzas_v2' = any (c.features), false) as balanzas_v2,
           k.branch_id, b.name as branch_name,
           s.active_n, s.by_brand, d.groups,
           cn.active_n as conn_active, cn.online_n, cn.stale_n, cn.vmin, cn.vmax, cn.last_seen,
           lj.started_at as lj_at, lj.status as lj_status, lj.confirmed_count as lj_confirmed, lj.requested_count as lj_requested,
           jf.failed_7d, jf.stuck,
           rp.open_n, rp.last_at,
           lr.etapa, lr.mensaje
    from keys k
    join public.companies c on c.id = k.company_id
    left join public.branches b on b.id = k.branch_id
    cross join lateral (
      select coalesce(sum(x.n), 0)::int as active_n, coalesce(jsonb_object_agg(x.brand, x.n), '{}'::jsonb) as by_brand
      from (select coalesce(nullif(p.family, ''), p.brand) as brand, count(*)::int as n
              from public.scale_profiles p
             where p.company_id = k.company_id and p.branch_id is not distinct from k.branch_id and p.active and p.merged_into is null
             group by 1) x
    ) s
    cross join lateral (
      select count(*)::int as groups from (
        select a.family, a.identity
          from public.scale_profiles a
         where a.company_id = k.company_id and a.branch_id is not distinct from k.branch_id
           and a.merged_into is null and a.identity <> '{}'::jsonb
           and exists (select 1 from public.scale_profiles o
                        where o.company_id = a.company_id and o.branch_id = a.branch_id and o.merged_into is null
                          and o.family is not distinct from a.family and o.identity = a.identity and a.scale_key < o.scale_key
                          and not (o.scale_key = any (a.not_same_as) or a.scale_key = any (o.not_same_as)))
         group by a.family, a.identity) g
    ) d
    cross join lateral (
      select count(*)::int as active_n,
             count(*) filter (where x.last_seen_at > now() - interval '2 minutes')::int as online_n,
             count(*) filter (where x.last_seen_at is null or x.last_seen_at < now() - interval '1 day')::int as stale_n,
             (array_agg(x.version order by public.admin_scale_semver(x.version)) filter (where x.version is not null))[1] as vmin,
             (array_agg(x.version order by public.admin_scale_semver(x.version) desc) filter (where x.version is not null))[1] as vmax,
             max(x.last_seen_at) as last_seen
        from public.scale_connectors x
       where x.company_id = k.company_id and x.branch_id is not distinct from k.branch_id and x.status = 'active'
    ) cn
    left join lateral (
      select j.started_at, j.status, j.confirmed_count, j.requested_count
        from public.scale_jobs j
       where j.company_id = k.company_id and j.branch_id is not distinct from k.branch_id
         and j.kind = 'send' and j.status not in ('queued', 'running')
       order by j.started_at desc
       limit 1
    ) lj on true
    cross join lateral (
      select count(*) filter (where j.kind = 'send' and j.status = 'failed' and j.started_at > now() - interval '7 days')::int as failed_7d,
             count(*) filter (where j.status = 'queued' and j.started_at < now() - interval '15 minutes')::int as stuck
        from public.scale_jobs j
       where j.company_id = k.company_id and j.branch_id is not distinct from k.branch_id
         and (j.started_at > now() - interval '7 days' or j.status = 'queued')
    ) jf
    cross join lateral (
      select count(*) filter (where r.resolved_at is null)::int as open_n, max(r.created_at) as last_at
        from public.scale_support_reports r
       where r.company_id = k.company_id and r.branch_id is not distinct from k.branch_id
    ) rp
    left join lateral (
      select left(public.admin_scale_redact(t.j ->> 'etapa'), 120) as etapa,
             left(public.admin_scale_redact(coalesce(t.j ->> 'mensaje', r.note, left(r.log_text, 300))), 300) as mensaje
        from public.scale_support_reports r
        cross join lateral (select public.admin_scale_try_json(r.log_text) as j) t
       where r.company_id = k.company_id and r.branch_id is not distinct from k.branch_id and r.resolved_at is null
       order by r.created_at desc
       limit 1
    ) lr on true
  ),
  judged as (
    select b.*,
           case
             when b.lj_status = 'failed' then array['rojo', 'Falló el último envío a la balanza']
             when b.stuck > 0 then array['rojo', 'Hay envíos esperando una PC que no los toma']
             when b.conn_active > 0 and b.stale_n = b.conn_active then array['rojo', 'Ninguna PC con Scale Connect se conectó en el último día']
             when b.open_n >= 3 then array['rojo', b.open_n || ' reportes sin resolver']
             when b.open_n > 0 then array['amarillo', case when b.open_n = 1 then 'Hay un reporte sin resolver' else 'Hay ' || b.open_n || ' reportes sin resolver' end]
             when b.lj_status = 'partial' then array['amarillo', 'El último envío quedó a medias (' || b.lj_confirmed || ' de ' || b.lj_requested || ' confirmados)']
             when b.failed_7d > 0 then array['amarillo', case when b.failed_7d = 1 then 'Un envío fallado en los últimos 7 días' else b.failed_7d || ' envíos fallados en los últimos 7 días' end]
             when b.stale_n > 0 then array['amarillo', case when b.stale_n = 1 then 'Una PC con Scale Connect no se conecta hace más de un día' else b.stale_n || ' PC con Scale Connect no se conectan hace más de un día' end]
             when b.groups > 0 then array['amarillo', 'Hay balanzas registradas repetidas']
             when b.vmin is distinct from b.vmax then array['amarillo', 'Las PC tienen versiones distintas de Scale Connect']
             else array['verde', 'Sin problemas']
           end as verdict
      from base b
  )
  select j.company_id, j.company_name, j.company_active, j.plan, j.balanzas_v2, j.branch_id, j.branch_name,
         j.active_n, j.by_brand, j.groups, j.conn_active, j.online_n, j.stale_n, j.vmin, j.vmax, j.last_seen,
         j.lj_at, j.lj_status, j.lj_confirmed, j.lj_requested, j.failed_7d, j.stuck, j.open_n, j.last_at,
         j.etapa, j.mensaje, j.verdict[1], j.verdict[2]
    from judged j
   order by case j.verdict[1] when 'rojo' then 0 when 'amarillo' then 1 else 2 end, j.company_name, j.branch_name nulls last;
end;
$$;

revoke all on function public.admin_scale_overview() from public, anon;
grant execute on function public.admin_scale_overview() to authenticated;

-- ------------------------------------------------------------------------------------------------- detalle

create or replace function public.admin_scale_company_detail(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company public.companies%rowtype;
begin
  if not coalesce(public.am_i_platform_admin(), false) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into v_company from public.companies where id = p_company_id;
  if not found then raise exception 'Empresa inválida'; end if;

  return jsonb_build_object(
    'company', jsonb_build_object('id', v_company.id, 'name', v_company.name, 'active', v_company.active, 'plan', v_company.plan,
                                  'balanzas_v2', coalesce('balanzas_v2' = any (v_company.features), false)),
    'scales', coalesce((
      select jsonb_agg(jsonb_build_object(
               'branch_id', p.branch_id, 'branch_name', b.name, 'scale_key', p.scale_key, 'name', p.name,
               'brand', p.brand, 'model', p.model, 'family', p.family, 'identity', p.identity,
               'label_spec', p.label_spec, 'weighed_format', p.weighed_format, 'unit_format', p.unit_format, 'total_format', p.total_format,
               'status', p.status, 'active', p.active, 'install', p.install,
               'connector_id', p.connector_id, 'connector_name', sc.name, 'connector_device', p.connector_device,
               'last_seen_at', p.last_seen_at,
               'last_used_at', greatest(p.last_seen_at, (select max(j.started_at) from public.scale_jobs j
                                                          where j.company_id = p.company_id and j.branch_id = p.branch_id and j.scale_key = p.scale_key)))
             order by b.name, p.active desc, p.created_at)
        from public.scale_profiles p
        left join public.branches b on b.id = p.branch_id
        left join public.scale_connectors sc on sc.id = p.connector_id
       where p.company_id = p_company_id and p.merged_into is null), '[]'::jsonb),
    'connectors', coalesce((
      -- Sin fingerprint_hash ni secret_hash.
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'name', x.name, 'branch_name', b.name, 'version', x.version, 'status', x.status,
               'last_seen_at', x.last_seen_at, 'online', coalesce(x.last_seen_at > now() - interval '2 minutes', false),
               'seen_scales', jsonb_array_length(x.seen_scales), 'paired_at', x.paired_at, 'revoked_at', x.revoked_at)
             order by x.status, x.created_at)
        from public.scale_connectors x
        left join public.branches b on b.id = x.branch_id
       where x.company_id = p_company_id), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(row_to_json(t)::jsonb order by t.started_at desc)
        from (select j.id, b.name as branch_name, j.scale_key, sp.name as scale_name, j.kind, j.source, j.status,
                     j.requested_count, j.confirmed_count, j.failed_count, j.skipped_count,
                     j.started_at, j.finished_at, left(public.admin_scale_redact(j.error_code), 80) as error_code,
                     j.app_version, sc.name as connector_name
                from public.scale_jobs j
                left join public.branches b on b.id = j.branch_id
                left join public.scale_profiles sp on sp.company_id = j.company_id and sp.branch_id = j.branch_id and sp.scale_key = j.scale_key
                left join public.scale_connectors sc on sc.id = j.connector_id
               where j.company_id = p_company_id
               order by j.started_at desc
               limit 50) t), '[]'::jsonb),
    'failed_products', coalesce((
      select jsonb_agg(row_to_json(t)::jsonb order by t.times desc, t.last_at desc)
        from (select coalesce(pr.name, 'PLU ' || coalesce(i.plu, '?')) as product, i.plu,
                     left(public.admin_scale_redact(coalesce(nullif(i.reason, ''), 'sin motivo')), 300) as reason,
                     count(*)::int as times, max(i.created_at) as last_at
                from public.scale_job_items i
                left join public.products pr on pr.id = i.product_id
               where i.company_id = p_company_id and i.status = 'failed' and i.created_at > now() - interval '30 days'
               group by 1, 2, 3
               order by count(*) desc, max(i.created_at) desc
               limit 30) t), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc)
        from (select r.id, b.name as branch_name, pf.full_name as user_name, r.created_at, r.resolved_at,
                     left(public.admin_scale_redact(r.note), 500) as note,
                     left(public.admin_scale_redact(js.j ->> 'etapa'), 120) as etapa,
                     left(public.admin_scale_redact(js.j ->> 'mensaje'), 500) as mensaje,
                     left(public.admin_scale_redact(js.j ->> 'tecnico'), 500) as tecnico,
                     left(js.j ->> 'version', 80) as app_version,
                     length(r.log_text) as log_length
                from public.scale_support_reports r
                left join public.branches b on b.id = r.branch_id
                left join public.profiles pf on pf.id = r.user_id
                cross join lateral (select public.admin_scale_try_json(r.log_text) as j) js
               where r.company_id = p_company_id
               order by r.created_at desc
               limit 50) t), '[]'::jsonb),
    -- Las lecturas ambiguas (dos balanzas que reclaman el mismo código) se resuelven en la web y no se guardan.
    'ambiguities_supported', false,
    'ambiguities', '[]'::jsonb
  );
end;
$$;

revoke all on function public.admin_scale_company_detail(uuid) from public, anon;
grant execute on function public.admin_scale_company_detail(uuid) to authenticated;

-- ------------------------------------------------------------------------------------------------- registro

create or replace function public.admin_scale_report_log(p_report_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v record;
begin
  if not coalesce(public.am_i_platform_admin(), false) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select r.id, r.company_id, c.name as company_name, b.name as branch_name, r.created_at, r.resolved_at,
         r.note, r.log_text, r.connections, r.user_agent
    into v
    from public.scale_support_reports r
    join public.companies c on c.id = r.company_id
    left join public.branches b on b.id = r.branch_id
   where r.id = p_report_id;
  if not found then raise exception 'Reporte inválido'; end if;

  return jsonb_build_object(
    'id', v.id, 'company_id', v.company_id, 'company_name', v.company_name, 'branch_name', v.branch_name,
    'created_at', v.created_at, 'resolved_at', v.resolved_at,
    'note', public.admin_scale_redact(v.note),
    'user_agent', left(v.user_agent, 400),
    'connections', coalesce(public.admin_scale_try_json(public.admin_scale_redact(v.connections::text)), '[]'::jsonb),
    'log_text', public.admin_scale_redact(v.log_text)
  );
end;
$$;

revoke all on function public.admin_scale_report_log(uuid) from public, anon;
grant execute on function public.admin_scale_report_log(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('230_admin_scale_center') on conflict do nothing;
