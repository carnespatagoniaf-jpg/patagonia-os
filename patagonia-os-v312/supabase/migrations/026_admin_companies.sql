-- Contraparte de crear clientes (create-client): dejar que el platform
-- admin vea qué empresas ya dio de alta y las active/desactive. Un dueño de
-- empresa no puede llegar a esto por ningún camino — ambas funciones
-- exigen am_i_platform_admin() (025_platform_admins.sql), no un rol de
-- empresa.
create or replace function public.list_companies_for_admin()
returns table (
  id uuid,
  name text,
  active boolean,
  created_at timestamptz,
  branch_count bigint,
  user_count bigint
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
    (select count(*) from public.profiles p where p.company_id = c.id) as user_count
  from public.companies c
  where public.am_i_platform_admin()
  order by c.created_at desc
$$;

grant execute on function public.list_companies_for_admin() to authenticated;

create or replace function public.set_company_active(p_company_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  update public.companies set active = p_active where id = p_company_id;
end;
$$;

grant execute on function public.set_company_active(uuid, boolean) to authenticated;
