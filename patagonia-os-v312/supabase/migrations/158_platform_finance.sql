-- 158: Finanzas de Patagonia OS como empresa (panel de administración, pestaña "Finanzas"; 25/10/2026).
--
-- El dueño suma un socio (Santiago, 25% → 30%) que aporta USD 20.000 en partes a la cuenta del negocio. Hay que
-- tener todo anotado: cuentas (banco, Mercado Pago, efectivo, en pesos o dólares), ingresos, gastos, aportes y
-- retiros de cada socio, sueldos, qué se pagó con la plata de la inversión, gastos fijos de todos los meses y el
-- resultado de cada mes con lo que le toca a cada socio.
--   * Los abonos de los clientes NO se cargan dos veces: cada pago registrado en company_payments (a mano o por
--     Mercado Pago) entra solo como ingreso en la cuenta marcada "acá entran los abonos" (trigger). Si se borra el
--     pago, se borra el ingreso.
--   * Solo platform admins (am_i_platform_admin). Tablas con RLS y sin políticas: todo por las funciones de abajo.
--   * No tocan nada de las empresas clientes.

create table if not exists public.platform_fin_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  currency text not null default 'ARS' check (currency in ('ARS', 'USD')),
  opening_balance numeric(14,2) not null default 0,
  receives_payments boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.platform_fin_partners (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  share_pct numeric(5,2) not null check (share_pct >= 0 and share_pct <= 100),
  sort integer not null default 0
);

create table if not exists public.platform_fin_recurring (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  category text not null default 'Otros',
  amount numeric(14,2) not null check (amount > 0),
  account_id uuid not null references public.platform_fin_accounts(id),
  day_of_month integer not null default 1 check (day_of_month between 1 and 28),
  from_investment boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.platform_fin_movements (
  id uuid primary key default gen_random_uuid(),
  occurred_on date not null,
  account_id uuid not null references public.platform_fin_accounts(id),
  kind text not null check (kind in ('ingreso', 'gasto', 'aporte', 'retiro', 'sueldo', 'transferencia', 'ajuste')),
  direction text not null check (direction in ('in', 'out')),
  amount numeric(14,2) not null check (amount > 0),
  category text,
  description text,
  partner_id uuid references public.platform_fin_partners(id),
  from_investment boolean not null default false,
  company_payment_id uuid unique references public.company_payments(id) on delete cascade,
  transfer_id uuid,
  recurring_id uuid references public.platform_fin_recurring(id) on delete set null,
  recurring_month date,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (recurring_id, recurring_month)
);
create index if not exists platform_fin_movements_date on public.platform_fin_movements (occurred_on);

alter table public.platform_fin_accounts enable row level security;
alter table public.platform_fin_partners enable row level security;
alter table public.platform_fin_recurring enable row level security;
alter table public.platform_fin_movements enable row level security;

-- Regla de 155: toda tabla nueva lleva el bloqueo de solo lectura del rol Contador.
do $$
declare t text;
begin
  foreach t in array array['platform_fin_accounts', 'platform_fin_partners', 'platform_fin_recurring', 'platform_fin_movements'] loop
    execute format('drop trigger if exists zz_accountant_readonly on public.%I', t);
    execute format('create trigger zz_accountant_readonly before insert or update or delete on public.%I for each statement execute function public.accountant_readonly_guard()', t);
  end loop;
end $$;

-- Socios de arranque (editables desde el panel).
insert into public.platform_fin_partners (name, share_pct, sort)
select * from (values ('Socio A', 75::numeric, 1), ('Santiago', 25::numeric, 2)) v
where not exists (select 1 from public.platform_fin_partners);

create or replace function public.platform_fin_guard()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'Solo los administradores de Patagonia';
  end if;
end;
$$;

-- Abono de un cliente → ingreso en la cuenta que recibe los abonos.
create or replace function public.company_payments_to_finance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_account uuid;
begin
  if coalesce(new.amount, 0) <= 0 then return null; end if;
  select id into v_account from public.platform_fin_accounts where receives_payments and active order by created_at limit 1;
  if v_account is null then return null; end if;
  begin
    insert into public.platform_fin_movements (occurred_on, account_id, kind, direction, amount, category, description, company_payment_id, created_by)
    select new.payment_date, v_account, 'ingreso', 'in', new.amount, 'Abonos de clientes',
           coalesce(c.name, 'Cliente') || ' · ' || new.months || (case when new.months = 1 then ' mes' else ' meses' end), new.id, new.created_by
    from public.companies c where c.id = new.company_id
    on conflict (company_payment_id) do nothing;
  exception when others then
    null; -- un ingreso sin anotar se trae después con "Traer cobros"; nunca frena el registro del pago
  end;
  return null;
end;
$$;

drop trigger if exists company_payments_to_finance on public.company_payments;
create trigger company_payments_to_finance after insert on public.company_payments
  for each row execute function public.company_payments_to_finance();

-- Todo lo de la pestaña en una llamada.
create or replace function public.fin_overview(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  perform public.platform_fin_guard();
  return jsonb_build_object(
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'currency', a.currency, 'openingBalance', a.opening_balance,
        'receivesPayments', a.receives_payments, 'active', a.active,
        'balance', a.opening_balance + coalesce((select sum(case when m.direction = 'in' then m.amount else -m.amount end)
                                                  from public.platform_fin_movements m where m.account_id = a.id), 0)
      ) order by a.created_at) from public.platform_fin_accounts a), '[]'::jsonb),
    'partners', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'sharePct', p.share_pct) order by p.sort, p.name)
                          from public.platform_fin_partners p), '[]'::jsonb),
    'recurring', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'category', r.category, 'amount', r.amount,
                            'accountId', r.account_id, 'dayOfMonth', r.day_of_month, 'fromInvestment', r.from_investment, 'active', r.active) order by r.day_of_month, r.name)
                           from public.platform_fin_recurring r), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', m.id, 'date', m.occurred_on, 'accountId', m.account_id, 'kind', m.kind, 'direction', m.direction,
                            'amount', m.amount, 'category', m.category, 'description', m.description, 'partnerId', m.partner_id,
                            'fromInvestment', m.from_investment, 'fromPayment', m.company_payment_id is not null,
                            'transferId', m.transfer_id, 'recurring', m.recurring_id is not null) order by m.occurred_on desc, m.created_at desc)
                           from public.platform_fin_movements m where m.occurred_on >= v_from and m.occurred_on < v_to), '[]'::jsonb),
    -- Para la inversión y los totales por socio: todo, desde siempre, por moneda.
    'investment', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'partnerId', x.partner_id, 'contributed', x.contributed, 'withdrawn', x.withdrawn, 'salaries', x.salaries))
                            from (select a.currency, m.partner_id,
                                         sum(m.amount) filter (where m.kind = 'aporte') contributed,
                                         sum(m.amount) filter (where m.kind = 'retiro') withdrawn,
                                         sum(m.amount) filter (where m.kind = 'sueldo') salaries
                                  from public.platform_fin_movements m join public.platform_fin_accounts a on a.id = m.account_id
                                  where m.partner_id is not null group by 1, 2) x), '[]'::jsonb),
    'investmentSpent', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'amount', x.amount))
                                 from (select a.currency, sum(m.amount) amount from public.platform_fin_movements m
                                       join public.platform_fin_accounts a on a.id = m.account_id
                                       where m.from_investment and m.direction = 'out' group by 1) x), '[]'::jsonb),
    -- Últimos 12 meses: ingresos y gastos (gastos + sueldos) por moneda.
    'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', x.month, 'currency', x.currency, 'income', x.income, 'expenses', x.expenses) order by x.month)
                         from (select to_char(date_trunc('month', m.occurred_on), 'YYYY-MM') as month, a.currency,
                                      coalesce(sum(m.amount) filter (where m.kind = 'ingreso'), 0) income,
                                      coalesce(sum(m.amount) filter (where m.kind in ('gasto', 'sueldo')), 0) expenses
                               from public.platform_fin_movements m join public.platform_fin_accounts a on a.id = m.account_id
                               where m.occurred_on >= (v_from - interval '11 months') and m.occurred_on < v_to
                               group by 1, 2) x), '[]'::jsonb)
  );
end;
$$;

create or replace function public.fin_save_account(p_id uuid, p_name text, p_currency text, p_opening numeric, p_receives_payments boolean, p_active boolean default true)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  perform public.platform_fin_guard();
  if p_currency not in ('ARS', 'USD') then raise exception 'Moneda inválida'; end if;
  if p_id is null then
    insert into public.platform_fin_accounts (name, currency, opening_balance, receives_payments, active)
    values (trim(p_name), p_currency, coalesce(p_opening, 0), coalesce(p_receives_payments, false), coalesce(p_active, true)) returning id into v_id;
  else
    update public.platform_fin_accounts set name = trim(p_name), currency = p_currency, opening_balance = coalesce(p_opening, 0),
      receives_payments = coalesce(p_receives_payments, false), active = coalesce(p_active, true) where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Cuenta inválida'; end if;
  end if;
  -- Una sola cuenta recibe los abonos.
  if coalesce(p_receives_payments, false) then
    update public.platform_fin_accounts set receives_payments = false where id <> v_id and receives_payments;
  end if;
  return v_id;
end;
$$;

create or replace function public.fin_save_movement(
  p_id uuid, p_date date, p_account_id uuid, p_kind text, p_amount numeric, p_category text, p_description text,
  p_partner_id uuid default null, p_from_investment boolean default false, p_direction text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_direction text;
  v_id uuid;
begin
  perform public.platform_fin_guard();
  if p_kind not in ('ingreso', 'gasto', 'aporte', 'retiro', 'sueldo', 'ajuste') then raise exception 'Tipo inválido'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto tiene que ser mayor a 0'; end if;
  if not exists (select 1 from public.platform_fin_accounts where id = p_account_id) then raise exception 'Cuenta inválida'; end if;
  if p_kind in ('aporte', 'retiro', 'sueldo') and p_partner_id is null then raise exception 'Elegí el socio'; end if;
  v_direction := case when p_kind in ('ingreso', 'aporte') then 'in'
                      when p_kind in ('gasto', 'retiro', 'sueldo') then 'out'
                      else p_direction end;
  if v_direction not in ('in', 'out') then raise exception 'Elegí si el ajuste suma o resta'; end if;
  if p_id is null then
    insert into public.platform_fin_movements (occurred_on, account_id, kind, direction, amount, category, description, partner_id, from_investment)
    values (coalesce(p_date, current_date), p_account_id, p_kind, v_direction, p_amount, nullif(trim(coalesce(p_category, '')), ''),
            nullif(trim(coalesce(p_description, '')), ''), p_partner_id, coalesce(p_from_investment, false) and v_direction = 'out')
    returning id into v_id;
  else
    update public.platform_fin_movements set occurred_on = coalesce(p_date, occurred_on), account_id = p_account_id, kind = p_kind,
      direction = v_direction, amount = p_amount, category = nullif(trim(coalesce(p_category, '')), ''),
      description = nullif(trim(coalesce(p_description, '')), ''), partner_id = p_partner_id,
      from_investment = coalesce(p_from_investment, false) and v_direction = 'out'
    where id = p_id and company_payment_id is null and transfer_id is null returning id into v_id;
    if v_id is null then raise exception 'Ese movimiento no se puede cambiar acá (los abonos se cambian en Clientes)'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.fin_delete_movement(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.platform_fin_movements%rowtype;
begin
  perform public.platform_fin_guard();
  select * into v_row from public.platform_fin_movements where id = p_id;
  if v_row.id is null then raise exception 'Movimiento inválido'; end if;
  if v_row.company_payment_id is not null then raise exception 'Es un abono de un cliente: se borra desde Clientes → Pagos'; end if;
  if v_row.transfer_id is not null then
    delete from public.platform_fin_movements where transfer_id = v_row.transfer_id;
  else
    delete from public.platform_fin_movements where id = p_id;
  end if;
end;
$$;

-- Pasar plata de una cuenta a otra; con montos distintos sirve para cambiar dólares a pesos.
create or replace function public.fin_transfer(p_date date, p_from uuid, p_to uuid, p_amount_from numeric, p_amount_to numeric, p_description text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_transfer uuid := gen_random_uuid();
begin
  perform public.platform_fin_guard();
  if p_from = p_to then raise exception 'Elegí dos cuentas distintas'; end if;
  if coalesce(p_amount_from, 0) <= 0 or coalesce(p_amount_to, 0) <= 0 then raise exception 'Los montos tienen que ser mayores a 0'; end if;
  if (select count(*) from public.platform_fin_accounts where id in (p_from, p_to)) <> 2 then raise exception 'Cuenta inválida'; end if;
  insert into public.platform_fin_movements (occurred_on, account_id, kind, direction, amount, category, description, transfer_id)
  values (coalesce(p_date, current_date), p_from, 'transferencia', 'out', p_amount_from, 'Transferencia', nullif(trim(coalesce(p_description, '')), ''), v_transfer),
         (coalesce(p_date, current_date), p_to, 'transferencia', 'in', p_amount_to, 'Transferencia', nullif(trim(coalesce(p_description, '')), ''), v_transfer);
  return v_transfer;
end;
$$;

create or replace function public.fin_save_recurring(p_id uuid, p_name text, p_category text, p_amount numeric, p_account_id uuid, p_day integer, p_from_investment boolean, p_active boolean default true)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  perform public.platform_fin_guard();
  if p_id is null then
    insert into public.platform_fin_recurring (name, category, amount, account_id, day_of_month, from_investment, active)
    values (trim(p_name), coalesce(nullif(trim(p_category), ''), 'Otros'), p_amount, p_account_id, greatest(1, least(28, coalesce(p_day, 1))), coalesce(p_from_investment, false), coalesce(p_active, true))
    returning id into v_id;
  else
    update public.platform_fin_recurring set name = trim(p_name), category = coalesce(nullif(trim(p_category), ''), 'Otros'), amount = p_amount,
      account_id = p_account_id, day_of_month = greatest(1, least(28, coalesce(p_day, 1))), from_investment = coalesce(p_from_investment, false),
      active = coalesce(p_active, true) where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Gasto fijo inválido'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.fin_delete_recurring(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.platform_fin_guard();
  delete from public.platform_fin_recurring where id = p_id; -- los gastos ya anotados quedan
end;
$$;

-- Anota los gastos fijos del mes actual cuyo día ya llegó (una vez por mes cada uno). La llama la pestaña al abrir.
create or replace function public.fin_apply_recurring()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_month date := date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires'))::date;
  v_count integer;
begin
  perform public.platform_fin_guard();
  insert into public.platform_fin_movements (occurred_on, account_id, kind, direction, amount, category, description, from_investment, recurring_id, recurring_month)
  select v_month + (r.day_of_month - 1), r.account_id, 'gasto', 'out', r.amount, r.category, r.name, r.from_investment, r.id, v_month
  from public.platform_fin_recurring r
  where r.active and v_month + (r.day_of_month - 1) <= v_today and v_month + (r.day_of_month - 1) >= r.created_at::date
  on conflict (recurring_id, recurring_month) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.fin_save_partners(p_partners jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_total numeric;
  v_item jsonb;
  v_i integer := 0;
begin
  perform public.platform_fin_guard();
  select coalesce(sum((x->>'sharePct')::numeric), 0) into v_total from jsonb_array_elements(p_partners) x;
  if v_total <> 100 then raise exception 'Los porcentajes tienen que sumar 100 (suman %)', v_total; end if;
  for v_item in select * from jsonb_array_elements(p_partners) loop
    v_i := v_i + 1;
    update public.platform_fin_partners set name = trim(v_item->>'name'), share_pct = (v_item->>'sharePct')::numeric, sort = v_i
    where id = (v_item->>'id')::uuid;
  end loop;
end;
$$;

-- Trae como ingreso los abonos ya registrados desde una fecha (los anteriores a tener la cuenta configurada).
create or replace function public.fin_import_payments(p_from date)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_account uuid;
  v_count integer;
begin
  perform public.platform_fin_guard();
  select id into v_account from public.platform_fin_accounts where receives_payments and active order by created_at limit 1;
  if v_account is null then raise exception 'Primero marcá la cuenta donde entran los abonos'; end if;
  insert into public.platform_fin_movements (occurred_on, account_id, kind, direction, amount, category, description, company_payment_id, created_by)
  select p.payment_date, v_account, 'ingreso', 'in', p.amount, 'Abonos de clientes',
         coalesce(c.name, 'Cliente') || ' · ' || p.months || (case when p.months = 1 then ' mes' else ' meses' end), p.id, p.created_by
  from public.company_payments p left join public.companies c on c.id = p.company_id
  where p.payment_date >= p_from and coalesce(p.amount, 0) > 0
  on conflict (company_payment_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.platform_fin_guard() from public, anon, authenticated;
revoke all on function public.company_payments_to_finance() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'fin_overview(date)',
    'fin_save_account(uuid,text,text,numeric,boolean,boolean)',
    'fin_save_movement(uuid,date,uuid,text,numeric,text,text,uuid,boolean,text)',
    'fin_delete_movement(uuid)',
    'fin_transfer(date,uuid,uuid,numeric,numeric,text)',
    'fin_save_recurring(uuid,text,text,numeric,uuid,integer,boolean,boolean)',
    'fin_delete_recurring(uuid)',
    'fin_apply_recurring()',
    'fin_save_partners(jsonb)',
    'fin_import_payments(date)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

insert into public.schema_migrations (version) values ('158_platform_finance') on conflict do nothing;
