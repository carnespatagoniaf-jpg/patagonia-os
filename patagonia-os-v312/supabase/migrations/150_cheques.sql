-- Cheques (pedido del dueño, 2026-10-22: "tema cheques, si reciben y si pagan
-- cómo se puede hacer", "como lo manejan las empresas grandes"). Plan Full
-- (regla del dueño: lo nuevo arranca en Full).
--
-- Igual que la "cartera de valores" de los sistemas grandes, sin contabilidad:
--
-- Recibidos (cheques de terceros y eCheq):
--   receive_customer_cheque  el cliente paga con cheque: register_customer_payment
--                            a la cuenta "Cheques en cartera" (la deuda baja ya)
--                            + la ficha del cheque (en_cartera).
--   deposit_cheque           en_cartera -> depositado: pasa de la cartera al banco.
--   endorse_cheque           en_cartera -> endosado: register_supplier_payment desde
--                            la cartera (baja lo que le debés al proveedor).
--   reject_cheque            en_cartera o depositado -> rechazado: sale la plata
--                            (de la cartera o del banco) y la deuda vuelve al
--                            cliente (create_customer_charge).
-- Propios (y eCheq emitidos):
--   issue_cheque             register_supplier_payment desde "Cheques propios a
--                            pagar" (la deuda con el proveedor baja ya; esa cuenta
--                            queda en negativo = lo que falta debitar).
--   mark_cheque_debited      pendiente -> debitado: sale del banco el día del débito.
-- undo_cheque_step deshace el último paso (y en el primero borra el cheque).
--
-- Las dos cuentas (treasury_accounts.cheque_role) se crean solas con el primer
-- cheque y no se ofrecen en los selectores de cobro/pago (las filtra la web):
-- solo se mueven desde acá. Los depósitos y débitos son movimientos comunes del
-- banco, así que Conciliación los cruza con el resumen sin cambios.
--
-- Triggers en customer_payments / supplier_payments: borrar un cobro o pago que
-- es un cheque mantiene el cheque coherente (o lo impide si ya se movió), y no
-- se puede cambiar su monto ni su cuenta desde Clientes/Compras.

-- 1) Tablas -------------------------------------------------------------------

alter table public.treasury_accounts add column if not exists cheque_role text;
alter table public.treasury_accounts drop constraint if exists treasury_accounts_cheque_role_check;
alter table public.treasury_accounts add constraint treasury_accounts_cheque_role_check
  check (cheque_role is null or cheque_role in ('portfolio', 'payable'));

create table if not exists public.cheques (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id),
  kind text not null check (kind in ('received', 'issued')),
  echeq boolean not null default false,
  number text not null,
  bank text,
  drawer_name text,
  drawer_cuit text,
  amount numeric(14,2) not null check (amount > 0),
  pay_date date not null,
  status text not null check (status in ('in_portfolio', 'deposited', 'endorsed', 'rejected', 'pending', 'debited')),
  previous_status text,
  customer_id uuid references public.customers(id),
  customer_payment_id uuid references public.customer_payments(id) on delete set null,
  supplier_id uuid references public.suppliers(id),
  supplier_payment_id uuid references public.supplier_payments(id) on delete set null,
  bank_account_id uuid references public.treasury_accounts(id),
  step_date date,
  step_movement_ids uuid[] not null default '{}',
  reject_charge_id uuid,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cheques_company_status on public.cheques (company_id, status, pay_date);
create index if not exists cheques_customer_payment on public.cheques (customer_payment_id);
create index if not exists cheques_supplier_payment on public.cheques (supplier_payment_id);

alter table public.cheques enable row level security;
revoke all on public.cheques from anon, authenticated;
grant select on public.cheques to authenticated;
drop policy if exists cheques_company_read on public.cheques;
create policy cheques_company_read on public.cheques for select to authenticated
  using (company_id = public.current_company_id());
drop policy if exists plan_full on public.cheques;
create policy plan_full on public.cheques as restrictive for all to authenticated
  using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));

-- 2) Helpers internos (no expuestos) -----------------------------------------

-- Dueño/admin del plan Full. Devuelve la empresa.
create or replace function public.cheque_caller()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
begin
  perform public.require_plan('full');
  if auth.uid() is null then raise exception 'Usuario no autenticado'; end if;
  select company_id, role into v_company_id, v_role
  from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador maneja los cheques'; end if;
  return v_company_id;
end;
$$;
revoke all on function public.cheque_caller() from public, anon, authenticated;

-- La cuenta "Cheques en cartera" o "Cheques propios a pagar", creada si falta.
create or replace function public.cheque_account(p_company_id uuid, p_role text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('cheque_account:' || p_company_id::text || p_role));
  select id into v_id from public.treasury_accounts
  where company_id = p_company_id and cheque_role = p_role
  order by active desc, created_at limit 1;
  if v_id is null then
    insert into public.treasury_accounts (company_id, name, payment_method, initial_balance, active, branch_id, cheque_role)
    values (p_company_id, case p_role when 'portfolio' then 'Cheques en cartera' else 'Cheques propios a pagar' end,
            'digital', 0, true, null, p_role)
    returning id into v_id;
  else
    update public.treasury_accounts set active = true where id = v_id and active = false;
  end if;
  return v_id;
end;
$$;
revoke all on function public.cheque_account(uuid, text) from public, anon, authenticated;

-- Cuenta común de la empresa (banco, efectivo...), no una de cheques.
create or replace function public.cheque_check_money_account(p_company_id uuid, p_account_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select name into v_name from public.treasury_accounts
  where id = p_account_id and company_id = p_company_id and active = true
    and cheque_role is null and coalesce(is_safe, false) = false;
  if v_name is null then raise exception 'Elegí una cuenta válida'; end if;
  return v_name;
end;
$$;
revoke all on function public.cheque_check_money_account(uuid, uuid) from public, anon, authenticated;

create or replace function public.cheque_label(p_number text, p_bank text, p_echeq boolean)
returns text
language sql
immutable
set search_path = public
as $
  select (case when p_echeq then 'eCheq' else 'Cheque' end) || ' N.º ' || p_number
         || coalesce(' (' || nullif(trim(p_bank), '') || ')', '');
$$;
revoke all on function public.cheque_label(text, text, boolean) from public, anon, authenticated;

create or replace function public.cheque_clean(p_number text, p_pay_date date, p_amount numeric, p_cuit text)
returns text
language plpgsql
immutable
set search_path = public
as $
begin
  if nullif(trim(coalesce(p_number, '')), '') is null then raise exception 'Poné el número del cheque'; end if;
  if p_pay_date is null then raise exception 'Poné la fecha de cobro del cheque'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto debe ser mayor que cero'; end if;
  if nullif(regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g'), '') is not null
     and length(regexp_replace(p_cuit, '\D', '', 'g')) <> 11 then
    raise exception 'El CUIT tiene que tener 11 números';
  end if;
  return trim(p_number);
end;
$$;
revoke all on function public.cheque_clean(text, date, numeric, text) from public, anon, authenticated;

-- Mueve plata entre dos cuentas en una fecha (depósito / débito).
create or replace function public.cheque_move(p_company_id uuid, p_branch_id uuid, p_from uuid, p_to uuid, p_amount numeric, p_date date, p_cheque_id uuid, p_notes text)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out uuid;
  v_in uuid;
begin
  insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by)
  values (p_company_id, p_branch_id, p_from, 'out', p_amount, 'transferencia', 'cheque', p_cheque_id, p_date, p_notes, auth.uid())
  returning id into v_out;
  insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by)
  values (p_company_id, p_branch_id, p_to, 'in', p_amount, 'transferencia', 'cheque', p_cheque_id, p_date, p_notes, auth.uid())
  returning id into v_in;
  return array[v_out, v_in];
end;
$$;
revoke all on function public.cheque_move(uuid, uuid, uuid, uuid, numeric, date, uuid, text) from public, anon, authenticated;

-- Borra los movimientos de un paso, salvo que ya estén conciliados con el banco.
create or replace function public.cheque_delete_movements(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(array_length(p_ids, 1), 0) = 0 then return; end if;
  if to_regclass('public.bank_line_matches') is not null
     and exists (select 1 from public.bank_line_matches where movement_id = any(p_ids)) then
    raise exception 'Ese movimiento ya está conciliado con el banco: deshacé la conciliación primero';
  end if;
  delete from public.treasury_movements where id = any(p_ids);
end;
$$;
revoke all on function public.cheque_delete_movements(uuid[]) from public, anon, authenticated;

create or replace function public.cheque_audit(p_company_id uuid, p_cheque_id uuid, p_action text, p_data jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (p_company_id, auth.uid(), p_action, 'cheque', p_cheque_id::text, p_data);
$$;
revoke all on function public.cheque_audit(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- 3) Funciones expuestas -------------------------------------------------------

create or replace function public.receive_customer_cheque(
  p_customer_id uuid,
  p_branch_id uuid,
  p_received_on date,
  p_amount numeric,
  p_number text,
  p_bank text,
  p_drawer_name text,
  p_drawer_cuit text,
  p_pay_date date,
  p_echeq boolean default false,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.cheque_caller();
  v_number text := public.cheque_clean(p_number, p_pay_date, p_amount, p_drawer_cuit);
  v_account uuid;
  v_payment jsonb;
  v_id uuid := gen_random_uuid();
begin
  if not exists (select 1 from public.customers where id = p_customer_id and company_id = v_company_id) then
    raise exception 'Cliente inválido';
  end if;
  v_account := public.cheque_account(v_company_id, 'portfolio');
  v_payment := public.register_customer_payment(p_customer_id, p_branch_id, coalesce(p_received_on, public.today_ar()), p_amount, v_account,
    public.cheque_label(v_number, p_bank, p_echeq) || coalesce(' · ' || nullif(trim(p_notes), ''), ''));

  insert into public.cheques (id, company_id, branch_id, kind, echeq, number, bank, drawer_name, drawer_cuit, amount, pay_date,
    status, customer_id, customer_payment_id, step_date, notes, created_by)
  values (v_id, v_company_id, p_branch_id, 'received', coalesce(p_echeq, false), v_number, nullif(trim(p_bank), ''),
    nullif(trim(p_drawer_name), ''), nullif(regexp_replace(coalesce(p_drawer_cuit, ''), '\D', '', 'g'), ''), p_amount, p_pay_date,
    'in_portfolio', p_customer_id, (v_payment ->> 'id')::uuid, coalesce(p_received_on, public.today_ar()), nullif(trim(p_notes), ''), auth.uid());

  perform public.cheque_audit(v_company_id, v_id, 'cheque.receive', jsonb_build_object('amount', p_amount, 'customer_id', p_customer_id, 'number', v_number));
  return jsonb_build_object('id', v_id, 'balance', v_payment -> 'balance');
end;
$$;
revoke all on function public.receive_customer_cheque(uuid, uuid, date, numeric, text, text, text, text, date, boolean, text) from public, anon;
grant execute on function public.receive_customer_cheque(uuid, uuid, date, numeric, text, text, text, text, date, boolean, text) to authenticated;

create or replace function public.deposit_cheque(p_cheque_id uuid, p_account_id uuid, p_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.cheque_caller();
  v_cheque public.cheques%rowtype;
  v_name text;
  v_date date := coalesce(p_date, public.today_ar());
begin
  select * into v_cheque from public.cheques where id = p_cheque_id and company_id = v_company_id for update;
  if not found then raise exception 'Cheque inválido'; end if;
  if v_cheque.status <> 'in_portfolio' then raise exception 'Solo se deposita un cheque que está en cartera'; end if;
  v_name := public.cheque_check_money_account(v_company_id, p_account_id);

  update public.cheques
  set step_movement_ids = public.cheque_move(v_company_id, v_cheque.branch_id, public.cheque_account(v_company_id, 'portfolio'), p_account_id,
        v_cheque.amount, v_date, v_cheque.id, 'Depósito ' || public.cheque_label(v_cheque.number, v_cheque.bank, v_cheque.echeq)),
      previous_status = status, status = 'deposited', bank_account_id = p_account_id, step_date = v_date, updated_at = now()
  where id = p_cheque_id;

  perform public.cheque_audit(v_company_id, p_cheque_id, 'cheque.deposit', jsonb_build_object('account', v_name, 'date', v_date));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.deposit_cheque(uuid, uuid, date) from public, anon;
grant execute on function public.deposit_cheque(uuid, uuid, date) to authenticated;

create or replace function public.endorse_cheque(p_cheque_id uuid, p_supplier_id uuid, p_branch_id uuid, p_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.cheque_caller();
  v_cheque public.cheques%rowtype;
  v_payment jsonb;
  v_date date := coalesce(p_date, public.today_ar());
begin
  select * into v_cheque from public.cheques where id = p_cheque_id and company_id = v_company_id for update;
  if not found then raise exception 'Cheque inválido'; end if;
  if v_cheque.status <> 'in_portfolio' then raise exception 'Solo se endosa un cheque que está en cartera'; end if;

  v_payment := public.register_supplier_payment(p_supplier_id, coalesce(p_branch_id, v_cheque.branch_id), v_date, v_cheque.amount,
    public.cheque_account(v_company_id, 'portfolio'),
    public.cheque_label(v_cheque.number, v_cheque.bank, v_cheque.echeq) || ' endosado');

  update public.cheques
  set previous_status = status, status = 'endorsed', supplier_id = p_supplier_id,
      supplier_payment_id = (v_payment ->> 'id')::uuid, step_date = v_date, step_movement_ids = '{}', updated_at = now()
  where id = p_cheque_id;

  perform public.cheque_audit(v_company_id, p_cheque_id, 'cheque.endorse', jsonb_build_object('supplier_id', p_supplier_id, 'date', v_date));
  return jsonb_build_object('ok', true, 'balance', v_payment -> 'balance');
end;
$$;
revoke all on function public.endorse_cheque(uuid, uuid, uuid, date) from public, anon;
grant execute on function public.endorse_cheque(uuid, uuid, uuid, date) to authenticated;

create or replace function public.reject_cheque(p_cheque_id uuid, p_date date default null, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.cheque_caller();
  v_cheque public.cheques%rowtype;
  v_from uuid;
  v_label text;
  v_movement uuid;
  v_charge jsonb;
  v_date date := coalesce(p_date, public.today_ar());
begin
  select * into v_cheque from public.cheques where id = p_cheque_id and company_id = v_company_id for update;
  if not found then raise exception 'Cheque inválido'; end if;
  if v_cheque.kind <> 'received' or v_cheque.status not in ('in_portfolio', 'deposited') then
    raise exception 'Solo se marca rechazado un cheque recibido que está en cartera o depositado';
  end if;
  if v_cheque.customer_id is null then raise exception 'Ese cheque no tiene cliente'; end if;

  v_label := public.cheque_label(v_cheque.number, v_cheque.bank, v_cheque.echeq);
  v_from := case v_cheque.status when 'deposited' then v_cheque.bank_account_id else public.cheque_account(v_company_id, 'portfolio') end;

  insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by)
  values (v_company_id, v_cheque.branch_id, v_from, 'out', v_cheque.amount, 'ajuste', 'cheque', v_cheque.id, v_date,
    v_label || ' rechazado', auth.uid())
  returning id into v_movement;

  v_charge := public.create_customer_charge(v_cheque.customer_id, v_date, v_cheque.amount,
    v_label || ' rechazado' || coalesce(' · ' || nullif(trim(p_notes), ''), ''));

  update public.cheques
  set previous_status = status, status = 'rejected', step_movement_ids = array[v_movement],
      reject_charge_id = (v_charge ->> 'id')::uuid, step_date = v_date, updated_at = now(),
      notes = coalesce(nullif(trim(p_notes), ''), notes)
  where id = p_cheque_id;

  perform public.cheque_audit(v_company_id, p_cheque_id, 'cheque.reject', jsonb_build_object('date', v_date, 'notes', p_notes));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.reject_cheque(uuid, date, text) from public, anon;
grant execute on function public.reject_cheque(uuid, date, text) to authenticated;

create or replace function public.issue_cheque(
  p_supplier_id uuid,
  p_branch_id uuid,
  p_issued_on date,
  p_amount numeric,
  p_number text,
  p_bank_account_id uuid,
  p_pay_date date,
  p_echeq boolean default false,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.cheque_caller();
  v_number text := public.cheque_clean(p_number, p_pay_date, p_amount, null);
  v_bank text := public.cheque_check_money_account(v_company_id, p_bank_account_id);
  v_payment jsonb;
  v_id uuid := gen_random_uuid();
begin
  v_payment := public.register_supplier_payment(p_supplier_id, p_branch_id, coalesce(p_issued_on, public.today_ar()), p_amount,
    public.cheque_account(v_company_id, 'payable'),
    public.cheque_label(v_number, v_bank, p_echeq) || ' propio, se cobra el ' || to_char(p_pay_date, 'DD/MM/YYYY')
      || coalesce(' · ' || nullif(trim(p_notes), ''), ''));

  insert into public.cheques (id, company_id, branch_id, kind, echeq, number, bank, amount, pay_date, status,
    supplier_id, supplier_payment_id, bank_account_id, step_date, notes, created_by)
  values (v_id, v_company_id, p_branch_id, 'issued', coalesce(p_echeq, false), v_number, v_bank, p_amount, p_pay_date, 'pending',
    p_supplier_id, (v_payment ->> 'id')::uuid, p_bank_account_id, coalesce(p_issued_on, public.today_ar()), nullif(trim(p_notes), ''), auth.uid());

  perform public.cheque_audit(v_company_id, v_id, 'cheque.issue', jsonb_build_object('amount', p_amount, 'supplier_id', p_supplier_id, 'number', v_number, 'pay_date', p_pay_date));
  return jsonb_build_object('id', v_id, 'balance', v_payment -> 'balance');
end;
$$;
revoke all on function public.issue_cheque(uuid, uuid, date, numeric, text, uuid, date, boolean, text) from public, anon;
grant execute on function public.issue_cheque(uuid, uuid, date, numeric, text, uuid, date, boolean, text) to authenticated;

create or replace function public.mark_cheque_debited(p_cheque_id uuid, p_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.cheque_caller();
  v_cheque public.cheques%rowtype;
  v_date date;
begin
  select * into v_cheque from public.cheques where id = p_cheque_id and company_id = v_company_id for update;
  if not found then raise exception 'Cheque inválido'; end if;
  if v_cheque.kind <> 'issued' or v_cheque.status <> 'pending' then raise exception 'Ese cheque no está pendiente de débito'; end if;
  perform public.cheque_check_money_account(v_company_id, v_cheque.bank_account_id);
  v_date := coalesce(p_date, least(v_cheque.pay_date, public.today_ar()));

  update public.cheques
  set step_movement_ids = public.cheque_move(v_company_id, v_cheque.branch_id, v_cheque.bank_account_id,
        public.cheque_account(v_company_id, 'payable'), v_cheque.amount, v_date, v_cheque.id,
        'Débito ' || public.cheque_label(v_cheque.number, v_cheque.bank, v_cheque.echeq)),
      previous_status = status, status = 'debited', step_date = v_date, updated_at = now()
  where id = p_cheque_id;

  perform public.cheque_audit(v_company_id, p_cheque_id, 'cheque.debit', jsonb_build_object('date', v_date));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.mark_cheque_debited(uuid, date) from public, anon;
grant execute on function public.mark_cheque_debited(uuid, date) to authenticated;

-- Deshace el último paso. En el primer estado (en cartera / pendiente) borra el
-- cheque con su cobro o pago, como si nunca se hubiera cargado.
create or replace function public.undo_cheque_step(p_cheque_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.cheque_caller();
  v_cheque public.cheques%rowtype;
begin
  select * into v_cheque from public.cheques where id = p_cheque_id and company_id = v_company_id for update;
  if not found then raise exception 'Cheque inválido'; end if;

  if v_cheque.status in ('deposited', 'debited') then
    perform public.cheque_delete_movements(v_cheque.step_movement_ids);
    update public.cheques
    set status = case status when 'deposited' then 'in_portfolio' else 'pending' end,
        bank_account_id = case when kind = 'received' then null else bank_account_id end,
        step_movement_ids = '{}', previous_status = null, updated_at = now()
    where id = p_cheque_id;
  elsif v_cheque.status = 'rejected' then
    perform public.cheque_delete_movements(v_cheque.step_movement_ids);
    delete from public.customer_charges where id = v_cheque.reject_charge_id and company_id = v_company_id;
    -- Si venía de depositado, se recupera el par del depósito para poder deshacerlo después.
    update public.cheques
    set status = coalesce(previous_status, 'in_portfolio'), reject_charge_id = null, updated_at = now(),
        step_movement_ids = coalesce((select array_agg(m.id order by m.direction desc) from public.treasury_movements m
                                      where m.reference_type = 'cheque' and m.reference_id = p_cheque_id
                                        and m.movement_type = 'transferencia'), '{}'),
        previous_status = null
    where id = p_cheque_id;
  elsif v_cheque.status = 'endorsed' then
    -- El trigger de supplier_payments lo devuelve a la cartera.
    perform public.delete_supplier_payment(v_cheque.supplier_payment_id);
  elsif v_cheque.status = 'in_portfolio' then
    if v_cheque.customer_payment_id is null then
      delete from public.cheques where id = p_cheque_id;
    else
      perform public.delete_customer_payment(v_cheque.customer_payment_id);
    end if;
  elsif v_cheque.status = 'pending' then
    if v_cheque.supplier_payment_id is null then
      delete from public.cheques where id = p_cheque_id;
    else
      perform public.delete_supplier_payment(v_cheque.supplier_payment_id);
    end if;
  end if;

  perform public.cheque_audit(v_company_id, p_cheque_id, 'cheque.undo', jsonb_build_object('from_status', v_cheque.status));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.undo_cheque_step(uuid) from public, anon;
grant execute on function public.undo_cheque_step(uuid) to authenticated;

-- 4) Coherencia con Clientes / Compras ---------------------------------------

create or replace function public.customer_payments_cheque_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.cheques where customer_payment_id = old.id;
  if v_status is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' then
    if new.amount is distinct from old.amount or new.account_id is distinct from old.account_id then
      raise exception 'Ese cobro es un cheque: cambialo desde Finanzas → Cheques';
    end if;
    return new;
  end if;
  if v_status <> 'in_portfolio' then
    raise exception 'Ese cobro es un cheque que ya se depositó, endosó o rechazó: deshacelo desde Finanzas → Cheques';
  end if;
  delete from public.cheques where customer_payment_id = old.id;
  return old;
end;
$$;
revoke all on function public.customer_payments_cheque_guard() from public, anon, authenticated;
drop trigger if exists customer_payments_cheque_guard on public.customer_payments;
create trigger customer_payments_cheque_guard
before update or delete on public.customer_payments
for each row execute function public.customer_payments_cheque_guard();

create or replace function public.supplier_payments_cheque_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cheque public.cheques%rowtype;
begin
  select * into v_cheque from public.cheques where supplier_payment_id = old.id;
  if v_cheque.id is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' then
    if new.amount is distinct from old.amount or new.account_id is distinct from old.account_id then
      raise exception 'Ese pago es un cheque: cambialo desde Finanzas → Cheques';
    end if;
    return new;
  end if;
  if v_cheque.kind = 'issued' then
    if v_cheque.status <> 'pending' then
      raise exception 'Ese pago es un cheque propio que ya se debitó: deshacé el débito desde Finanzas → Cheques';
    end if;
    delete from public.cheques where id = v_cheque.id;
  else
    -- Endosado: vuelve a la cartera.
    update public.cheques
    set status = 'in_portfolio', supplier_id = null, supplier_payment_id = null, previous_status = null,
        step_movement_ids = '{}', updated_at = now()
    where id = v_cheque.id;
  end if;
  return old;
end;
$$;
revoke all on function public.supplier_payments_cheque_guard() from public, anon, authenticated;
drop trigger if exists supplier_payments_cheque_guard on public.supplier_payments;
create trigger supplier_payments_cheque_guard
before update or delete on public.supplier_payments
for each row execute function public.supplier_payments_cheque_guard();

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('150_cheques') on conflict do nothing;
