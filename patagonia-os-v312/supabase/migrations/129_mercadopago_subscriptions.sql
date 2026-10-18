-- Cobros del abono por suscripción de Mercado Pago (pedido del dueño,
-- 2026-10-17: "casi todo lo estoy mandando por suscripción", todos los
-- clientes se suscriben al MISMO link).
--
-- Como el link es uno solo, Mercado Pago no sabe qué carnicería es cada
-- suscriptor. Por eso:
-- 1) La Edge Function mp-sync (con el token de Mercado Pago del dueño, secreto
--    MP_ACCESS_TOKEN) trae las suscripciones (/preapproval/search) y sus cobros
--    (/authorized_payments/search) y los guarda acá tal cual.
-- 2) El dueño asigna UNA vez cada suscripción a su cliente desde el panel
--    (assign_mp_subscription). Desde ahí, cada cobro aprobado suma el período
--    pagado a companies.paid_until y queda en company_payments como cualquier
--    pago, con mp_charge_id para no aplicarlo dos veces.
-- 3) Al asignar, los cobros con fecha hasta el último pago cargado a mano de ese
--    cliente se marcan "ya registrados" (skipped) para no sumar dos veces lo que
--    el dueño ya había anotado.
-- Igual que la migración 110: solo un registro para nosotros, no bloquea a nadie.

create table if not exists public.mp_subscriptions (
  id text primary key,
  company_id uuid references public.companies(id) on delete set null,
  status text,
  reason text,
  payer_id bigint,
  payer_name text,
  payer_email text,
  amount numeric(14,2),
  frequency integer,
  frequency_type text,
  date_created timestamptz,
  next_payment_date timestamptz,
  last_charged_date timestamptz,
  raw jsonb not null default '{}'::jsonb,
  assigned_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists mp_subscriptions_company_idx on public.mp_subscriptions (company_id);

create table if not exists public.mp_subscription_charges (
  id text primary key,
  preapproval_id text not null references public.mp_subscriptions(id) on delete cascade,
  status text,
  payment_id text,
  payment_status text,
  payment_status_detail text,
  amount numeric(14,2),
  debit_date timestamptz,
  date_created timestamptz,
  retry_attempt integer,
  raw jsonb not null default '{}'::jsonb,
  company_payment_id uuid,
  -- true = no suma (ya estaba cargado a mano, o el dueño borró el pago que generó).
  skipped boolean not null default false,
  synced_at timestamptz not null default now()
);

create index if not exists mp_charges_preapproval_idx on public.mp_subscription_charges (preapproval_id, debit_date desc);

alter table public.mp_subscriptions enable row level security;
alter table public.mp_subscription_charges enable row level security;
-- Sin policies a propósito: se escriben con la service role (mp-sync) y se leen
-- con las funciones de abajo, que exigen am_i_platform_admin().

alter table public.company_payments add column if not exists mp_charge_id text;
create unique index if not exists company_payments_mp_charge_key on public.company_payments (mp_charge_id) where mp_charge_id is not null;

-- Si el dueño borra un pago que vino de Mercado Pago, ese cobro no se vuelve a sumar.
create or replace function public.company_payments_mp_skip_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.mp_charge_id is not null then
    update public.mp_subscription_charges set skipped = true, company_payment_id = null where id = old.mp_charge_id;
  end if;
  return old;
end;
$$;

revoke all on function public.company_payments_mp_skip_on_delete() from public, anon, authenticated;

drop trigger if exists company_payments_mp_skip_on_delete on public.company_payments;
create trigger company_payments_mp_skip_on_delete
before delete on public.company_payments
for each row execute function public.company_payments_mp_skip_on_delete();

-- Interna: aplica los cobros aprobados y pendientes de las suscripciones de un
-- cliente, en orden de fecha. La llaman assign_mp_subscription y mp-sync
-- (service role). Revocada de authenticated: no chequea quién llama.
create or replace function public.mp_apply_charges(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge record;
  v_date date;
  v_prev date;
  v_until date;
  v_months integer;
  v_payment_id uuid;
  v_count integer := 0;
begin
  for v_charge in
    select c.id, c.amount, coalesce(c.debit_date, c.date_created) as charged_at, s.frequency, s.frequency_type
    from public.mp_subscription_charges c
    join public.mp_subscriptions s on s.id = c.preapproval_id
    where s.company_id = p_company_id
      and c.payment_status = 'approved'
      and c.company_payment_id is null
      and not c.skipped
    order by coalesce(c.debit_date, c.date_created), c.id
  loop
    v_date := coalesce((v_charge.charged_at at time zone 'America/Argentina/Buenos_Aires')::date, public.today_ar());
    v_months := case when v_charge.frequency_type = 'months' and v_charge.frequency between 1 and 24 then v_charge.frequency else 1 end;

    select paid_until into v_prev from public.companies where id = p_company_id for update;
    if not found then
      return v_count;
    end if;
    -- Pagado por adelantado: se suma desde el vencimiento; si no, desde el día del cobro.
    v_until := (greatest(coalesce(v_prev, v_date), v_date) + make_interval(months => v_months))::date;

    update public.companies set paid_until = v_until, trial_ends_at = null where id = p_company_id;

    insert into public.company_payments (company_id, payment_date, amount, months, paid_until, previous_paid_until, note, mp_charge_id)
    values (p_company_id, v_date, v_charge.amount, v_months, v_until, v_prev, 'Mercado Pago (suscripción)', v_charge.id)
    returning id into v_payment_id;

    update public.mp_subscription_charges set company_payment_id = v_payment_id where id = v_charge.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.mp_apply_charges(uuid) from public, anon, authenticated;

-- Asignar (o desasignar con null) una suscripción a un cliente.
create or replace function public.assign_mp_subscription(p_subscription_id text, p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_manual date;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  if p_company_id is null then
    update public.mp_subscriptions set company_id = null, assigned_at = null where id = p_subscription_id;
    if not found then
      raise exception 'Suscripción inválida';
    end if;
    return 0;
  end if;

  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Cliente inválido';
  end if;

  update public.mp_subscriptions set company_id = p_company_id, assigned_at = now() where id = p_subscription_id;
  if not found then
    raise exception 'Suscripción inválida';
  end if;

  -- Lo que el dueño ya había cargado a mano no se vuelve a sumar.
  select max(payment_date) into v_last_manual
  from public.company_payments
  where company_id = p_company_id and mp_charge_id is null;

  if v_last_manual is not null then
    update public.mp_subscription_charges
    set skipped = true
    where preapproval_id = p_subscription_id
      and company_payment_id is null
      and (coalesce(debit_date, date_created) at time zone 'America/Argentina/Buenos_Aires')::date <= v_last_manual;
  end if;

  -- Sin audit_log: es de cada empresa y lo ve el cliente (igual que los pagos de la 110).
  return public.mp_apply_charges(p_company_id);
end;
$$;

revoke all on function public.assign_mp_subscription(text, uuid) from public, anon;
grant execute on function public.assign_mp_subscription(text, uuid) to authenticated;

-- Lista para el panel: cada suscripción con su cliente y su último cobro.
create or replace function public.list_mp_subscriptions_for_admin()
returns table (
  id text,
  company_id uuid,
  company_name text,
  status text,
  reason text,
  payer_name text,
  payer_email text,
  amount numeric,
  date_created timestamptz,
  next_payment_date timestamptz,
  last_charge_date timestamptz,
  last_charge_status text,
  last_payment_status text,
  last_payment_status_detail text,
  last_retry_attempt integer,
  approved_count bigint,
  synced_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.company_id, co.name, s.status, s.reason, s.payer_name, s.payer_email, s.amount,
         s.date_created, s.next_payment_date,
         lc.charged_at, lc.status, lc.payment_status, lc.payment_status_detail, lc.retry_attempt,
         (select count(*) from public.mp_subscription_charges c2 where c2.preapproval_id = s.id and c2.payment_status = 'approved'),
         s.synced_at
  from public.mp_subscriptions s
  left join public.companies co on co.id = s.company_id
  left join lateral (
    select coalesce(c.debit_date, c.date_created) as charged_at, c.status, c.payment_status, c.payment_status_detail, c.retry_attempt
    from public.mp_subscription_charges c
    where c.preapproval_id = s.id
    order by coalesce(c.debit_date, c.date_created) desc nulls last, c.id desc
    limit 1
  ) lc on true
  where public.am_i_platform_admin()
  order by s.company_id is not null, s.date_created desc nulls last
$$;

revoke all on function public.list_mp_subscriptions_for_admin() from public, anon;
grant execute on function public.list_mp_subscriptions_for_admin() to authenticated;

insert into public.schema_migrations (version) values ('129_mercadopago_subscriptions') on conflict do nothing;
