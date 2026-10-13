-- Control de caja de Mostrador (pedido del dueño, 2026-10-13: "nunca le da
-- bien la caja a una cajera y no sé si la otra me está mintiendo").
--
-- Lo que mostraron los datos reales de Haedo (19/9 al 12/10): el turno tarde
-- cierra con diferencias de cientos de pesos; el turno mañana con huecos de
-- $93.000 a $355.000 (unos $1,29 millones en total). En esos turnos la plata
-- salió del cajón sin ningún retiro a "CAJA"/"CAJA FUERTE" anotado, y las dos
-- cajeras usan el mismo usuario, así que el sistema no podía decir quién fue.
--
-- 1) Cajera del turno con PIN: employee_pos_pins (hash bcrypt, tabla sin
--    policies) + set_employee_pos_pin / list_pos_cashiers. Si la empresa le
--    puso PIN a alguna empleada de la sucursal, open_pos_shift exige elegir
--    quién atiende y su PIN (pos_shifts.cashier_employee_id). Sin PINs todo
--    sigue como antes.
-- 2) Caja fuerte de verdad: treasury_accounts.is_safe + pos_safe_deposits.
--    register_pos_safe_deposit hace el traspaso Efectivo -> Caja fuerte con un
--    número correlativo para el papelito impreso que va adentro con la plata.
--    Solo dueño/admin pueden borrar un retiro (queda anulado, no desaparece).
-- 3) Cierre a ciegas por medio de pago: check_pos_shift_count recibe lo que
--    la cajera contó (efectivo del cajón + total de cada posnet/transferencia)
--    ANTES de que vea lo esperado, y guarda cada intento en
--    pos_shift_count_checks (el dueño ve el primero aunque después corrija).
--    change_pos_sale_payment_account corrige una venta cobrada con el medio de
--    pago equivocado mientras el turno sigue abierto (queda en audit_log).
-- 4) count_safe: el dueño cuenta la caja fuerte, se compara con el saldo
--    (retiros - lo que sacó) y la diferencia queda registrada y ajustada.
--    list_pos_shift_closes arma el historial de cierres para el dueño.
--
-- close_pos_shift NO se toca. Todo es para todos los planes salvo el PIN de
-- cajera, que usa Empleados (Estándar en adelante).

-- 1) Tablas -------------------------------------------------------------------

alter table public.treasury_accounts
  add column if not exists is_safe boolean not null default false;

alter table public.pos_shifts
  add column if not exists cashier_employee_id uuid references public.employees(id);

create table if not exists public.employee_pos_pins (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.employee_pos_pins enable row level security;
revoke all on public.employee_pos_pins from anon, authenticated;

create table if not exists public.pos_safe_deposits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  pos_shift_id uuid not null references public.pos_shifts(id),
  number integer not null,
  amount numeric(14,2) not null check (amount > 0),
  from_account_id uuid not null references public.treasury_accounts(id),
  safe_account_id uuid not null references public.treasury_accounts(id),
  out_movement_id uuid references public.treasury_movements(id) on delete set null,
  employee_id uuid references public.employees(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  unique (company_id, number)
);
create index if not exists pos_safe_deposits_shift_idx on public.pos_safe_deposits (pos_shift_id);
create index if not exists pos_safe_deposits_out_idx on public.pos_safe_deposits (out_movement_id);
alter table public.pos_safe_deposits enable row level security;
revoke all on public.pos_safe_deposits from anon, authenticated;
grant select on public.pos_safe_deposits to authenticated;
drop policy if exists pos_safe_deposits_read on public.pos_safe_deposits;
create policy pos_safe_deposits_read on public.pos_safe_deposits for select to authenticated
  using (company_id = public.current_company_id());

create table if not exists public.pos_shift_count_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  pos_shift_id uuid not null references public.pos_shifts(id) on delete cascade,
  attempt integer not null,
  employee_id uuid references public.employees(id),
  declared jsonb not null,
  result jsonb not null,
  cash_difference numeric(14,2),
  max_abs_difference numeric(14,2) not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists pos_shift_count_checks_shift_idx on public.pos_shift_count_checks (pos_shift_id, attempt);
alter table public.pos_shift_count_checks enable row level security;
revoke all on public.pos_shift_count_checks from anon, authenticated;
grant select on public.pos_shift_count_checks to authenticated;
drop policy if exists pos_shift_count_checks_read on public.pos_shift_count_checks;
create policy pos_shift_count_checks_read on public.pos_shift_count_checks for select to authenticated
  using (
    company_id = public.current_company_id()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner', 'admin'))
  );

create table if not exists public.safe_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  safe_account_id uuid not null references public.treasury_accounts(id),
  counted numeric(14,2) not null,
  expected numeric(14,2) not null,
  difference numeric(14,2) not null,
  adjustment_movement_id uuid references public.treasury_movements(id) on delete set null,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists safe_counts_account_idx on public.safe_counts (safe_account_id, created_at desc);
alter table public.safe_counts enable row level security;
revoke all on public.safe_counts from anon, authenticated;
grant select on public.safe_counts to authenticated;
drop policy if exists safe_counts_read on public.safe_counts;
create policy safe_counts_read on public.safe_counts for select to authenticated
  using (
    company_id = public.current_company_id()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('owner', 'admin'))
  );

-- 2) Helpers internos (no expuestos) -----------------------------------------

-- ¿Esta sucursal exige elegir cajera con PIN? (alguna empleada activa de la
-- sucursal, o sin sucursal, tiene PIN y el plan incluye Empleados).
create or replace function public.pos_cashier_required(p_company_id uuid, p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.employee_pos_pins pp
    join public.employees e on e.id = pp.employee_id
    join public.companies c on c.id = e.company_id
    where e.company_id = p_company_id
      and e.active = true
      and (e.branch_id is null or e.branch_id = p_branch_id)
      and coalesce(c.plan, 'full') in ('estandar', 'full')
  );
$$;
revoke all on function public.pos_cashier_required(uuid, uuid) from public, anon, authenticated;

-- Valida cajera + PIN. Devuelve el employee_id o lanza error.
create or replace function public.pos_verify_cashier(p_company_id uuid, p_branch_id uuid, p_employee_id uuid, p_pin text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  if p_employee_id is null then
    raise exception 'Elegí quién atiende la caja';
  end if;
  select pp.pin_hash into v_hash
  from public.employee_pos_pins pp
  join public.employees e on e.id = pp.employee_id
  where pp.employee_id = p_employee_id
    and e.company_id = p_company_id
    and e.active = true
    and (e.branch_id is null or e.branch_id = p_branch_id);
  if v_hash is null then
    raise exception 'Esa persona no tiene PIN de caja en esta sucursal';
  end if;
  if p_pin is null or extensions.crypt(trim(p_pin), v_hash) <> v_hash then
    raise exception 'PIN incorrecto';
  end if;
  return p_employee_id;
end;
$$;
revoke all on function public.pos_verify_cashier(uuid, uuid, uuid, text) from public, anon, authenticated;

-- Lo que el sistema espera por medio de pago para un turno (misma cuenta del
-- efectivo que close_pos_shift). Devuelve jsonb {cash_expected, accounts:[...]}.
create or replace function public.pos_shift_expected(p_pos_shift_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shift public.pos_shifts%rowtype;
  v_cash_sales numeric(14,2);
  v_cash_movements numeric(14,2);
  v_accounts jsonb;
begin
  select * into v_shift from public.pos_shifts where id = p_pos_shift_id;

  select coalesce(sum(psp.amount), 0) into v_cash_sales
  from public.pos_sale_payments psp
  join public.pos_sales ps on ps.id = psp.sale_id
  join public.treasury_accounts ta on ta.id = psp.account_id
  where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null and ta.payment_method = 'cash';

  select coalesce(sum(case when tm.direction = 'in' then tm.amount else -tm.amount end), 0)
  into v_cash_movements
  from public.treasury_movements tm
  join public.treasury_accounts ta on ta.id = tm.account_id
  where ta.payment_method = 'cash'
    and (
      (tm.reference_type = 'pos_shift' and tm.reference_id = p_pos_shift_id and tm.movement_type = 'ajuste')
      or tm.pos_shift_id = p_pos_shift_id
    );

  select coalesce(jsonb_agg(jsonb_build_object(
           'account_id', x.account_id, 'expected', x.amount, 'sales_count', x.sales_count
         )), '[]'::jsonb)
  into v_accounts
  from (
    select psp.account_id, sum(psp.amount) as amount, count(distinct psp.sale_id) as sales_count
    from public.pos_sale_payments psp
    join public.pos_sales ps on ps.id = psp.sale_id
    join public.treasury_accounts ta on ta.id = psp.account_id
    where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null
      and ta.payment_method is distinct from 'cash'
    group by psp.account_id
  ) x;

  return jsonb_build_object(
    'opening_cash', coalesce(v_shift.opening_cash, 0),
    'cash_sales', v_cash_sales,
    'cash_movements', v_cash_movements,
    'cash_expected', coalesce(v_shift.opening_cash, 0) + v_cash_sales + v_cash_movements,
    'accounts', v_accounts
  );
end;
$$;
revoke all on function public.pos_shift_expected(uuid) from public, anon, authenticated;

-- 3) PIN de cajera --------------------------------------------------------------

create or replace function public.set_employee_pos_pin(p_employee_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_pin text := nullif(trim(coalesce(p_pin, '')), '');
begin
  perform public.require_plan('estandar');
  select company_id, role into v_company_id, v_role
  from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede cambiar PINs'; end if;
  if not exists (select 1 from public.employees where id = p_employee_id and company_id = v_company_id) then
    raise exception 'Empleado inválido';
  end if;

  if v_pin is null then
    delete from public.employee_pos_pins where employee_id = p_employee_id;
  else
    if v_pin !~ '^[0-9]{4,6}$' then raise exception 'El PIN tiene que ser de 4 a 6 números'; end if;
    insert into public.employee_pos_pins (employee_id, company_id, pin_hash, updated_at)
    values (p_employee_id, v_company_id, extensions.crypt(v_pin, extensions.gen_salt('bf')), now())
    on conflict (employee_id) do update set pin_hash = excluded.pin_hash, updated_at = now();
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'employee.pos_pin', 'employee', p_employee_id::text,
          jsonb_build_object('has_pin', v_pin is not null));
end;
$$;
revoke all on function public.set_employee_pos_pin(uuid, text) from public, anon;
grant execute on function public.set_employee_pos_pin(uuid, text) to authenticated;

-- Quién puede atender la caja en una sucursal (solo nombres, nunca el PIN).
-- p_branch_id null = todas las empleadas con PIN (pantalla Empleados).
create or replace function public.list_pos_cashiers(p_branch_id uuid default null)
returns table (employee_id uuid, full_name text, branch_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.full_name, e.branch_id
  from public.employee_pos_pins pp
  join public.employees e on e.id = pp.employee_id
  where e.company_id = public.current_company_id()
    and e.active = true
    and (p_branch_id is null or e.branch_id is null or e.branch_id = p_branch_id)
    and public.company_plan_allows('estandar')
  order by e.full_name;
$$;
revoke all on function public.list_pos_cashiers(uuid) from public, anon;
grant execute on function public.list_pos_cashiers(uuid) to authenticated;

-- 4) Abrir turno con cajera -------------------------------------------------------

drop function if exists public.open_pos_shift(uuid, numeric);

create or replace function public.open_pos_shift(
  p_branch_id uuid,
  p_opening_cash numeric default 0,
  p_cashier_employee_id uuid default null,
  p_cashier_pin text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_existing_id uuid;
  v_shift_id uuid;
  v_cashier uuid;
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

  if p_opening_cash is not null and p_opening_cash < 0 then
    raise exception 'El fondo inicial no puede ser negativo';
  end if;

  select id into v_existing_id
  from public.pos_shifts
  where branch_id = p_branch_id and status = 'open';

  if v_existing_id is not null then
    return jsonb_build_object('id', v_existing_id, 'already_open', true);
  end if;

  if public.pos_cashier_required(v_company_id, p_branch_id) then
    v_cashier := public.pos_verify_cashier(v_company_id, p_branch_id, p_cashier_employee_id, p_cashier_pin);
  end if;

  insert into public.pos_shifts (company_id, branch_id, opened_by, opening_cash, cashier_employee_id)
  values (v_company_id, p_branch_id, v_user_id, coalesce(p_opening_cash, 0), v_cashier)
  returning id into v_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, p_branch_id, v_user_id, 'pos_shift.open', 'pos_shift', v_shift_id::text,
    jsonb_build_object('opening_cash', coalesce(p_opening_cash, 0), 'cashier_employee_id', v_cashier)
  );

  return jsonb_build_object('id', v_shift_id, 'already_open', false, 'cashier_employee_id', v_cashier);
end;
$$;
revoke all on function public.open_pos_shift(uuid, numeric, uuid, text) from public, anon;
grant execute on function public.open_pos_shift(uuid, numeric, uuid, text) to authenticated;

-- 5) Guardar en caja fuerte -----------------------------------------------------

create or replace function public.register_pos_safe_deposit(
  p_pos_shift_id uuid,
  p_amount numeric,
  p_from_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_shift public.pos_shifts%rowtype;
  v_from uuid := p_from_account_id;
  v_from_count integer;
  v_safe uuid;
  v_safe_name text;
  v_branch_count integer;
  v_branch_name text;
  v_number integer;
  v_out_id uuid;
  v_deposit_id uuid;
  v_employee_name text;
  v_created_at timestamptz;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;

  select * into v_shift from public.pos_shifts
  where id = p_pos_shift_id and company_id = v_company_id and status = 'open'
  for update;
  if not found then raise exception 'No hay un turno de mostrador abierto'; end if;

  if p_amount is null or p_amount <= 0 then raise exception 'El monto debe ser mayor que cero'; end if;

  -- Cuenta de efectivo de la que sale (la del cajón).
  if v_from is null then
    select count(*), min(id::text)::uuid into v_from_count, v_from
    from public.treasury_accounts
    where company_id = v_company_id and active = true and payment_method = 'cash'
      and is_safe = false and (branch_id is null or branch_id = v_shift.branch_id);
    if v_from_count = 0 then raise exception 'No hay una cuenta de efectivo activa'; end if;
    if v_from_count > 1 then raise exception 'Hay más de una cuenta de efectivo: elegí de cuál sale'; end if;
  elsif not exists (
    select 1 from public.treasury_accounts
    where id = v_from and company_id = v_company_id and active = true and payment_method = 'cash' and is_safe = false
  ) then
    raise exception 'Cuenta de efectivo inválida';
  end if;

  -- Caja fuerte de la sucursal (o la compartida). Se crea sola la primera vez.
  select id, name into v_safe, v_safe_name
  from public.treasury_accounts
  where company_id = v_company_id and is_safe = true and active = true
    and (branch_id is null or branch_id = v_shift.branch_id)
  order by (branch_id is null), created_at
  limit 1;

  if v_safe is null then
    select count(*) into v_branch_count from public.branches where company_id = v_company_id and active = true;
    select name into v_branch_name from public.branches where id = v_shift.branch_id;
    v_safe_name := case when v_branch_count > 1 then 'Caja fuerte ' || v_branch_name else 'Caja fuerte' end;
    insert into public.treasury_accounts (company_id, name, payment_method, initial_balance, active, branch_id, is_safe)
    values (v_company_id, v_safe_name, 'cash', 0, true,
            case when v_branch_count > 1 then v_shift.branch_id else null end, true)
    returning id into v_safe;
  end if;

  perform pg_advisory_xact_lock(hashtext('pos_safe_deposits:' || v_company_id::text));
  select coalesce(max(number), 0) + 1 into v_number from public.pos_safe_deposits where company_id = v_company_id;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, pos_shift_id, notes, created_by
  ) values (
    v_company_id, v_shift.branch_id, v_from, 'out', p_amount, 'transferencia',
    'pos_shift', p_pos_shift_id, public.today_ar(), p_pos_shift_id,
    'Caja fuerte (retiro N.º ' || v_number || ')', v_user_id
  )
  returning id into v_out_id;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    reference_type, reference_id, occurred_on, notes, created_by
  ) values (
    v_company_id, v_shift.branch_id, v_safe, 'in', p_amount, 'transferencia',
    'pos_shift_transfer', v_out_id, public.today_ar(),
    'Caja fuerte (retiro N.º ' || v_number || ')', v_user_id
  );

  insert into public.pos_safe_deposits (
    company_id, branch_id, pos_shift_id, number, amount, from_account_id, safe_account_id,
    out_movement_id, employee_id, created_by
  ) values (
    v_company_id, v_shift.branch_id, p_pos_shift_id, v_number, p_amount, v_from, v_safe,
    v_out_id, v_shift.cashier_employee_id, v_user_id
  )
  returning id, created_at into v_deposit_id, v_created_at;

  select full_name into v_employee_name from public.employees where id = v_shift.cashier_employee_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_shift.branch_id, v_user_id, 'pos_safe_deposit.create', 'pos_safe_deposit', v_deposit_id::text,
          jsonb_build_object('number', v_number, 'amount', p_amount, 'pos_shift_id', p_pos_shift_id,
                             'employee_id', v_shift.cashier_employee_id));

  return jsonb_build_object(
    'id', v_deposit_id, 'number', v_number, 'amount', p_amount, 'created_at', v_created_at,
    'employee_name', v_employee_name, 'safe_account_name', v_safe_name,
    'from_account_name', (select name from public.treasury_accounts where id = v_from)
  );
end;
$$;
revoke all on function public.register_pos_safe_deposit(uuid, numeric, uuid) from public, anon;
grant execute on function public.register_pos_safe_deposit(uuid, numeric, uuid) to authenticated;

-- Borrar un movimiento de caja del turno: igual que antes, pero un retiro a
-- caja fuerte solo lo puede borrar el dueño/admin y queda anulado (con su
-- número) en vez de desaparecer.
create or replace function public.delete_pos_shift_adjustment(p_movement_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_shift_id uuid;
  v_shift_status text;
  v_movement_type text;
  v_deposit_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select profiles.company_id, profiles.role into v_company_id, v_role
  from public.profiles
  where profiles.id = v_user_id and profiles.active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select
    coalesce(case when tm.reference_type = 'pos_shift' then tm.reference_id end, tm.pos_shift_id),
    tm.movement_type
  into v_shift_id, v_movement_type
  from public.treasury_movements tm
  where tm.id = p_movement_id and tm.company_id = v_company_id
  for update;

  if v_shift_id is null then
    raise exception 'Movimiento inválido';
  end if;

  if v_movement_type not in ('ajuste', 'transferencia') then
    raise exception 'Ese movimiento no se puede borrar desde acá';
  end if;

  select status into v_shift_status from public.pos_shifts where id = v_shift_id;

  if v_shift_status is distinct from 'open' then
    raise exception 'No se puede borrar: el turno ya está cerrado';
  end if;

  select id into v_deposit_id from public.pos_safe_deposits
  where out_movement_id = p_movement_id and company_id = v_company_id;

  if v_deposit_id is not null then
    if v_role not in ('owner', 'admin') then
      raise exception 'Un retiro a caja fuerte solo lo puede anular el dueño o un administrador';
    end if;
    update public.pos_safe_deposits set voided_at = now(), voided_by = v_user_id where id = v_deposit_id;
  end if;

  delete from public.treasury_movements
  where reference_type = 'pos_shift_transfer' and reference_id = p_movement_id and company_id = v_company_id;

  delete from public.treasury_movements where id = p_movement_id and company_id = v_company_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id
  ) values (
    v_company_id, v_user_id, 'treasury_movement.delete', 'treasury_movement', p_movement_id::text
  );
end;
$$;
revoke all on function public.delete_pos_shift_adjustment(uuid) from public, anon;
grant execute on function public.delete_pos_shift_adjustment(uuid) to authenticated;

-- 6) Cierre a ciegas ------------------------------------------------------------

-- p_declared = {"cash": 32000, "accounts": [{"account_id": "...", "amount": 1000}]}
-- Devuelve lo esperado SOLO después de guardar lo declarado.
create or replace function public.check_pos_shift_count(
  p_pos_shift_id uuid,
  p_declared jsonb,
  p_employee_id uuid default null,
  p_pin text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_shift public.pos_shifts%rowtype;
  v_employee uuid;
  v_expected jsonb;
  v_cash_declared numeric(14,2);
  v_cash_expected numeric(14,2);
  v_rows jsonb;
  v_attempt integer;
  v_max numeric(14,2);
  v_first numeric(14,2);
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;

  select * into v_shift from public.pos_shifts
  where id = p_pos_shift_id and company_id = v_company_id
  for update;
  if not found then raise exception 'Turno inválido'; end if;
  if v_shift.status <> 'open' then raise exception 'El turno ya está cerrado'; end if;

  if public.pos_cashier_required(v_company_id, v_shift.branch_id) then
    v_employee := public.pos_verify_cashier(v_company_id, v_shift.branch_id, p_employee_id, p_pin);
  end if;

  if p_declared is null or jsonb_typeof(p_declared -> 'cash') is distinct from 'number' then
    raise exception 'Falta el efectivo contado';
  end if;
  v_cash_declared := (p_declared ->> 'cash')::numeric;
  if v_cash_declared < 0 then raise exception 'El efectivo contado no puede ser negativo'; end if;

  v_expected := public.pos_shift_expected(p_pos_shift_id);
  v_cash_expected := (v_expected ->> 'cash_expected')::numeric;

  -- Una fila por cuenta no efectivo: las declaradas + las que tuvieron ventas.
  with declared as (
    select (d ->> 'account_id')::uuid as account_id, (d ->> 'amount')::numeric as amount
    from jsonb_array_elements(coalesce(p_declared -> 'accounts', '[]'::jsonb)) d
    where d ->> 'account_id' is not null and jsonb_typeof(d -> 'amount') = 'number'
  ),
  expected as (
    select (e ->> 'account_id')::uuid as account_id, (e ->> 'expected')::numeric as amount,
           (e ->> 'sales_count')::integer as sales_count
    from jsonb_array_elements(v_expected -> 'accounts') e
  ),
  ids as (
    select account_id from declared union select account_id from expected
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_id', ta.id, 'name', ta.name, 'payment_method', ta.payment_method,
           'declared', d.amount, 'expected', coalesce(e.amount, 0),
           'difference', case when d.amount is null then null else d.amount - coalesce(e.amount, 0) end,
           'sales_count', coalesce(e.sales_count, 0)
         ) order by ta.name), '[]'::jsonb)
  into v_rows
  from ids
  join public.treasury_accounts ta on ta.id = ids.account_id and ta.company_id = v_company_id
  left join declared d on d.account_id = ids.account_id
  left join expected e on e.account_id = ids.account_id;

  select greatest(abs(v_cash_declared - v_cash_expected),
                  coalesce(max(abs((r ->> 'difference')::numeric)), 0))
  into v_max
  from jsonb_array_elements(v_rows) r
  where r ->> 'difference' is not null;
  v_max := coalesce(v_max, abs(v_cash_declared - v_cash_expected));

  perform pg_advisory_xact_lock(hashtext('pos_shift_count:' || p_pos_shift_id::text));
  select coalesce(max(attempt), 0) + 1 into v_attempt from public.pos_shift_count_checks where pos_shift_id = p_pos_shift_id;
  select cash_difference into v_first from public.pos_shift_count_checks where pos_shift_id = p_pos_shift_id and attempt = 1;

  insert into public.pos_shift_count_checks (
    company_id, branch_id, pos_shift_id, attempt, employee_id, declared, result,
    cash_difference, max_abs_difference, created_by
  ) values (
    v_company_id, v_shift.branch_id, p_pos_shift_id, v_attempt, v_employee, p_declared,
    jsonb_build_object('cash_expected', v_cash_expected, 'accounts', v_rows, 'detail', v_expected),
    v_cash_declared - v_cash_expected, v_max, v_user_id
  );

  return jsonb_build_object(
    'attempt', v_attempt,
    'cash_declared', v_cash_declared,
    'cash_expected', v_cash_expected,
    'cash_difference', v_cash_declared - v_cash_expected,
    'first_cash_difference', coalesce(v_first, v_cash_declared - v_cash_expected),
    'opening_cash', (v_expected ->> 'opening_cash')::numeric,
    'cash_sales', (v_expected ->> 'cash_sales')::numeric,
    'cash_movements', (v_expected ->> 'cash_movements')::numeric,
    'accounts', v_rows
  );
end;
$$;
revoke all on function public.check_pos_shift_count(uuid, jsonb, uuid, text) from public, anon;
grant execute on function public.check_pos_shift_count(uuid, jsonb, uuid, text) to authenticated;

-- Corregir el medio de pago de una venta (ej. cobrada en efectivo y marcada
-- como transferencia). Solo con el turno abierto: la plata del turno recién
-- se pasa a Tesorería al cerrar, así que no hay movimientos que rehacer.
create or replace function public.change_pos_sale_payment_account(p_payment_id uuid, p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sale_id uuid;
  v_old_account uuid;
  v_shift_status text;
  v_amount numeric;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;

  select psp.sale_id, psp.account_id, psp.amount, s.status
  into v_sale_id, v_old_account, v_amount, v_shift_status
  from public.pos_sale_payments psp
  join public.pos_sales ps on ps.id = psp.sale_id
  join public.pos_shifts s on s.id = ps.pos_shift_id
  where psp.id = p_payment_id and ps.company_id = v_company_id and ps.voided_at is null
  for update of psp;

  if v_sale_id is null then raise exception 'Pago inválido'; end if;
  if v_shift_status is distinct from 'open' then raise exception 'El turno de esa venta ya está cerrado'; end if;
  if not exists (
    select 1 from public.treasury_accounts
    where id = p_account_id and company_id = v_company_id and active = true and is_safe = false
  ) then
    raise exception 'Cuenta inválida';
  end if;
  if v_old_account = p_account_id then return; end if;

  update public.pos_sale_payments set account_id = p_account_id where id = p_payment_id;
  update public.pos_sales set account_id = p_account_id
  where id = v_sale_id and account_id = v_old_account
    and (select count(*) from public.pos_sale_payments where sale_id = v_sale_id) = 1;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company_id, v_user_id, 'pos_sale.change_payment_account', 'pos_sale', v_sale_id::text,
          jsonb_build_object('account_id', v_old_account, 'payment_id', p_payment_id, 'amount', v_amount),
          jsonb_build_object('account_id', p_account_id));
end;
$$;
revoke all on function public.change_pos_sale_payment_account(uuid, uuid) from public, anon;
grant execute on function public.change_pos_sale_payment_account(uuid, uuid) to authenticated;

-- 7) Contar la caja fuerte (dueño/admin) ---------------------------------------

create or replace function public.count_safe(p_safe_account_id uuid, p_counted numeric, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_branch uuid;
  v_expected numeric(14,2);
  v_diff numeric(14,2);
  v_adj uuid;
  v_count_id uuid;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador cuenta la caja fuerte'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'Poné cuánto contaste'; end if;

  select branch_id into v_branch from public.treasury_accounts
  where id = p_safe_account_id and company_id = v_company_id and is_safe = true
  for update;
  if not found then raise exception 'Caja fuerte inválida'; end if;
  -- treasury_movements.branch_id es obligatorio: la caja fuerte compartida
  -- usa la sucursal de quien cuenta.
  if v_branch is null then
    select coalesce(
      (select branch_id from public.profiles where id = v_user_id),
      (select id from public.branches where company_id = v_company_id order by created_at limit 1)
    ) into v_branch;
  end if;

  select a.initial_balance
         + coalesce(sum(m.amount) filter (where m.direction = 'in'), 0)
         - coalesce(sum(m.amount) filter (where m.direction = 'out'), 0)
  into v_expected
  from public.treasury_accounts a
  left join public.treasury_movements m on m.account_id = a.id
  where a.id = p_safe_account_id
  group by a.initial_balance;

  v_diff := p_counted - v_expected;

  if v_diff <> 0 then
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      reference_type, occurred_on, notes, created_by
    ) values (
      v_company_id, v_branch, p_safe_account_id, case when v_diff > 0 then 'in' else 'out' end, abs(v_diff), 'ajuste',
      'safe_count', public.today_ar(),
      case when v_diff > 0 then 'Sobrante al contar la caja fuerte' else 'Faltante al contar la caja fuerte' end,
      v_user_id
    )
    returning id into v_adj;
  end if;

  insert into public.safe_counts (company_id, safe_account_id, counted, expected, difference, adjustment_movement_id, notes, created_by)
  values (v_company_id, p_safe_account_id, p_counted, v_expected, v_diff, v_adj, nullif(trim(coalesce(p_notes, '')), ''), v_user_id)
  returning id into v_count_id;

  update public.treasury_movements set reference_id = v_count_id where id = v_adj;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_branch, v_user_id, 'safe.count', 'safe_count', v_count_id::text,
          jsonb_build_object('counted', p_counted, 'expected', v_expected, 'difference', v_diff));

  return jsonb_build_object('id', v_count_id, 'counted', p_counted, 'expected', v_expected, 'difference', v_diff);
end;
$$;
revoke all on function public.count_safe(uuid, numeric, text) from public, anon;
grant execute on function public.count_safe(uuid, numeric, text) to authenticated;

-- 8) Historial de cierres para el dueño --------------------------------------

create or replace function public.list_pos_shift_closes(p_branch_id uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
  v_result jsonb;
begin
  select company_id, role into v_company_id, v_role from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.opened_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      s.id, s.opened_at, s.closed_at, s.status,
      coalesce(e.full_name, po.full_name) as cashier_name,
      (s.cashier_employee_id is not null) as cashier_with_pin,
      (a.new_data ->> 'expected_cash')::numeric as expected_cash,
      (a.new_data ->> 'counted_cash')::numeric as counted_cash,
      (a.new_data ->> 'difference')::numeric as difference,
      (select count(*) from public.pos_shift_count_checks c where c.pos_shift_id = s.id) as attempts,
      (select c.cash_difference from public.pos_shift_count_checks c where c.pos_shift_id = s.id order by c.attempt limit 1) as first_cash_difference,
      (select c.result -> 'accounts' from public.pos_shift_count_checks c where c.pos_shift_id = s.id order by c.attempt desc limit 1) as last_accounts,
      (select coalesce(sum(d.amount), 0) from public.pos_safe_deposits d where d.pos_shift_id = s.id and d.voided_at is null) as safe_total,
      (select count(*) from public.pos_safe_deposits d where d.pos_shift_id = s.id and d.voided_at is null) as safe_count,
      (select count(*) from public.audit_log al
         where al.company_id = v_company_id and al.action = 'pos_sale.change_payment_account'
           and al.entity_id in (select ps.id::text from public.pos_sales ps where ps.pos_shift_id = s.id)) as payment_changes
    from public.pos_shifts s
    left join public.employees e on e.id = s.cashier_employee_id
    left join public.profiles po on po.id = s.opened_by
    left join lateral (
      select al.new_data from public.audit_log al
      where al.company_id = v_company_id and al.action = 'pos_shift.close' and al.entity_id = s.id::text
      order by al.created_at desc limit 1
    ) a on true
    where s.company_id = v_company_id
      and s.branch_id = p_branch_id
      and s.opened_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 120)))
  ) x;

  return v_result;
end;
$$;
revoke all on function public.list_pos_shift_closes(uuid, integer) from public, anon;
grant execute on function public.list_pos_shift_closes(uuid, integer) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('117_cash_control') on conflict do nothing;
