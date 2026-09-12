-- La tabla de "Clientes" en Admin (list_companies_for_admin) solo mostraba
-- nombre/sucursales/usuarios/alta/estado -- el nombre y el email del dueño
-- solo se veían una vez, en el cartel de confirmación justo después de
-- crear el cliente (para copiar la contraseña temporal), y se perdían para
-- siempre si no se guardaban en ese momento. Se agrega owner_full_name y
-- owner_email a la función para que quede de forma permanente en esa
-- pantalla -- solo accesible por platform admins (am_i_platform_admin()),
-- el mismo nivel de confianza que ya requiere esta función.
drop function if exists public.list_companies_for_admin();

create function public.list_companies_for_admin()
returns table (
  id uuid,
  name text,
  active boolean,
  created_at timestamptz,
  branch_count bigint,
  user_count bigint,
  owner_full_name text,
  owner_email text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.name,
    c.active,
    c.created_at,
    (select count(*) from public.branches b where b.company_id = c.id) as branch_count,
    (select count(*) from public.profiles p where p.company_id = c.id) as user_count,
    owner.full_name as owner_full_name,
    au.email as owner_email
  from public.companies c
  left join lateral (
    select p.id, p.full_name
    from public.profiles p
    where p.company_id = c.id and p.role = 'owner'
    order by p.id
    limit 1
  ) owner on true
  left join auth.users au on au.id = owner.id
  where public.am_i_platform_admin()
  order by c.created_at desc
$$;

grant execute on function public.list_companies_for_admin() to authenticated;
