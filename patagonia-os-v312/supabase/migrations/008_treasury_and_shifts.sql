create table if not exists public.treasury_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name text not null,
  payment_method text,
  initial_balance numeric(14,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.treasury_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  account_id uuid not null references public.treasury_accounts(id),
  direction text not null check (direction in ('in','out')),
  amount numeric(14,2) not null check (amount > 0),
  movement_type text not null,
  reference_type text,
  reference_id uuid,
  occurred_on date not null,
  shift_id uuid,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace view public.treasury_balance as
select
  a.id as account_id,
  a.company_id,
  a.name,
  a.initial_balance
    + coalesce(sum(m.amount) filter (where m.direction = 'in'), 0)
    - coalesce(sum(m.amount) filter (where m.direction = 'out'), 0) as balance
from public.treasury_accounts a
left join public.treasury_movements m on m.account_id = a.id
group by a.id, a.company_id, a.name, a.initial_balance;

create table if not exists public.shift_registers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  shift_date date not null,
  shift text not null check (shift in ('morning','afternoon')),
  opening_cash numeric(14,2) not null default 0,
  closing_counted_cash numeric(14,2),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, branch_id, shift_date, shift)
);

create table if not exists public.shift_sales (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shift_registers(id) on delete cascade,
  account_id uuid not null references public.treasury_accounts(id),
  amount numeric(14,2) not null default 0,
  treasury_movement_id uuid references public.treasury_movements(id),
  unique (shift_id, account_id)
);

create table if not exists public.shift_outflows (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shift_registers(id) on delete cascade,
  account_id uuid not null references public.treasury_accounts(id),
  type text not null check (type in ('vale_mercaderia','vale_adelanto','pago_proveedor','gasto')),
  amount numeric(14,2) not null check (amount > 0),
  detail text not null,
  employee_id uuid,
  supplier_id uuid references public.suppliers(id),
  treasury_movement_id uuid references public.treasury_movements(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.treasury_accounts enable row level security;
alter table public.treasury_movements enable row level security;
alter table public.shift_registers enable row level security;
alter table public.shift_sales enable row level security;
alter table public.shift_outflows enable row level security;

create policy "treasury_accounts_company_isolation"
on public.treasury_accounts for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "treasury_movements_company_isolation"
on public.treasury_movements for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "shift_registers_company_isolation"
on public.shift_registers for all
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "shift_sales_company_isolation"
on public.shift_sales for all
using (
  exists (
    select 1 from public.shift_registers r
    where r.id = shift_id and r.company_id = public.current_company_id()
  )
)
with check (
  exists (
    select 1 from public.shift_registers r
    where r.id = shift_id and r.company_id = public.current_company_id()
  )
);

create policy "shift_outflows_company_isolation"
on public.shift_outflows for all
using (
  exists (
    select 1 from public.shift_registers r
    where r.id = shift_id and r.company_id = public.current_company_id()
  )
)
with check (
  exists (
    select 1 from public.shift_registers r
    where r.id = shift_id and r.company_id = public.current_company_id()
  )
);

grant select on public.treasury_balance to authenticated;

create or replace function public.create_treasury_account(
  p_name text,
  p_payment_method text default null,
  p_initial_balance numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_account_id uuid := gen_random_uuid();
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
    raise exception 'El nombre de la cuenta es obligatorio';
  end if;

  insert into public.treasury_accounts (id, company_id, name, payment_method, initial_balance)
  values (v_account_id, v_company_id, trim(p_name), p_payment_method, coalesce(p_initial_balance, 0));

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'treasury_account.create', 'treasury_account', v_account_id::text,
    jsonb_build_object('name', p_name, 'initial_balance', p_initial_balance)
  );

  return jsonb_build_object('id', v_account_id, 'name', trim(p_name));
end;
$$;

revoke all on function public.create_treasury_account(text,text,numeric) from public;
grant execute on function public.create_treasury_account(text,text,numeric) to authenticated;

create or replace function public.save_shift(
  p_branch_id uuid,
  p_shift_date date,
  p_shift text,
  p_opening_cash numeric,
  p_closing_counted_cash numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_shift_id uuid;
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
    select 1 from public.branches
    where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if p_shift not in ('morning','afternoon') then
    raise exception 'Turno inválido';
  end if;

  if p_opening_cash is null or p_opening_cash < 0 then
    raise exception 'El monto de inicio no puede ser negativo';
  end if;

  insert into public.shift_registers (
    company_id, branch_id, shift_date, shift, opening_cash, closing_counted_cash, created_by, updated_by
  ) values (
    v_company_id, p_branch_id, p_shift_date, p_shift, p_opening_cash, p_closing_counted_cash, v_user_id, v_user_id
  )
  on conflict (company_id, branch_id, shift_date, shift)
  do update set
    opening_cash = excluded.opening_cash,
    closing_counted_cash = excluded.closing_counted_cash,
    updated_by = v_user_id,
    updated_at = now()
  returning id into v_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'shift.save', 'shift_register', v_shift_id::text,
    jsonb_build_object('shift_date', p_shift_date, 'shift', p_shift, 'opening_cash', p_opening_cash, 'closing_counted_cash', p_closing_counted_cash)
  );

  return jsonb_build_object('id', v_shift_id);
end;
$$;

revoke all on function public.save_shift(uuid,date,text,numeric,numeric) from public;
grant execute on function public.save_shift(uuid,date,text,numeric,numeric) to authenticated;

create or replace function public.save_shift_sale(
  p_shift_id uuid,
  p_account_id uuid,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_branch_id uuid;
  v_shift_date date;
  v_sale_id uuid;
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

  if p_amount is null or p_amount < 0 then
    raise exception 'El monto no puede ser negativo';
  end if;

  select branch_id, shift_date into v_branch_id, v_shift_date
  from public.shift_registers
  where id = p_shift_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Turno inválido';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  select id, treasury_movement_id into v_sale_id, v_movement_id
  from public.shift_sales
  where shift_id = p_shift_id and account_id = p_account_id
  for update;

  if p_amount = 0 then
    if v_movement_id is not null then
      delete from public.treasury_movements where id = v_movement_id;
      v_movement_id := null;
    end if;
  elsif v_movement_id is not null then
    update public.treasury_movements
    set amount = p_amount, occurred_on = v_shift_date
    where id = v_movement_id;
  else
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, shift_id, created_by
    ) values (
      v_company_id, v_branch_id, p_account_id, 'in', p_amount, 'venta',
      'shift', p_shift_id, v_shift_date, p_shift_id, v_user_id
    )
    returning id into v_movement_id;
  end if;

  if v_sale_id is not null then
    update public.shift_sales
    set amount = p_amount, treasury_movement_id = v_movement_id
    where id = v_sale_id;
  else
    insert into public.shift_sales (shift_id, account_id, amount, treasury_movement_id)
    values (p_shift_id, p_account_id, p_amount, v_movement_id)
    returning id into v_sale_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'shift_sale.save', 'shift_sale', v_sale_id::text,
    jsonb_build_object('shift_id', p_shift_id, 'account_id', p_account_id, 'amount', p_amount)
  );

  return jsonb_build_object('id', v_sale_id);
end;
$$;

revoke all on function public.save_shift_sale(uuid,uuid,numeric) from public;
grant execute on function public.save_shift_sale(uuid,uuid,numeric) to authenticated;

create or replace function public.save_shift_outflow(
  p_shift_outflow_id uuid,
  p_shift_id uuid,
  p_account_id uuid,
  p_type text,
  p_amount numeric,
  p_detail text,
  p_employee_id uuid default null,
  p_supplier_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_branch_id uuid;
  v_shift_date date;
  v_outflow_id uuid;
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

  if p_type not in ('vale_mercaderia','vale_adelanto','pago_proveedor','gasto') then
    raise exception 'Tipo de salida inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if p_detail is null or length(trim(p_detail)) = 0 then
    raise exception 'El detalle es obligatorio';
  end if;

  select branch_id, shift_date into v_branch_id, v_shift_date
  from public.shift_registers
  where id = p_shift_id and company_id = v_company_id
  for update;

  if v_branch_id is null then
    raise exception 'Turno inválido';
  end if;

  if not exists (
    select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id
  ) then
    raise exception 'Cuenta de tesorería inválida';
  end if;

  if p_shift_outflow_id is not null then
    select treasury_movement_id into v_movement_id
    from public.shift_outflows
    where id = p_shift_outflow_id and shift_id = p_shift_id
    for update;

    if v_movement_id is null then
      raise exception 'Salida inválida';
    end if;

    update public.treasury_movements
    set amount = p_amount, account_id = p_account_id, occurred_on = v_shift_date
    where id = v_movement_id;

    update public.shift_outflows
    set account_id = p_account_id, type = p_type, amount = p_amount, detail = trim(p_detail),
        employee_id = p_employee_id, supplier_id = p_supplier_id
    where id = p_shift_outflow_id;

    v_outflow_id := p_shift_outflow_id;
  else
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, shift_id, notes, created_by
    ) values (
      v_company_id, v_branch_id, p_account_id, 'out', p_amount, p_type,
      case when p_employee_id is not null then 'employee' when p_supplier_id is not null then 'supplier' else null end,
      coalesce(p_employee_id, p_supplier_id),
      v_shift_date, p_shift_id, p_detail, v_user_id
    )
    returning id into v_movement_id;

    insert into public.shift_outflows (
      shift_id, account_id, type, amount, detail, employee_id, supplier_id, treasury_movement_id, created_by
    ) values (
      p_shift_id, p_account_id, p_type, p_amount, trim(p_detail), p_employee_id, p_supplier_id, v_movement_id, v_user_id
    )
    returning id into v_outflow_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_branch_id, v_user_id, 'shift_outflow.save', 'shift_outflow', v_outflow_id::text,
    jsonb_build_object('shift_id', p_shift_id, 'type', p_type, 'amount', p_amount, 'detail', p_detail)
  );

  return jsonb_build_object('id', v_outflow_id);
end;
$$;

revoke all on function public.save_shift_outflow(uuid,uuid,uuid,text,numeric,text,uuid,uuid) from public;
grant execute on function public.save_shift_outflow(uuid,uuid,uuid,text,numeric,text,uuid,uuid) to authenticated;

create or replace function public.delete_shift_outflow(
  p_shift_outflow_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_movement_id uuid;
  v_shift_id uuid;
  v_branch_id uuid;
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

  select o.treasury_movement_id, o.shift_id, r.branch_id
  into v_movement_id, v_shift_id, v_branch_id
  from public.shift_outflows o
  join public.shift_registers r on r.id = o.shift_id
  where o.id = p_shift_outflow_id and r.company_id = v_company_id
  for update of o;

  if v_shift_id is null then
    raise exception 'Salida inválida';
  end if;

  delete from public.shift_outflows where id = p_shift_outflow_id;

  if v_movement_id is not null then
    delete from public.treasury_movements where id = v_movement_id;
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_branch_id, v_user_id, 'shift_outflow.delete', 'shift_outflow', p_shift_outflow_id::text
  );

  return jsonb_build_object('id', p_shift_outflow_id);
end;
$$;

revoke all on function public.delete_shift_outflow(uuid) from public;
grant execute on function public.delete_shift_outflow(uuid) to authenticated;

create or replace function public.register_supplier_payment(
  p_supplier_id uuid,
  p_branch_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_payment_method text,
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
  v_account_id uuid;
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
    select 1 from public.branches
    where id = p_branch_id and company_id = v_company_id and active = true
  ) then
    raise exception 'Sucursal inválida';
  end if;

  if not exists (
    select 1 from public.suppliers
    where id = p_supplier_id and company_id = v_company_id
  ) then
    raise exception 'Proveedor inválido';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  insert into public.supplier_payments (
    id, company_id, branch_id, supplier_id, payment_date, amount, payment_method, notes, created_by
  ) values (
    v_payment_id, v_company_id, p_branch_id, p_supplier_id, p_payment_date, p_amount, p_payment_method, p_notes, v_user_id
  );

  select id into v_account_id
  from public.treasury_accounts
  where company_id = v_company_id and payment_method = p_payment_method and active = true
  limit 1;

  if v_account_id is not null then
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, reference_id, occurred_on, notes, created_by
    ) values (
      v_company_id, p_branch_id, v_account_id, 'out', p_amount, 'pago_proveedor',
      'supplier_payment', v_payment_id, p_payment_date, coalesce(p_notes, 'Pago a proveedor'), v_user_id
    );
  end if;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'supplier_payment.create', 'supplier_payment', v_payment_id::text,
    jsonb_build_object('amount', p_amount, 'payment_method', p_payment_method, 'supplier_id', p_supplier_id)
  );

  select balance into v_balance from public.supplier_balance where supplier_id = p_supplier_id;

  return jsonb_build_object('id', v_payment_id, 'balance', v_balance);
end;
$$;

revoke all on function public.register_supplier_payment(uuid,uuid,date,numeric,text,text) from public;
grant execute on function public.register_supplier_payment(uuid,uuid,date,numeric,text,text) to authenticated;
