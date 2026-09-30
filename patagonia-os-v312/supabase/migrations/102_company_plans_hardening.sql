-- 102 - Ajustes de seguridad de la 101 (avisos del security advisor de Supabase).
-- - Las funciones auxiliares de planes con search_path fijo.
-- - Las funciones de los triggers de límites no se pueden llamar sueltas: se
--   les saca el permiso a authenticated (los triggers siguen andando igual).

alter function public.plan_rank(text) set search_path = public;
alter function public.plan_display_name(text) set search_path = public;
alter function public.plan_limits(text) set search_path = public;

revoke all on function public.enforce_branch_limit() from authenticated, anon;
revoke all on function public.enforce_user_limit() from authenticated, anon;

insert into public.schema_migrations (version) values ('102_company_plans_hardening') on conflict do nothing;
