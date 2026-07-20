-- 1. Crear primero el usuario en Supabase Authentication (el mail con el
--    que vos, el vendedor, vas a loguearte para dar de alta clientes).
-- 2. Copiar su UUID y reemplazar USER_UUID.
-- 3. Ejecutar esto una vez por proyecto compartido.

insert into public.platform_admins (user_id)
values ('USER_UUID');
