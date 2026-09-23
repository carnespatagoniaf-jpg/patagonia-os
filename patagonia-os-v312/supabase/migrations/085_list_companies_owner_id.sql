-- Se necesita el id del dueño (no solo nombre/email) para poder ofrecerle
-- al platform admin un botón de "Resetear contraseña" por cliente, sin
-- tener que buscarlo a mano en el dashboard de Supabase cada vez.
drop function if exists public.list_companies_for_admin();

create function public.list_companies_for_admin()
returns table (
  id uuid,
  name text,
  active boolean,
  created_at timestamptz,
  branch_count bigint,
  user_count bigint,
  owner_id uuid,
  owner_full_name text,
  owner_email text,
  contact_phone text
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
    owner.id as owner_id,
    owner.full_name as owner_full_name,
    au.email as owner_email,
    c.contact_phone
  from public.companies c
  left join lateral (
    select p.id, p.full_name
    from public.profiles p
    where p.company_id = c.id and p.role in ('owner', 'admin')
    order by (p.role = 'owner') desc, p.id
    limit 1
  ) owner on true
  left join auth.users au on au.id = owner.id
  where public.am_i_platform_admin()
  order by c.created_at desc
$$;

revoke all on function public.list_companies_for_admin() from public;
grant execute on function public.list_companies_for_admin() to authenticated;
