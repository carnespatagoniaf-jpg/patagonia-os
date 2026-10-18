-- Pestaña "Resumen" del panel de plataforma (pedido del dueño, 2026-10-18:
-- "¿qué información más sumaríamos como empresa para el control, para la mejora?").
--
-- 1) companies.deactivated_at: cuándo se dio de baja un cliente (trigger al
--    pasar active a false). Antes no se guardaba: las bajas anteriores a esta
--    migración quedan sin fecha.
-- 2) page_usage: qué pantallas usa cada empresa, por día (un contador). Lo
--    escribe track_page_visit desde la web al cambiar de pantalla. Solo nombre
--    de pantalla, nunca datos del negocio. RLS sin policies.
-- 3) get_platform_summary(): números para el Resumen (cobrado por mes, altas y
--    bajas, pruebas que pasaron a pago, uso de pantallas, preguntas que el chat
--    no supo contestar). Solo platform admins.
-- 4) list_payments_for_admin(desde, hasta): pagos de todos los clientes en un
--    período, para bajar a Excel.

-- 1) Fecha de baja ----------------------------------------------------------
alter table public.companies add column if not exists deactivated_at timestamptz;

create or replace function public.companies_track_deactivation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.active and not new.active then
    new.deactivated_at := now();
  elsif new.active and not old.active then
    new.deactivated_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.companies_track_deactivation() from public, anon, authenticated;

drop trigger if exists companies_track_deactivation on public.companies;
create trigger companies_track_deactivation
before update of active on public.companies
for each row execute function public.companies_track_deactivation();

-- 2) Uso de pantallas -------------------------------------------------------
create table if not exists public.page_usage (
  company_id uuid not null references public.companies(id) on delete cascade,
  page text not null,
  day date not null,
  count integer not null default 1,
  primary key (company_id, page, day)
);

alter table public.page_usage enable row level security;
-- Sin policies a propósito: se escribe con track_page_visit y se lee con get_platform_summary.

create or replace function public.track_page_visit(p_page text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := public.current_company_id();
begin
  -- Sin empresa (platform admin, perfil inactivo) o nombre raro: no se anota nada.
  if v_company is null or p_page is null or p_page !~ '^[a-z][a-z_-]{0,39}$' then
    return;
  end if;
  insert into public.page_usage (company_id, page, day, count)
  values (v_company, p_page, public.today_ar(), 1)
  on conflict (company_id, page, day) do update set count = public.page_usage.count + 1;
end;
$$;

revoke all on function public.track_page_visit(text) from public, anon;
grant execute on function public.track_page_visit(text) to authenticated;

-- 3) Resumen -----------------------------------------------------------------
create or replace function public.get_platform_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := public.today_ar();
  v_month_start date := date_trunc('month', public.today_ar())::date;
  v_result jsonb;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  select jsonb_build_object(
    'monthly', coalesce((
      select jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM'), 'amount', coalesce(p.amount, 0), 'count', coalesce(p.cnt, 0)) order by m.month)
      from generate_series(v_month_start - interval '11 months', v_month_start, interval '1 month') as m(month)
      left join (
        select date_trunc('month', payment_date)::date as month, sum(coalesce(amount, 0)) as amount, count(*) as cnt
        from public.company_payments
        group by 1
      ) p on p.month = m.month::date
    ), '[]'::jsonb),
    'new_this_month', (
      select count(*) from public.companies
      where (created_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_month_start
    ),
    'lost_this_month', coalesce((
      select jsonb_agg(name order by deactivated_at)
      from public.companies
      where not active and (deactivated_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_month_start
    ), '[]'::jsonb),
    'trials_60d', (
      select count(*) from public.companies
      where created_at >= now() - interval '60 days'
    ),
    'trials_60d_paid', (
      select count(*) from public.companies
      where created_at >= now() - interval '60 days' and paid_until is not null
    ),
    'usage_since', (select min(day) from public.page_usage),
    'usage_30d', coalesce((
      select jsonb_agg(jsonb_build_object('page', page, 'companies', companies) order by companies desc, page)
      from (
        select u.page, count(distinct u.company_id) as companies
        from public.page_usage u
        join public.companies c on c.id = u.company_id and c.active
        where u.day > v_today - 30
        group by u.page
      ) x
    ), '[]'::jsonb),
    'unanswered_7d', coalesce((
      select jsonb_agg(jsonb_build_object('question', question, 'count', cnt, 'companies', companies) order by cnt desc, last_at desc)
      from (
        select min(h.question) as question, count(*) as cnt, max(h.created_at) as last_at,
               jsonb_agg(distinct co.name) filter (where co.name is not null) as companies
        from public.help_chat_unanswered h
        left join public.companies co on co.id = h.company_id
        where h.created_at >= now() - interval '7 days'
        -- Misma pregunta con o sin tildes, signos o mayúsculas = una sola.
        group by trim(regexp_replace(translate(lower(h.question), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]+', ' ', 'g'))
        order by count(*) desc, max(h.created_at) desc
        limit 10
      ) q
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_platform_summary() from public, anon;
grant execute on function public.get_platform_summary() to authenticated;

-- 4) Pagos de un período, para Excel --------------------------------------
create or replace function public.list_payments_for_admin(p_from date, p_to date)
returns table (
  client_number integer,
  company_name text,
  payment_date date,
  amount numeric,
  months integer,
  paid_until date,
  note text
)
language sql
stable
security definer
set search_path = public
as $$
  select c.client_number, c.name, cp.payment_date, cp.amount, cp.months, cp.paid_until, cp.note
  from public.company_payments cp
  join public.companies c on c.id = cp.company_id
  where public.am_i_platform_admin()
    and cp.payment_date between p_from and p_to
  order by cp.payment_date, c.client_number
$$;

revoke all on function public.list_payments_for_admin(date, date) from public, anon;
grant execute on function public.list_payments_for_admin(date, date) to authenticated;

insert into public.schema_migrations (version) values ('130_platform_summary') on conflict do nothing;
