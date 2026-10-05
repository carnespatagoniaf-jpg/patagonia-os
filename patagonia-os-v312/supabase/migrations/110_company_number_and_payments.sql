-- Panel de plataforma: número de cliente y control de quién pagó (pedido del
-- dueño, 2026-10-05: "se me hace difícil encontrarlos, tengo que ir fijándome
-- la fecha, todos aparecen igual los que ya pagaron como los que no; estaría
-- bueno identificarlos con un número para ponerles el mismo en el contacto del
-- celular").
--
-- 1) companies.client_number: correlativo (1, 2, 3...) por orden de alta,
--    asignado por trigger (cubre la Edge Function create-client sin tocarla) y
--    que no cambia nunca.
-- 2) companies.paid_until: hasta qué día está pagado el abono. null = nunca se
--    registró un pago. Se mueve con register_company_payment (suma N meses
--    desde paid_until, o desde hoy si ya estaba vencido) o se corrige a mano
--    con set_company_paid_until.
-- 3) company_payments: historial de cada pago registrado (fecha, monto, meses,
--    nota). RLS sin policies: solo se lee/escribe por estas funciones, que
--    exigen am_i_platform_admin().
--
-- Esto es SOLO un registro para nosotros: no cobra nada ni bloquea a ningún
-- cliente (igual que la prueba gratuita, 093). Registrar un pago saca la
-- prueba gratuita (trial_ends_at = null), así el cliente deja de ver el aviso
-- de "tu prueba vence".

-- 1) Número de cliente ------------------------------------------------------
alter table public.companies add column if not exists client_number integer;

with numbered as (
  select id, row_number() over (order by created_at, id) as n
  from public.companies
  where client_number is null
)
update public.companies c
set client_number = numbered.n + coalesce((select max(client_number) from public.companies), 0)
from numbered
where numbered.id = c.id;

create or replace function public.companies_assign_client_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_number is null then
    perform pg_advisory_xact_lock(hashtext('companies_client_number'));
    select coalesce(max(client_number), 0) + 1 into new.client_number from public.companies;
  end if;
  return new;
end;
$$;

revoke all on function public.companies_assign_client_number() from public, anon, authenticated;

drop trigger if exists companies_assign_client_number on public.companies;
create trigger companies_assign_client_number
before insert on public.companies
for each row execute function public.companies_assign_client_number();

create or replace function public.companies_keep_client_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.client_number := old.client_number;
  return new;
end;
$$;

revoke all on function public.companies_keep_client_number() from public, anon, authenticated;

drop trigger if exists companies_keep_client_number on public.companies;
create trigger companies_keep_client_number
before update of client_number on public.companies
for each row execute function public.companies_keep_client_number();

alter table public.companies alter column client_number set not null;
create unique index if not exists companies_client_number_key on public.companies (client_number);

-- 2) y 3) Pagos del abono ---------------------------------------------------
alter table public.companies add column if not exists paid_until date;

create table if not exists public.company_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payment_date date not null,
  amount numeric(14,2),
  months integer not null check (months between 1 and 24),
  paid_until date not null,
  previous_paid_until date,
  note text,
  created_by uuid references auth.users(id),
  -- clock_timestamp (no now()) para que dos pagos en la misma transacción
  -- queden ordenados: "el último pago" depende de esto.
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists company_payments_company_idx on public.company_payments (company_id, payment_date desc);

alter table public.company_payments enable row level security;
-- Sin policies a propósito: solo platform admins, vía las funciones de abajo.

create or replace function public.register_company_payment(
  p_company_id uuid,
  p_months integer,
  p_amount numeric,
  p_payment_date date,
  p_note text
)
returns date
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous date;
  v_today date := public.today_ar();
  v_until date;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_months is null or p_months < 1 or p_months > 24 then
    raise exception 'La cantidad de meses tiene que ser entre 1 y 24';
  end if;
  if p_amount is not null and p_amount < 0 then
    raise exception 'El monto no puede ser negativo';
  end if;

  select paid_until into v_previous from public.companies where id = p_company_id for update;
  if not found then
    raise exception 'Cliente inválido';
  end if;

  -- Si todavía estaba pagado, se suma a partir de ese día (pagó por adelantado);
  -- si ya estaba vencido o nunca pagó, a partir de hoy.
  v_until := (greatest(coalesce(v_previous, v_today), v_today) + make_interval(months => p_months))::date;

  update public.companies
  set paid_until = v_until, trial_ends_at = null
  where id = p_company_id;

  insert into public.company_payments (company_id, payment_date, amount, months, paid_until, previous_paid_until, note, created_by)
  values (p_company_id, coalesce(p_payment_date, v_today), p_amount, p_months, v_until, v_previous, nullif(trim(coalesce(p_note, '')), ''), auth.uid());

  return v_until;
end;
$$;

revoke all on function public.register_company_payment(uuid, integer, numeric, date, text) from public, anon;
grant execute on function public.register_company_payment(uuid, integer, numeric, date, text) to authenticated;

-- Corrección a mano ("me equivoqué", "le regalo un mes", "dejar sin pago").
create or replace function public.set_company_paid_until(p_company_id uuid, p_paid_until date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  update public.companies set paid_until = p_paid_until where id = p_company_id;
  if not found then
    raise exception 'Cliente inválido';
  end if;
end;
$$;

revoke all on function public.set_company_paid_until(uuid, date) from public, anon;
grant execute on function public.set_company_paid_until(uuid, date) to authenticated;

-- Borrar un pago cargado por error: vuelve paid_until a lo que había antes
-- de ese pago, solo si es el último pago de ese cliente (si no, quedaría
-- inconsistente con los posteriores).
create or replace function public.delete_company_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.company_payments%rowtype;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  select * into v_payment from public.company_payments where id = p_payment_id;
  if not found then
    raise exception 'Pago inválido';
  end if;

  if exists (
    select 1 from public.company_payments
    where company_id = v_payment.company_id and created_at > v_payment.created_at
  ) then
    raise exception 'Solo se puede borrar el último pago de este cliente';
  end if;

  delete from public.company_payments where id = p_payment_id;
  update public.companies set paid_until = v_payment.previous_paid_until where id = v_payment.company_id;
end;
$$;

revoke all on function public.delete_company_payment(uuid) from public, anon;
grant execute on function public.delete_company_payment(uuid) to authenticated;

create or replace function public.list_company_payments(p_company_id uuid)
returns table (
  id uuid,
  payment_date date,
  amount numeric,
  months integer,
  paid_until date,
  note text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select cp.id, cp.payment_date, cp.amount, cp.months, cp.paid_until, cp.note, cp.created_at
  from public.company_payments cp
  where cp.company_id = p_company_id and public.am_i_platform_admin()
  order by cp.created_at desc
$$;

revoke all on function public.list_company_payments(uuid) from public, anon;
grant execute on function public.list_company_payments(uuid) to authenticated;

-- Lista del panel: + número, pagado hasta y último pago.
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
  trial_ends_at timestamptz,
  client_number integer,
  paid_until date,
  last_payment_date date,
  last_payment_amount numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id, c.name, c.active, c.created_at,
    (select count(*) from public.branches b where b.company_id = c.id) as branch_count,
    (select count(*) from public.profiles p where p.company_id = c.id) as user_count,
    owner.id as owner_id, owner.full_name as owner_full_name, au.email as owner_email,
    c.contact_phone, c.province, c.city, c.trial_ends_at,
    c.client_number, c.paid_until,
    lp.payment_date as last_payment_date, lp.amount as last_payment_amount
  from public.companies c
  left join lateral (
    select p.id, p.full_name from public.profiles p
    where p.company_id = c.id and p.role in ('owner', 'admin')
    order by (p.role = 'owner') desc, p.id limit 1
  ) owner on true
  left join auth.users au on au.id = owner.id
  left join lateral (
    select cp.payment_date, cp.amount from public.company_payments cp
    where cp.company_id = c.id
    order by cp.created_at desc limit 1
  ) lp on true
  where public.am_i_platform_admin()
  order by c.created_at desc
$$;

revoke all on function public.list_companies_for_admin() from public, anon;
grant execute on function public.list_companies_for_admin() to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('110_company_number_and_payments') on conflict do nothing;
