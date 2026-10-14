-- Reversión de 120_scale_support_access.sql (sin datos de negocio: solo accesos de soporte).
drop function if exists public.list_scale_support_access();
drop function if exists public.revoke_scale_support_access(uuid);
drop function if exists public.grant_scale_support_access(uuid, integer, text);
drop function if exists public.scale_support_tools_enabled();
drop table if exists public.support_access_grants;
delete from public.schema_migrations where version = '120_scale_support_access';
