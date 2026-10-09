-- Embudo de ventas del panel de plataforma (pedido del dueño, 2026-10-09:
-- "quiero hacer un proceso de venta para el sistema").
--
-- Los números reales al armarlo: 60 carnicerías dadas de alta (51 en el
-- último mes), 7 pagaron, y de cada 4 que prueban 3 no cargan ni un producto.
-- El problema no es conseguir interesados sino que lleguen a USAR el sistema
-- en la prueba. Por eso el embudo mide el uso real de cada cliente y dice a
-- quién escribirle hoy y por qué.
--
-- 1) platform_leads: interesados que todavía no tienen cuenta (etapas
--    "contacto" y "demo"). Cuando se les da el alta quedan vinculados a la
--    empresa creada (company_id) con etapa "alta".
-- 2) companies.sales_note / sales_contacted_at / sales_lost_reason: nota del
--    vendedor, cuándo se le escribió por última vez (para no repetir el aviso
--    de "escribile hoy") y motivo si se lo da por perdido.
-- 3) list_sales_pipeline_for_admin(): uso real de cada empresa (productos,
--    ventas, cierres de caja, último ingreso). Las etapas y "a quién escribirle
--    hoy" se calculan en la web (sales-pipeline.ts, lógica pura con tests).
--
-- Todo es solo para platform admins (am_i_platform_admin), igual que 110.
-- Las tablas tienen RLS sin policies: solo se tocan por estas funciones.

-- 1) Interesados ------------------------------------------------------------
create table if not exists public.platform_leads (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  contact_name text,
  phone text,
  province text,
  city text,
  stage text not null default 'contacto' check (stage in ('contacto', 'demo', 'alta', 'perdido')),
  source text,
  note text,
  next_contact_on date,
  lost_reason text,
  company_id uuid references public.companies(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists platform_leads_stage_idx on public.platform_leads (stage, next_contact_on);

alter table public.platform_leads enable row level security;
-- Sin policies a propósito.

create or replace function public.list_platform_leads()
returns table (
  id uuid,
  business_name text,
  contact_name text,
  phone text,
  province text,
  city text,
  stage text,
  source text,
  note text,
  next_contact_on date,
  lost_reason text,
  company_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.business_name, l.contact_name, l.phone, l.province, l.city, l.stage, l.source, l.note,
         l.next_contact_on, l.lost_reason, l.company_id, l.created_at, l.updated_at
  from public.platform_leads l
  where public.am_i_platform_admin()
  order by l.updated_at desc
$$;

revoke all on function public.list_platform_leads() from public, anon;
grant execute on function public.list_platform_leads() to authenticated;

-- Crea (p_id null) o actualiza un interesado. Devuelve su id.
create or replace function public.save_platform_lead(
  p_id uuid,
  p_business_name text,
  p_contact_name text,
  p_phone text,
  p_province text,
  p_city text,
  p_stage text,
  p_source text,
  p_note text,
  p_next_contact_on date,
  p_lost_reason text,
  p_company_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if nullif(trim(coalesce(p_business_name, '')), '') is null then
    raise exception 'Ingresá el nombre del negocio';
  end if;
  if p_stage not in ('contacto', 'demo', 'alta', 'perdido') then
    raise exception 'Etapa inválida';
  end if;
  if p_company_id is not null and not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Cliente inválido';
  end if;

  if p_id is null then
    insert into public.platform_leads (business_name, contact_name, phone, province, city, stage, source, note, next_contact_on, lost_reason, company_id, created_by)
    values (
      trim(p_business_name), nullif(trim(coalesce(p_contact_name, '')), ''), nullif(trim(coalesce(p_phone, '')), ''),
      nullif(trim(coalesce(p_province, '')), ''), nullif(trim(coalesce(p_city, '')), ''), p_stage,
      nullif(trim(coalesce(p_source, '')), ''), nullif(trim(coalesce(p_note, '')), ''), p_next_contact_on,
      nullif(trim(coalesce(p_lost_reason, '')), ''), p_company_id, auth.uid()
    )
    returning id into v_id;
  else
    update public.platform_leads set
      business_name = trim(p_business_name),
      contact_name = nullif(trim(coalesce(p_contact_name, '')), ''),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      province = nullif(trim(coalesce(p_province, '')), ''),
      city = nullif(trim(coalesce(p_city, '')), ''),
      stage = p_stage,
      source = nullif(trim(coalesce(p_source, '')), ''),
      note = nullif(trim(coalesce(p_note, '')), ''),
      next_contact_on = p_next_contact_on,
      lost_reason = nullif(trim(coalesce(p_lost_reason, '')), ''),
      company_id = p_company_id,
      updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Interesado inválido';
    end if;
  end if;
  return v_id;
end;
$$;

revoke all on function public.save_platform_lead(uuid, text, text, text, text, text, text, text, text, date, text, uuid) from public, anon;
grant execute on function public.save_platform_lead(uuid, text, text, text, text, text, text, text, text, date, text, uuid) to authenticated;

create or replace function public.delete_platform_lead(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  delete from public.platform_leads where id = p_id;
end;
$$;

revoke all on function public.delete_platform_lead(uuid) from public, anon;
grant execute on function public.delete_platform_lead(uuid) to authenticated;

-- 2) Seguimiento de cada cliente ----------------------------------------------
alter table public.companies add column if not exists sales_note text;
alter table public.companies add column if not exists sales_contacted_at timestamptz;
alter table public.companies add column if not exists sales_lost_reason text;

-- p_mark_contacted = true marca "le escribí ahora". Nota y motivo se guardan
-- tal cual (null o vacío los borra).
create or replace function public.set_company_sales_followup(
  p_company_id uuid,
  p_note text,
  p_lost_reason text,
  p_mark_contacted boolean
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
  update public.companies set
    sales_note = nullif(trim(coalesce(p_note, '')), ''),
    sales_lost_reason = nullif(trim(coalesce(p_lost_reason, '')), ''),
    sales_contacted_at = case when p_mark_contacted then now() else sales_contacted_at end
  where id = p_company_id;
  if not found then
    raise exception 'Cliente inválido';
  end if;
end;
$$;

revoke all on function public.set_company_sales_followup(uuid, text, text, boolean) from public, anon;
grant execute on function public.set_company_sales_followup(uuid, text, text, boolean) to authenticated;

-- 3) Uso real de cada empresa ---------------------------------------------------
create or replace function public.list_sales_pipeline_for_admin()
returns table (
  company_id uuid,
  product_count bigint,
  sale_count bigint,
  sales_last_7d bigint,
  first_sale_at timestamptz,
  last_sale_at timestamptz,
  closed_shift_count bigint,
  purchase_count bigint,
  last_sign_in_at timestamptz,
  sales_note text,
  sales_contacted_at timestamptz,
  sales_lost_reason text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    (select count(*) from public.products p where p.company_id = c.id),
    s.sale_count, s.sales_last_7d, s.first_sale_at, s.last_sale_at,
    (select count(*) from public.pos_shifts ps where ps.company_id = c.id and ps.status = 'closed'),
    (select count(*) from public.purchases pu where pu.company_id = c.id),
    (select max(au.last_sign_in_at) from public.profiles pr join auth.users au on au.id = pr.id where pr.company_id = c.id),
    c.sales_note, c.sales_contacted_at, c.sales_lost_reason
  from public.companies c
  left join lateral (
    select count(*) as sale_count,
           count(*) filter (where ps.created_at > now() - interval '7 days') as sales_last_7d,
           min(ps.created_at) as first_sale_at,
           max(ps.created_at) as last_sale_at
    from public.pos_sales ps where ps.company_id = c.id
  ) s on true
  where public.am_i_platform_admin()
$$;

revoke all on function public.list_sales_pipeline_for_admin() from public, anon;
grant execute on function public.list_sales_pipeline_for_admin() to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('116_sales_pipeline') on conflict do nothing;
