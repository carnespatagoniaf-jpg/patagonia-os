-- 231 - Versiones de Scale Connect en el panel de plataforma (pestaña Balanzas, 2026-11-27).
--
-- La 229 ya trae lo que ESCRIBE (publish_scale_connect_release, set_scale_connect_release,
-- set_company_scale_connect_channel) y list_scale_connect_releases. Para el bloque "Versiones de Scale Connect" y el
-- selector de canal del detalle de cada cliente faltaban tres LECTURAS, solo para administradores de plataforma
-- (am_i_platform_admin, migración 025; cualquier otro recibe 42501):
--
--   admin_scale_connect_versions()                cuántas PC activas tienen cada versión (lo que guarda el latido en
--                                                 scale_connectors.version) y cuántas informaron por /update-report que
--                                                 la actualización A esa versión falló o volvió atrás. Es lo ÚLTIMO
--                                                 que informó cada PC (update_status guarda un solo resultado).
--   admin_scale_connect_company_channel(empresa)  'pilot' | 'stable'.
--   admin_scale_connect_release_manifest(versión) el manifiesto firmado guardado (para "Pasar a estable": se vuelve a
--                                                 publicar el MISMO manifiesto con publish_scale_connect_release, que
--                                                 exige que esté firmado para 'general').
--
-- No escribe nada. Necesita la 229. Vuelta atrás: 231_admin_scale_connect_versions.rollback.sql.

create or replace function public.admin_scale_connect_versions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not coalesce(public.am_i_platform_admin(), false) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'version', v.version, 'installed', v.installed, 'online', v.online,
             'failed', v.failed, 'rolled_back', v.rolled_back)
           order by public.admin_scale_semver(v.version) desc)
      from (
        select x.version,
               count(*) filter (where x.kind = 'pc')::int as installed,
               count(*) filter (where x.kind = 'pc' and x.online)::int as online,
               count(*) filter (where x.kind = 'upd' and x.result in ('rechazada', 'bloqueada', 'sin_respaldo', 'error'))::int as failed,
               count(*) filter (where x.kind = 'upd' and x.result in ('revertida', 'fallo_reversion'))::int as rolled_back
          from (
            select 'pc' as kind, c.version, coalesce(c.last_seen_at > now() - interval '2 minutes', false) as online, null::text as result
              from public.scale_connectors c
             where c.status = 'active' and c.version is not null
            union all
            select 'upd', c.update_status ->> 'to', false, c.update_status ->> 'result'
              from public.scale_connectors c
             where c.status = 'active' and c.update_status ->> 'to' is not null
          ) x
         group by x.version
      ) v
     where v.installed > 0 or v.failed > 0 or v.rolled_back > 0), '[]'::jsonb);
end;
$$;

create or replace function public.admin_scale_connect_company_channel(p_company_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v text;
begin
  if not coalesce(public.am_i_platform_admin(), false) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select coalesce(c.scale_connect_channel, 'stable') into v from public.companies c where c.id = p_company_id;
  if not found then raise exception 'Empresa inválida'; end if;
  return v;
end;
$$;

create or replace function public.admin_scale_connect_release_manifest(p_release_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not coalesce(public.am_i_platform_admin(), false) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select r.manifest into v from public.scale_connect_releases r where r.id = p_release_id;
  if not found then raise exception 'No existe esa versión'; end if;
  return v;
end;
$$;

revoke all on function public.admin_scale_connect_versions() from public, anon;
revoke all on function public.admin_scale_connect_company_channel(uuid) from public, anon;
revoke all on function public.admin_scale_connect_release_manifest(uuid) from public, anon;
grant execute on function public.admin_scale_connect_versions() to authenticated;
grant execute on function public.admin_scale_connect_company_channel(uuid) to authenticated;
grant execute on function public.admin_scale_connect_release_manifest(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('231_admin_scale_connect_versions') on conflict do nothing;
