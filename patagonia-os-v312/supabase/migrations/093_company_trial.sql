-- Prueba gratuita de 7 dias por cliente. trial_ends_at null = sin vencimiento
-- (cliente pago, o excepcion nuestra). Los clientes que ya existian quedan en
-- null a proposito: hay que marcarlos a mano desde el panel de plataforma.
-- Vencer NO bloquea nada: solo se avisa (al cliente en la app y a nosotros en
-- el panel), porque a veces se hace una excepcion.
alter table public.companies add column if not exists trial_ends_at timestamptz;
alter table public.companies alter column trial_ends_at set default (now() + interval '7 days');

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
  city text,
  trial_ends_at timestamptz
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
    c.city,
    c.trial_ends_at
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

create or replace function public.set_company_trial(p_company_id uuid, p_trial_ends_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  update public.companies set trial_ends_at = p_trial_ends_at where id = p_company_id;

  if not found then
    raise exception 'Cliente inválido';
  end if;
end;
$$;

revoke all on function public.set_company_trial(uuid, timestamptz) from public;
grant execute on function public.set_company_trial(uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
