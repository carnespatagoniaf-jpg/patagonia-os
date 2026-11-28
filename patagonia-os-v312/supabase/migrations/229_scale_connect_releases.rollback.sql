-- VUELTA ATRÁS de 229_scale_connect_releases.sql: sin versiones publicadas ni canal por empresa. Las PC dejan de
-- recibir ofertas (scale-connect-api devuelve la configuración sin "update" y /update da error, que el actualizador
-- toma como "sin oferta"). No toca nada de la 226-228.
-- Se pierden: las versiones publicadas y su historial, el canal de cada empresa y el último resultado de cada PC.
-- Las filas 'scale_connector.update' / 'scale_connect.channel' de audit_log quedan.
-- El bucket "scale-connect" queda (con sus instaladores): borrarlo es a mano desde Storage si de verdad se quiere.

drop function if exists public.list_scale_connect_releases();
drop function if exists public.set_company_scale_connect_channel(uuid, text);
drop function if exists public.set_scale_connect_release(uuid, boolean, integer);
drop function if exists public.publish_scale_connect_release(jsonb, text, integer);
drop function if exists public.scale_connector_report_update(uuid, text, jsonb);
drop function if exists public.scale_connector_update_offer(uuid, text, text);
drop function if exists public.scale_connect_offer_for(public.scale_connectors, text);

drop table if exists public.scale_connect_release_log;
drop table if exists public.scale_connect_releases;

revoke select (update_status, update_reported_at) on table public.scale_connectors from authenticated;
alter table public.scale_connectors drop column if exists update_reported_at;
alter table public.scale_connectors drop column if exists update_status;

alter table public.companies drop constraint if exists companies_scale_connect_channel_check;
alter table public.companies drop column if exists scale_connect_channel;

drop function if exists public.scale_connect_rollout_bucket(uuid);
drop function if exists public.scale_connect_version_key(text);

delete from public.schema_migrations where version = '229_scale_connect_releases';
