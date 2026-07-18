-- Deudas: gente a la que le debo plata (proveedores informales, préstamos de
-- personas, etc.) — distinto de Compras/Proveedores porque no hay factura de
-- mercadería, solo un monto adeudado y pagos que lo van bajando. Los pagos se
-- registran directo contra una cuenta de tesorería (por id, no por texto de
-- medio de pago) para no repetir el bug de register_supplier_payment.
create table if not exists public.creditors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  name text not null,
  phone text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.creditor_debts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  creditor_id uuid not null references public.creditors(id),
  debt_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  reason text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.creditor_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  creditor_id uuid not null references public.creditors(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  account_id uuid not null references public.treasury_accounts(id),
  treasury_movement_id uuid references public.treasury_movements(id),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace view public.creditor_balance as
select
  c.id as creditor_id,
  c.company_id,
  coalesce(d.total_debt, 0) as total_debt,
  coalesce(p.total_paid, 0) as total_paid,
  coalesce(d.total_debt, 0) - coalesce(p.total_paid, 0) as balance
from public.creditors c
left join (
  select creditor_id, sum(amount) as total_debt
  from public.creditor_debts
  group by creditor_id
) d on d.creditor_id = c.id
left join (
  select creditor_id, sum(amount) as total_paid
  from public.creditor_payments
  group by creditor_id
) p on p.creditor_id = c.id;

alter table public.creditors enable row level security;
alter table public.creditor_debts enable row level security;
alter table public.creditor_payments enable row level security;

create policy "creditors_company_isolation"
on public.creditors for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "creditor_debts_company_isolation"
on public.creditor_debts for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "creditor_payments_company_isolation"
on public.creditor_payments for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

grant select on public.creditor_balance to authenticated;

create or replace function public.create_creditor(
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

  insert into public.creditors (id, company_id, branch_id, name, phone, notes)
  values (v_id, v_company_id, p_branch_id, trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_notes, '')), ''));

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_creditor(uuid,text,text,text) from public;
grant execute on function public.create_creditor(uuid,text,text,text) to authenticated;

create or replace function public.create_creditor_debt(
  p_creditor_id uuid,
  p_debt_date date,
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
    select 1 from public.creditors where id = p_creditor_id and company_id = v_company_id
  ) then
    raise exception 'Acreedor inválido';
  end if;

  insert into public.creditor_debts (id, company_id, creditor_id, debt_date, amount, reason, created_by)
  values (v_id, v_company_id, p_creditor_id, p_debt_date, p_amount, trim(p_reason), v_user_id);

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_creditor_debt(uuid,date,numeric,text) from public;
grant execute on function public.create_creditor_debt(uuid,date,numeric,text) to authenticated;

create or replace function public.register_creditor_payment(
  p_creditor_id uuid,
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
    select 1 from public.creditors where id = p_creditor_id and company_id = v_company_id
  ) then
    raise exception 'Acreedor inválido';
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
    v_company_id, p_branch_id, p_account_id, 'out', p_amount, 'pago_acreedor',
    'creditor', p_creditor_id, p_payment_date, coalesce(p_notes, 'Pago a acreedor'), v_user_id
  )
  returning id into v_movement_id;

  insert into public.creditor_payments (
    id, company_id, branch_id, creditor_id, payment_date, amount, account_id, treasury_movement_id, notes, created_by
  ) values (
    v_payment_id, v_company_id, p_branch_id, p_creditor_id, p_payment_date, p_amount, p_account_id, v_movement_id, p_notes, v_user_id
  );

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'creditor_payment.create', 'creditor_payment', v_payment_id::text,
    jsonb_build_object('amount', p_amount, 'creditor_id', p_creditor_id, 'account_id', p_account_id)
  );

  select balance into v_balance from public.creditor_balance where creditor_id = p_creditor_id;

  return jsonb_build_object('id', v_payment_id, 'balance', v_balance);
end;
$$;

revoke all on function public.register_creditor_payment(uuid,uuid,date,numeric,uuid,text) from public;
grant execute on function public.register_creditor_payment(uuid,uuid,date,numeric,uuid,text) to authenticated;
