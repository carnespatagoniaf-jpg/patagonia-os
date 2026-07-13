-- 1. Crear primero el usuario en Supabase Authentication.
-- 2. Copiar su UUID y reemplazar USER_UUID.

insert into public.profiles (
  id, company_id, branch_id, full_name, role, active
) values (
  'USER_UUID',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222221',
  'Francisco',
  'owner',
  true
);
