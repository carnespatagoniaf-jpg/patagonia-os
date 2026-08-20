-- Clientes con cuenta corriente (mayoristas a los que se les entrega
-- mercadería sin cobrar en el momento) -- espejo de creditors
-- (021_creditors.sql/028_fix_treasury_linkage.sql) pero con el signo dado
-- vuelta: un "cargo" es lo que le entregaste (sube lo que te debe, no
-- toca tesorería -- no es plata que entró, es mercadería que salió) y un
-- "pago" es lo que te paga (baja lo que debe y sí entra plata a una
-- cuenta). No está enlazado a Mostrador/ventas a propósito -- carga manual,
-- decisión del cliente por ahora.
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  name text not null,
  phone text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  customer_id uuid not null references public.customers(id),
  charge_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  reason text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.customer_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  account_id uuid not null references public.treasury_accounts(id),
  treasury_movement_id uuid references public.treasury_movements(id),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace view public.customer_balance as
select
  c.id as customer_id,
  c.company_id,
  coalesce(ch.total_charged, 0) as total_charged,
  coalesce(p.total_paid, 0) as total_paid,
  coalesce(ch.total_charged, 0) - coalesce(p.total_paid, 0) as balance
from public.customers c
left join (
  select customer_id, sum(amount) as total_charged
  from public.customer_charges
  group by customer_id
) ch on ch.customer_id = c.id
left join (
  select customer_id, sum(amount) as total_paid
  from public.customer_payments
  group by customer_id
) p on p.customer_id = c.id;

alter table public.customers enable row level security;
alter table public.customer_charges enable row level security;
alter table public.customer_payments enable row level security;

create policy "customers_company_isolation"
on public.customers for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "customer_charges_company_isolation"
on public.customer_charges for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "customer_payments_company_isolation"
on public.customer_payments for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

grant select on public.customer_balance to authenticated;

create or replace function public.create_customer(
  p_branch_id uuid,
  p_name text,
  p_phone text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  insert into public.customers (id, company_id, branch_id, name, phone, notes)
  values (v_id, v_company_id, p_branch_id, trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_notes, '')), ''));

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_customer(uuid,text,text,text) from public;
grant execute on function public.create_customer(uuid,text,text,text) to authenticated;

create or replace function public.create_customer_charge(
  p_customer_id uuid,
  p_charge_date date,
  p_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo es obligatorio';
  end if;

  if not exists (
    select 1 from public.customers where id = p_customer_id and company_id = v_company_id
  ) then
    raise exception 'Cliente inválido';
  end if;

  insert into public.customer_charges (id, company_id, customer_id, charge_date, amount, reason, created_by)
  values (v_id, v_company_id, p_customer_id, p_charge_date, p_amount, trim(p_reason), v_user_id);

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_customer_charge(uuid,date,numeric,text) from public;
grant execute on function public.create_customer_charge(uuid,date,numeric,text) to authenticated;

create or replace function public.update_customer_charge(
  p_charge_id uuid,
  p_charge_date date,
  p_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo es obligatorio';
  end if;

  update public.customer_charges
  set charge_date = p_charge_date, amount = p_amount, reason = trim(p_reason)
  where id = p_charge_id and company_id = v_company_id;

  if not found then
    raise exception 'Cargo inválido';
  end if;

  return jsonb_build_object('id', p_charge_id);
end;
$$;

revoke all on function public.update_customer_charge(uuid,date,numeric,text) from public;
grant execute on function public.update_customer_charge(uuid,date,numeric,text) to authenticated;

create or replace function public.delete_customer_charge(p_charge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  delete from public.customer_charges where id = p_charge_id and company_id = v_company_id;

  if not found then
    raise exception 'Cargo inválido';
  end if;

  return jsonb_build_object('id', p_charge_id);
end;
$$;

revoke all on function public.delete_customer_charge(uuid) from public;
grant execute on function public.delete_customer_charge(uuid) to authenticated;

create or replace function public.register_customer_payment(
  p_customer_id uuid,
  p_branch_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_account_id uuid,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_payment_id uuid := gen_random_uuid();
  v_movement_id uuid;
  v_balance numeric(14,2);
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if not exists (
    select 1 from public.customers where id = p_customer_id and company_id = v_company_id
  ) then
    raise exception 'Cliente inválido';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by
  ) values (
    v_company_id, p_branch_id, p_account_id, 'in', p_amount, 'cobro_cliente',
    'customer', p_customer_id, p_payment_date, coalesce(p_notes, 'Cobro a cliente'), v_user_id
  )
  returning id into v_movement_id;

  insert into public.customer_payments (
    id, company_id, branch_id, customer_id, payment_date, amount, account_id, treasury_movement_id, notes, created_by
  ) values (
    v_payment_id, v_company_id, p_branch_id, p_customer_id, p_payment_date, p_amount, p_account_id, v_movement_id, p_notes, v_user_id
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'customer_payment.create', 'customer_payment', v_payment_id::text,
    jsonb_build_object('amount', p_amount, 'customer_id', p_customer_id, 'account_id', p_account_id)
  );

  select balance into v_balance from public.customer_balance where customer_id = p_customer_id;

  return jsonb_build_object('id', v_payment_id, 'balance', v_balance);
end;
$$;

revoke all on function public.register_customer_payment(uuid,uuid,date,numeric,uuid,text) from public;
grant execute on function public.register_customer_payment(uuid,uuid,date,numeric,uuid,text) to authenticated;

create or replace function public.update_customer_payment(
  p_payment_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_account_id uuid,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_customer_id uuid;
  v_movement_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  select customer_id, treasury_movement_id into v_customer_id, v_movement_id
  from public.customer_payments
  where id = p_payment_id and company_id = v_company_id
  for update;

  if v_customer_id is null then
    raise exception 'Pago inválido';
  end if;

  update public.customer_payments
  set payment_date = p_payment_date, amount = p_amount, account_id = p_account_id, notes = p_notes
  where id = p_payment_id;

  if v_movement_id is not null then
    update public.treasury_movements
    set amount = p_amount, account_id = p_account_id, occurred_on = p_payment_date,
        notes = coalesce(p_notes, 'Cobro a cliente')
    where id = v_movement_id;
  end if;

  return jsonb_build_object('id', p_payment_id);
end;
$$;

revoke all on function public.update_customer_payment(uuid,date,numeric,uuid,text) from public;
grant execute on function public.update_customer_payment(uuid,date,numeric,uuid,text) to authenticated;

create or replace function public.delete_customer_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select treasury_movement_id into v_movement_id
  from public.customer_payments
  where id = p_payment_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Pago inválido';
  end if;

  delete from public.customer_payments where id = p_payment_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  return jsonb_build_object('id', p_payment_id);
end;
$$;

revoke all on function public.delete_customer_payment(uuid) from public;
grant execute on function public.delete_customer_payment(uuid) to authenticated;
