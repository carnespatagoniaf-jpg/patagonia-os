-- 073_admin_client_owner_contact.sql redefinió list_companies_for_admin con
-- drop function + create function + grant a authenticated, pero sin el
-- revoke from public que ya usa el resto de las RPC sensibles (ver
-- 052_revoke_public_execute_on_functions.sql) -- eso reabrió el hueco que
-- esa migración había cerrado: quedó ejecutable por anon (usuarios sin
-- sesión). En la práctica no filtra datos (la función ya devuelve vacío si
-- quien llama no es platform admin), pero se cierra igual por consistencia.
revoke all on function public.list_companies_for_admin() from public;
grant execute on function public.list_companies_for_admin() to authenticated;
