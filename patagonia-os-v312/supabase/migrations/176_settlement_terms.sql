-- 176 - Plata por entrar (Tesorería, plan Full). Pedido del dueño 2026-10-28:
-- "cuando el medio de pago no es instantáneo, como hacen las empresas grandes".
--
-- Cada cuenta de Tesorería que no es efectivo puede tener sus condiciones: en
-- cuántos días hábiles llega la plata al banco y qué % descuentan (comisión,
-- IVA y retenciones). Con eso la web arma "Por entrar": lo cobrado que todavía
-- no llegó, cuándo llega y qué está atrasado (lógica pura en
-- apps/web/src/features/settlements/settlement.ts, testeada).
--
-- Lo que confirma que entró es el resumen que ya se sube en Conciliación:
-- los cobros cruzados uno a uno (transferencias) y las acreditaciones de
-- tarjetas (posnet, por lote). No se cambia cómo Mostrador carga las ventas.
--
-- Comisiones de posnet: una vez por mes cerrado y cubierto por el resumen, se
-- anota un gasto "Comisiones de tarjetas" (lo que tenía que entrar − lo que
-- entró) en la cuenta principal de esa cuenta del banco
-- (reference_type 'card_fees'). card_fee_bookings evita anotarlo dos veces.
-- Conciliación trata esos gastos como parte de las tarjetas, no como algo
-- "que está en el sistema y no en el banco" (por eso get_reconciliation_items
-- ahora devuelve reference_type).

alter table public.treasury_accounts
  add column if not exists settle_days smallint check (settle_days is null or settle_days between 0 and 60),
  add column if not exists settle_fee_pct numeric(5,2) check (settle_fee_pct is null or settle_fee_pct between 0 and 30);

comment on column public.treasury_accounts.settle_days is 'Días hábiles hasta que la plata llega al banco (null = sin condiciones cargadas). Migración 176.';
comment on column public.treasury_accounts.settle_fee_pct is 'Lo que descuentan al acreditar (comisión + IVA + retenciones), en %. Migración 176.';

create table if not exists public.card_fee_bookings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recon_account_id uuid not null references public.bank_reconciliation_accounts(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  amount numeric(14,2) not null check (amount > 0),
  movement_id uuid references public.treasury_movements(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (recon_account_id, month)
);

alter table public.card_fee_bookings enable row level security;
revoke all on public.card_fee_bookings from anon, authenticated;
grant select on public.card_fee_bookings to authenticated;

drop policy if exists reconciliation_read on public.card_fee_bookings;
create policy reconciliation_read on public.card_fee_bookings for select to authenticated
  using (company_id = public.current_company_id()
         and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in ('owner', 'admin')));

drop policy if exists plan_full on public.card_fee_bookings;
create policy plan_full on public.card_fee_bookings as restrictive for all to authenticated
  using ((select public.company_plan_allows('full')))
  with check ((select public.company_plan_allows('full')));

drop trigger if exists zz_accountant_readonly on public.card_fee_bookings;
create trigger zz_accountant_readonly before insert or update or delete on public.card_fee_bookings
  for each statement execute function public.accountant_readonly_guard();

-- ------------------------------------------------------------ condiciones
create or replace function public.set_treasury_account_settlement(p_account_id uuid, p_days integer, p_fee_pct numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_old jsonb;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  select jsonb_build_object('settle_days', settle_days, 'settle_fee_pct', settle_fee_pct) into v_old
  from public.treasury_accounts
  where id = p_account_id and company_id = v_company_id
  for update;
  if not found then
    raise exception 'Cuenta inválida';
  end if;
  if p_days is not null and (p_days < 0 or p_days > 60) then
    raise exception 'Los días tienen que ser de 0 a 60';
  end if;
  if p_fee_pct is not null and (p_fee_pct < 0 or p_fee_pct > 30) then
    raise exception 'El porcentaje tiene que ser de 0 a 30';
  end if;

  -- Sin días no hay condiciones: se borran las dos.
  update public.treasury_accounts
  set settle_days = p_days,
      settle_fee_pct = case when p_days is null then null else round(coalesce(p_fee_pct, 0), 2) end
  where id = p_account_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company_id, auth.uid(), 'treasury_account.settlement', 'treasury_account', p_account_id::text, v_old,
          jsonb_build_object('settle_days', p_days, 'settle_fee_pct', p_fee_pct));
end;
$$;

revoke all on function public.set_treasury_account_settlement(uuid, integer, numeric) from public, anon;
grant execute on function public.set_treasury_account_settlement(uuid, integer, numeric) to authenticated;

-- ------------------------------------------------------------ datos para "Por entrar"
-- Cobros de Mostrador por cuenta y día (y cuánto de eso ya se cruzó con el
-- banco), cobertura de los resúmenes subidos y acreditaciones que pueden ser
-- de tarjetas (la web las filtra con el mismo criterio de Conciliación).
create or replace function public.get_settlement_data(p_from date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_from date := greatest(coalesce(p_from, current_date - 90), current_date - 400);
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  return jsonb_build_object(
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'settle_days', a.settle_days, 'settle_fee_pct', a.settle_fee_pct
      ) order by a.name)
      from public.treasury_accounts a
      where a.company_id = v_company_id and a.active and a.cheque_role is null
        and not coalesce(a.is_safe, false) and a.payment_method is distinct from 'cash'
    ), '[]'::jsonb),
    'recons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'treasury_account_ids', to_jsonb(r.treasury_account_ids),
        'card_account_ids', to_jsonb(r.card_account_ids), 'main_treasury_account_id', r.main_treasury_account_id,
        'first_date', (select min(l.line_date) from public.bank_statement_lines l where l.recon_account_id = r.id),
        'last_date', (select max(l.line_date) from public.bank_statement_lines l where l.recon_account_id = r.id)
      ) order by r.name)
      from public.bank_reconciliation_accounts r
      where r.company_id = v_company_id
    ), '[]'::jsonb),
    'sales', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', x.account_id, 'date', x.day, 'gross', x.gross, 'gross_matched', x.matched))
      from (
        select p.account_id,
               (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date as day,
               sum(p.amount) as gross,
               sum(case when exists (select 1 from public.bank_line_matches bm where bm.payment_id = p.id) then p.amount else 0 end) as matched
        from public.pos_sale_payments p
        join public.pos_sales s on s.id = p.sale_id
        join public.treasury_accounts a on a.id = p.account_id
        where s.company_id = v_company_id and s.voided_at is null
          and a.settle_days is not null
          and s.created_at >= (v_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
        group by 1, 2
      ) x
    ), '[]'::jsonb),
    'credits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'recon_id', l.recon_account_id, 'date', l.line_date, 'amount', l.amount, 'description', l.description,
        'card_deposit', l.match_kind = 'card_deposit'
      ))
      from public.bank_statement_lines l
      join public.bank_reconciliation_accounts r on r.id = l.recon_account_id
      where l.company_id = v_company_id and l.amount > 0 and cardinality(r.card_account_ids) > 0
        and l.line_date >= v_from - 10
        and (l.match_kind = 'card_deposit' or l.status = 'pending')
    ), '[]'::jsonb),
    'fee_bookings', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'recon_id', b.recon_account_id, 'month', b.month, 'amount', b.amount) order by b.month)
      from public.card_fee_bookings b
      where b.company_id = v_company_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_settlement_data(date) from public, anon;
grant execute on function public.get_settlement_data(date) to authenticated;

-- ------------------------------------------------------------ comisiones del mes
create or replace function public.book_card_fees(p_recon_account_id uuid, p_month text, p_amount numeric, p_branch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_recon public.bank_reconciliation_accounts%rowtype;
  v_start date;
  v_end date;
  v_card_sales numeric;
  v_booking_id uuid;
  v_movement_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  select * into v_recon from public.bank_reconciliation_accounts
  where id = p_recon_account_id and company_id = v_company_id
  for update;
  if not found then
    raise exception 'Cuenta del banco inválida';
  end if;
  if cardinality(v_recon.card_account_ids) = 0 then
    raise exception 'Esa cuenta del banco no tiene posnet';
  end if;
  if p_month !~ '^\d{4}-\d{2}$' then
    raise exception 'Mes inválido';
  end if;
  v_start := (p_month || '-01')::date;
  v_end := (v_start + interval '1 month' - interval '1 day')::date;
  if v_end >= current_date then
    raise exception 'El mes todavía no terminó';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;
  if exists (select 1 from public.card_fee_bookings where recon_account_id = p_recon_account_id and month = p_month) then
    raise exception 'Las comisiones de ese mes ya están anotadas';
  end if;

  -- Tope de cordura: no más del 30% de lo vendido con posnet alrededor de ese mes.
  select coalesce(sum(p.amount), 0) into v_card_sales
  from public.pos_sale_payments p
  join public.pos_sales s on s.id = p.sale_id
  where s.company_id = v_company_id and s.voided_at is null
    and p.account_id = any(v_recon.card_account_ids)
    and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date between v_start - 20 and v_end;
  if p_amount is null or p_amount <= 0 or p_amount > v_card_sales * 0.3 then
    raise exception 'El importe de comisiones no es válido';
  end if;

  insert into public.card_fee_bookings (company_id, recon_account_id, month, amount, created_by)
  values (v_company_id, p_recon_account_id, p_month, round(p_amount, 2), v_user_id)
  returning id into v_booking_id;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type, category,
    reference_type, reference_id, occurred_on, notes, created_by
  )
  values (
    v_company_id, p_branch_id, v_recon.main_treasury_account_id, 'out', round(p_amount, 2), 'gasto', 'otro',
    'card_fees', v_booking_id, v_end,
    left('Comisiones de tarjetas ' || to_char(v_start, 'MM/YYYY') || ' (' || v_recon.name || ')', 300), v_user_id
  )
  returning id into v_movement_id;

  update public.card_fee_bookings set movement_id = v_movement_id where id = v_booking_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'card_fees.book', 'card_fee_booking', v_booking_id::text,
          jsonb_build_object('recon_account_id', p_recon_account_id, 'month', p_month, 'amount', p_amount, 'movement_id', v_movement_id));

  return v_booking_id;
end;
$$;

revoke all on function public.book_card_fees(uuid, text, numeric, uuid) from public, anon;
grant execute on function public.book_card_fees(uuid, text, numeric, uuid) to authenticated;

create or replace function public.undo_card_fee_booking(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_booking public.card_fee_bookings%rowtype;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  select * into v_booking from public.card_fee_bookings where id = p_booking_id and company_id = v_company_id for update;
  if not found then
    raise exception 'No existe';
  end if;

  delete from public.card_fee_bookings where id = p_booking_id;
  if v_booking.movement_id is not null then
    delete from public.treasury_movements where id = v_booking.movement_id and company_id = v_company_id;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, auth.uid(), 'card_fees.undo', 'card_fee_booking', p_booking_id::text, to_jsonb(v_booking));
end;
$$;

revoke all on function public.undo_card_fee_booking(uuid) from public, anon;
grant execute on function public.undo_card_fee_booking(uuid) to authenticated;

-- ------------------------------------------------------------ Conciliación
-- Igual que en 103, más reference_type en los movimientos (para reconocer las
-- comisiones de tarjetas anotadas desde "Por entrar").
create or replace function public.get_reconciliation_items(p_recon_account_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_acc public.bank_reconciliation_accounts%rowtype;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();
  select * into v_acc from public.bank_reconciliation_accounts where id = p_recon_account_id and company_id = v_company_id;
  if not found then
    raise exception 'Cuenta del banco inválida';
  end if;

  return jsonb_build_object(
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'date', (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
        'account_id', p.account_id, 'amount', p.amount, 'reference', p.reference,
        'reconciled', exists (select 1 from public.bank_line_matches bm where bm.payment_id = p.id)
      ) order by s.created_at)
      from public.pos_sale_payments p
      join public.pos_sales s on s.id = p.sale_id
      where s.company_id = v_company_id and s.voided_at is null
        and p.account_id = any(v_acc.treasury_account_ids)
        and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
    ), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'date', m.occurred_on, 'account_id', m.account_id, 'direction', m.direction,
        'amount', m.amount, 'type', m.movement_type, 'notes', m.notes, 'reference_type', m.reference_type,
        'reconciled', exists (select 1 from public.bank_line_matches bm where bm.movement_id = m.id)
      ) order by m.occurred_on, m.created_at)
      from public.treasury_movements m
      where m.company_id = v_company_id
        and m.account_id = any(v_acc.treasury_account_ids)
        and m.occurred_on between p_from and p_to
        and not (m.movement_type = 'venta' and m.reference_type = 'pos_shift')
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_reconciliation_items(uuid, date, date) from public, anon;
grant execute on function public.get_reconciliation_items(uuid, date, date) to authenticated;

insert into public.schema_migrations (version) values ('176_settlement_terms') on conflict do nothing;
