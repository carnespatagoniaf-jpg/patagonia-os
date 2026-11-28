-- VUELTA ATRÁS de 230_admin_scale_center.sql: se borran las funciones del Centro de diagnóstico de balanzas.
-- Solo eran de lectura: no cambia ningún dato. El panel de plataforma esconde la pestaña sola si no están (la web
-- muestra "La base todavía no tiene el centro de diagnóstico").

drop function if exists public.admin_scale_report_log(uuid);
drop function if exists public.admin_scale_company_detail(uuid);
drop function if exists public.admin_scale_overview();
drop function if exists public.admin_scale_semver(text);
drop function if exists public.admin_scale_try_json(text);
drop function if exists public.admin_scale_redact(text);

delete from public.schema_migrations where version = '230_admin_scale_center';

notify pgrst, 'reload schema';
