-- VUELTA ATRÁS de 231_admin_scale_connect_versions.sql: saca las tres lecturas del panel. No toca datos (la 231 no
-- escribe nada). La web deja de mostrar el conteo por versión y el canal del cliente, y sigue andando.

drop function if exists public.admin_scale_connect_release_manifest(uuid);
drop function if exists public.admin_scale_connect_company_channel(uuid);
drop function if exists public.admin_scale_connect_versions();

notify pgrst, 'reload schema';

delete from public.schema_migrations where version = '231_admin_scale_connect_versions';
