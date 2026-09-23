-- Ubicacion de cada cliente (provincia + ciudad) para saber de donde son y
-- poder agruparlos en el panel de plataforma. Uso interno nuestro: no lo ve el
-- cliente. Es texto libre validado en el frontend con la lista de provincias.
alter table public.companies add column if not exists province text;
alter table public.companies add column if not exists city text;

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
  contact_phone text,
  province text,
  city text
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
    c.contact_phone,
    c.province,
    c.city
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

create or replace function public.set_company_location(
  p_company_id uuid,
  p_province text,
  p_city text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  update public.companies
  set province = nullif(btrim(p_province), ''),
      city = nullif(btrim(p_city), '')
  where id = p_company_id;

  if not found then
    raise exception 'Cliente inválido';
  end if;
end;
$$;

revoke all on function public.set_company_location(uuid, text, text) from public;
grant execute on function public.set_company_location(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
