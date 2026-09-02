-- Auditoría de seguridad (get_advisors) encontró que las ~67 funciones del
-- sistema tenían permiso de ejecución de más: algunas migraciones viejas
-- (am_i_platform_admin, current_company_id, etc.) nunca revocaron el
-- permiso que Postgres le da por default al rol especial "PUBLIC" (todos,
-- incluido "anon" -- sin login) al crear una función, solo agregaron el
-- grant a "authenticated" al lado. No era explotable -- cada función ya
-- exige auth.uid() no nulo antes de hacer nada -- pero es superficie de
-- más que no hace falta. Cierra el hueco para siempre, incluidas las
-- funciones que se creen de acá en adelante.
revoke execute on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;
