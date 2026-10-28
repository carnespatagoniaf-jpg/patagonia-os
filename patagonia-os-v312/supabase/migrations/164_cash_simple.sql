-- 164: caja más simple, como una empresa grande (2026-10-28, pedido del dueño).
--
-- 1. "Retiro de dinero" (antes "Guardar en caja fuerte"): la plata sale del cajón pero SIGUE siendo Efectivo de
--    Tesorería ("la caja fuerte es un lugar, no una cuenta"). register_pos_safe_deposit (misma firma, las pestañas
--    viejas siguen andando) ya no mueve plata a una cuenta "Caja fuerte": solo anota el retiro con su número
--    correlativo (el papelito). pos_safe_deposits.safe_account_id y out_movement_id quedan null en los nuevos.
--    Los retiros viejos (con movimiento) no se tocan. Las cuentas "Caja fuerte" que ya existen tampoco: Los gringos
--    usa la suya para pagar (saldo −41,8 M), así que pasar saldos solos le rompería el Efectivo.
-- 2. pos_shift_expected y close_pos_shift restan esos retiros de lo que tiene que haber en el cajón.
-- 3. Al cerrar, la diferencia (faltante o sobrante) se anota como 'ajuste' en la cuenta de Efectivo del turno,
--    a nombre del cajero (reference_type 'pos_shift_close', así no cuenta como movimiento del turno). Antes no se
--    anotaba y el Efectivo de Tesorería se despegaba de la plata real.
-- 4. count_cash_withdrawals: el dueño cuenta los papelitos sin contar de una sucursal; si no coincide, la diferencia
--    va como 'ajuste' a Efectivo. void_pos_cash_withdrawal: anular un retiro nuevo (dueño/admin, PIN si hay).
-- 5. register_pos_shift_expense: "Gasto del local" desde el turno (hielo, bolsas, flete), un 'gasto' con
--    pos_shift_id, así se descuenta de lo esperado en el cajón y suma en Reportes. delete_pos_shift_adjustment
--    ahora también borra esos gastos (misma regla de PIN).
-- 6. Control de la balanza al cerrar: opcional por empresa (companies.features 'control_balanza', lo prende el dueño
--    con set_scale_close_control). Arranca prendido solo en Carnes Patagonia, el único que lo usaba.

alter table public.pos_safe_deposits alter column safe_account_id drop not null;

create table if not exists public.pos_cash_withdrawal_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  account_id uuid references public.treasury_accounts(id),
  numbers integer[] not null,
  expected numeric(14,2) not null,
  counted numeric(14,2) not null,
  difference numeric(14,2) not null,
  movement_id uuid references public.treasury_movements(id) on delete set null,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.pos_cash_withdrawal_counts enable row level security;

drop policy if exists "pos_cash_withdrawal_counts_read" on public.pos_cash_withdrawal_counts;
create policy "pos_cash_withdrawal_counts_read"
on public.pos_cash_withdrawal_counts for select
to authenticated
using (company_id = public.current_company_id());

revoke insert, update, delete on public.pos_cash_withdrawal_counts from anon, authenticated;

alter table public.pos_safe_deposits
  add column if not exists count_id uuid references public.pos_cash_withdrawal_counts(id);

do $$
begin
  if exists (select 1 from pg_proc where proname = 'accountant_readonly_guard' and pronamespace = 'public'::regnamespace) then
    drop trigger if exists zz_accountant_readonly on public.pos_cash_withdrawal_counts;
    create trigger zz_accountant_readonly before insert or update or delete on public.pos_cash_withdrawal_counts
      for each statement execute function public.accountant_readonly_guard();
  end if;
end $$;

-- Interno: la cuenta de Efectivo de una sucursal (la propia antes que la compartida). Nunca una "Caja fuerte".
create or replace function public.pos_branch_cash_account(p_company_id uuid, p_branch_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.treasury_accounts
  where company_id = p_company_id and active = true and payment_method = 'cash' and is_safe = false
    and (branch_id is null or branch_id = p_branch_id)
  order by (branch_id is null), created_at
  limit 1;
$$;

revoke all on function public.pos_branch_cash_account(uuid, uuid) from public, anon, authenticated;

-- Interno: la cuenta de Efectivo de un turno = la que más cobró en efectivo; si no cobró nada, la de la sucursal.
create or replace function public.pos_shift_cash_account(p_pos_shift_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select psp.account_id
     from public.pos_sale_payments psp
     join public.pos_sales ps on ps.id = psp.sale_id
     join public.treasury_accounts ta on ta.id = psp.account_id
     where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null and ta.payment_method = 'cash' and ta.is_safe = false
     group by psp.account_id
     order by sum(psp.amount) desc
     limit 1),
    (select public.pos_branch_cash_account(s.company_id, s.branch_id) from public.pos_shifts s where s.id = p_pos_shift_id)
  );
$$;

revoke all on function public.pos_shift_cash_account(uuid) from public, anon, authenticated;

-- Interno: retiros nuevos (sin movimiento) de un turno, sin anular.
create or replace function public.pos_shift_withdrawals(p_pos_shift_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)::numeric(14,2) from public.pos_safe_deposits
  where pos_shift_id = p_pos_shift_id and out_movement_id is null and voided_at is null;
$$;

revoke all on function public.pos_shift_withdrawals(uuid) from public, anon, authenticated;

-- Lo esperado en el cajón: igual que antes, menos los retiros nuevos.
create or replace function public.pos_shift_expected(p_pos_shift_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.pos_shifts%rowtype;
  v_cash_sales numeric(14,2);
  v_cash_movements numeric(14,2);
  v_withdrawals numeric(14,2);
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

  v_withdrawals := public.pos_shift_withdrawals(p_pos_shift_id);
  v_cash_movements := v_cash_movements - v_withdrawals;

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
    'cash_withdrawals', v_withdrawals,
    'cash_expected', coalesce(v_shift.opening_cash, 0) + v_cash_sales + v_cash_movements,
    'accounts', v_accounts
  );
end;
$$;

revoke all on function public.pos_shift_expected(uuid) from public, anon, authenticated;

-- "Retiro de dinero": misma firma que antes; solo anota el retiro (el papelito), no mueve plata entre cuentas.
create or replace function public.register_pos_safe_deposit(p_pos_shift_id uuid, p_amount numeric, p_from_account_id uuid default null)
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
  v_number integer;
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

  if v_from is null then
    v_from := public.pos_shift_cash_account(p_pos_shift_id);
    if v_from is null then raise exception 'No hay una cuenta de efectivo activa'; end if;
  elsif not exists (
    select 1 from public.treasury_accounts
    where id = v_from and company_id = v_company_id and active = true and payment_method = 'cash' and is_safe = false
  ) then
    raise exception 'Cuenta de efectivo inválida';
  end if;

  perform pg_advisory_xact_lock(hashtext('pos_safe_deposits:' || v_company_id::text));
  select coalesce(max(number), 0) + 1 into v_number from public.pos_safe_deposits where company_id = v_company_id;

  insert into public.pos_safe_deposits (
    company_id, branch_id, pos_shift_id, number, amount, from_account_id, safe_account_id,
    out_movement_id, employee_id, created_by
  ) values (
    v_company_id, v_shift.branch_id, p_pos_shift_id, v_number, p_amount, v_from, null,
    null, v_shift.cashier_employee_id, v_user_id
  )
  returning id, created_at into v_deposit_id, v_created_at;

  select full_name into v_employee_name from public.employees where id = v_shift.cashier_employee_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_shift.branch_id, v_user_id, 'pos_cash_withdrawal.create', 'pos_safe_deposit', v_deposit_id::text,
          jsonb_build_object('number', v_number, 'amount', p_amount, 'pos_shift_id', p_pos_shift_id,
                             'employee_id', v_shift.cashier_employee_id));

  return jsonb_build_object(
    'id', v_deposit_id, 'number', v_number, 'amount', p_amount, 'created_at', v_created_at,
    'employee_name', v_employee_name, 'safe_account_name', null,
    'from_account_name', (select name from public.treasury_accounts where id = v_from)
  );
end;
$$;

revoke all on function public.register_pos_safe_deposit(uuid, numeric, uuid) from public, anon;
grant execute on function public.register_pos_safe_deposit(uuid, numeric, uuid) to authenticated;

-- Anular un retiro nuevo: dueño o administrador, turno abierto, sin contar todavía, PIN de la empresa si hay.
create or replace function public.void_pos_cash_withdrawal(p_id uuid, p_auth_pin text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_deposit public.pos_safe_deposits%rowtype;
  v_matches boolean;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Un retiro solo lo puede anular el dueño o un administrador'; end if;

  select * into v_deposit from public.pos_safe_deposits where id = p_id and company_id = v_company_id for update;
  if v_deposit.id is null then raise exception 'Retiro inválido'; end if;
  if v_deposit.voided_at is not null then raise exception 'Ese retiro ya está anulado'; end if;
  if v_deposit.out_movement_id is not null then raise exception 'Es un retiro del sistema anterior: se anula desde los movimientos de caja'; end if;
  if v_deposit.count_id is not null then raise exception 'Ese retiro ya se contó: no se puede anular'; end if;
  if (select status from public.pos_shifts where id = v_deposit.pos_shift_id) is distinct from 'open' then
    raise exception 'No se puede anular: el turno ya está cerrado';
  end if;

  v_matches := public.pos_void_pin_matches(v_company_id, p_auth_pin);
  if v_matches is not null then
    if p_auth_pin is null then
      raise exception 'Para anular hace falta el PIN de autorización (si no lo pide, recargá la página con F5)';
    end if;
    if public.pos_void_pin_locked(v_company_id) then
      return jsonb_build_object('ok', false, 'error', 'Demasiados intentos con el PIN equivocado. Esperá 15 minutos.');
    end if;
    if not v_matches then
      insert into public.pos_void_pin_failures (company_id, created_by) values (v_company_id, v_user_id);
      return jsonb_build_object('ok', false, 'error', 'PIN de autorización incorrecto.');
    end if;
  end if;

  update public.pos_safe_deposits set voided_at = now(), voided_by = v_user_id where id = p_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_deposit.branch_id, v_user_id, 'pos_cash_withdrawal.void', 'pos_safe_deposit', p_id::text,
          jsonb_build_object('number', v_deposit.number, 'amount', v_deposit.amount, 'with_pin', v_matches is not null));

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.void_pos_cash_withdrawal(uuid, text) from public, anon;
grant execute on function public.void_pos_cash_withdrawal(uuid, text) to authenticated;

-- "Gasto del local" desde el turno: sale del Efectivo del turno y queda ligado al turno.
create or replace function public.register_pos_shift_expense(
  p_pos_shift_id uuid,
  p_amount numeric,
  p_category text,
  p_description text
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
  v_account uuid;
  v_movement_id uuid;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;

  select * into v_shift from public.pos_shifts
  where id = p_pos_shift_id and company_id = v_company_id and status = 'open'
  for update;
  if not found then raise exception 'No hay un turno de mostrador abierto'; end if;

  if p_amount is null or p_amount <= 0 then raise exception 'El monto debe ser mayor que cero'; end if;
  if p_category not in ('mantenimiento', 'servicios', 'impuestos', 'insumos', 'otro') then raise exception 'Categoría inválida'; end if;
  if p_description is null or length(trim(p_description)) = 0 then raise exception 'Escribí en qué se gastó'; end if;

  v_account := public.pos_shift_cash_account(p_pos_shift_id);
  if v_account is null then raise exception 'No hay una cuenta de efectivo activa'; end if;

  insert into public.treasury_movements (
    company_id, branch_id, account_id, direction, amount, movement_type,
    category, occurred_on, pos_shift_id, notes, created_by
  ) values (
    v_company_id, v_shift.branch_id, v_account, 'out', p_amount, 'gasto',
    p_category, public.today_ar(), p_pos_shift_id, trim(p_description), v_user_id
  )
  returning id into v_movement_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_shift.branch_id, v_user_id, 'pos_shift_expense.create', 'treasury_movement', v_movement_id::text,
          jsonb_build_object('pos_shift_id', p_pos_shift_id, 'amount', p_amount, 'category', p_category, 'description', trim(p_description)));

  return jsonb_build_object('id', v_movement_id, 'account_name', (select name from public.treasury_accounts where id = v_account));
end;
$$;

revoke all on function public.register_pos_shift_expense(uuid, numeric, text, text) from public, anon;
grant execute on function public.register_pos_shift_expense(uuid, numeric, text, text) to authenticated;

-- Misma función que la 153; ahora también borra un "Gasto del local" del turno.
create or replace function public.delete_pos_shift_adjustment(p_movement_id uuid, p_auth_pin text default null)
returns jsonb
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
  v_matches boolean;
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

  if v_movement_type not in ('ajuste', 'transferencia', 'gasto') then
    raise exception 'Ese movimiento no se puede borrar desde acá';
  end if;

  select status into v_shift_status from public.pos_shifts where id = v_shift_id;

  if v_shift_status is distinct from 'open' then
    raise exception 'No se puede borrar: el turno ya está cerrado';
  end if;

  select id into v_deposit_id from public.pos_safe_deposits
  where out_movement_id = p_movement_id and company_id = v_company_id;

  if v_deposit_id is not null and v_role not in ('owner', 'admin') then
    raise exception 'Un retiro a caja fuerte solo lo puede anular el dueño o un administrador';
  end if;

  v_matches := public.pos_void_pin_matches(v_company_id, p_auth_pin);
  if v_matches is not null then
    if p_auth_pin is null then
      raise exception 'Para borrar hace falta el PIN de autorización (si no lo pide, recargá la página con F5)';
    end if;
    if public.pos_void_pin_locked(v_company_id) then
      return jsonb_build_object('ok', false, 'error', 'Demasiados intentos con el PIN equivocado. Esperá 15 minutos.');
    end if;
    if not v_matches then
      insert into public.pos_void_pin_failures (company_id, created_by) values (v_company_id, v_user_id);
      return jsonb_build_object('ok', false, 'error', 'PIN de autorización incorrecto.');
    end if;
  end if;

  if v_deposit_id is not null then
    update public.pos_safe_deposits set voided_at = now(), voided_by = v_user_id where id = v_deposit_id;
  end if;

  delete from public.treasury_movements
  where reference_type = 'pos_shift_transfer' and reference_id = p_movement_id and company_id = v_company_id;

  delete from public.treasury_movements where id = p_movement_id and company_id = v_company_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'treasury_movement.delete', 'treasury_movement', p_movement_id::text,
    jsonb_build_object('with_pin', v_matches is not null, 'safe_deposit_id', v_deposit_id, 'movement_type', v_movement_type)
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_pos_shift_adjustment(uuid, text) from public, anon;
grant execute on function public.delete_pos_shift_adjustment(uuid, text) to authenticated;

-- Cierre: igual que antes (misma firma) + resta los retiros nuevos + anota la diferencia en Efectivo.
create or replace function public.close_pos_shift(p_pos_shift_id uuid, p_closing_counted_cash numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_shift public.pos_shifts%rowtype;
  v_account record;
  v_summary jsonb := '[]'::jsonb;
  v_total numeric(14,2) := 0;
  v_cash_sales numeric(14,2) := 0;
  v_cash_movements numeric(14,2) := 0;
  v_cash_outflows numeric(14,2) := 0;
  v_cash_inflows numeric(14,2) := 0;
  v_cash_vales numeric(14,2) := 0;
  v_cash_supplier numeric(14,2) := 0;
  v_cash_withdrawals numeric(14,2) := 0;
  v_noncash_outflows numeric(14,2) := 0;
  v_expected_cash numeric(14,2);
  v_difference numeric(14,2);
  v_cash_account uuid;
  v_cashier text;
  v_difference_movement uuid;
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

  select * into v_shift
  from public.pos_shifts
  where id = p_pos_shift_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Turno inválido';
  end if;

  if v_shift.status <> 'open' then
    raise exception 'El turno ya está cerrado';
  end if;

  for v_account in
    select psp.account_id, sum(psp.amount) as amount, count(distinct psp.sale_id) as sales_count
    from public.pos_sale_payments psp
    join public.pos_sales ps on ps.id = psp.sale_id
    where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null
    group by psp.account_id
  loop
    if v_account.amount > 0 then
      insert into public.treasury_movements (
        company_id, branch_id, account_id, direction, amount, movement_type,
        reference_type, reference_id, occurred_on, notes, created_by
      ) values (
        v_company_id, v_shift.branch_id, v_account.account_id, 'in', v_account.amount, 'venta',
        'pos_shift', p_pos_shift_id, public.today_ar(), 'Cierre de turno de mostrador', v_user_id
      );
    end if;
    v_total := v_total + v_account.amount;
    v_summary := v_summary || jsonb_build_object(
      'account_id', v_account.account_id,
      'amount', v_account.amount,
      'sales_count', v_account.sales_count
    );
  end loop;

  select coalesce(sum(psp.amount), 0) into v_cash_sales
  from public.pos_sale_payments psp
  join public.pos_sales ps on ps.id = psp.sale_id
  join public.treasury_accounts ta on ta.id = psp.account_id
  where ps.pos_shift_id = p_pos_shift_id and ps.voided_at is null and ta.payment_method = 'cash';

  select
    coalesce(sum(case when tm.direction = 'in' then tm.amount else -tm.amount end), 0),
    coalesce(sum(tm.amount) filter (where tm.direction = 'out'), 0),
    coalesce(sum(tm.amount) filter (where tm.direction = 'in'), 0),
    coalesce(sum(tm.amount) filter (where tm.direction = 'out' and tm.movement_type in ('vale_adelanto', 'vale_mercaderia')), 0),
    coalesce(sum(tm.amount) filter (where tm.direction = 'out' and tm.movement_type = 'pago_proveedor'), 0)
  into v_cash_movements, v_cash_outflows, v_cash_inflows, v_cash_vales, v_cash_supplier
  from public.treasury_movements tm
  join public.treasury_accounts ta on ta.id = tm.account_id
  where ta.payment_method = 'cash'
    and (
      (tm.reference_type = 'pos_shift' and tm.reference_id = p_pos_shift_id and tm.movement_type = 'ajuste')
      or tm.pos_shift_id = p_pos_shift_id
    );

  v_cash_withdrawals := public.pos_shift_withdrawals(p_pos_shift_id);
  v_cash_movements := v_cash_movements - v_cash_withdrawals;
  v_cash_outflows := v_cash_outflows + v_cash_withdrawals;

  select coalesce(sum(tm.amount), 0) into v_noncash_outflows
  from public.treasury_movements tm
  join public.treasury_accounts ta on ta.id = tm.account_id
  where ta.payment_method is distinct from 'cash'
    and tm.direction = 'out'
    and (
      (tm.reference_type = 'pos_shift' and tm.reference_id = p_pos_shift_id and tm.movement_type = 'ajuste')
      or tm.pos_shift_id = p_pos_shift_id
    );

  v_expected_cash := coalesce(v_shift.opening_cash, 0) + v_cash_sales + v_cash_movements;
  v_difference := case when p_closing_counted_cash is null then null else p_closing_counted_cash - v_expected_cash end;

  -- La diferencia va a Efectivo, así Tesorería queda igual a la plata real.
  if v_difference is not null and v_difference <> 0 then
    v_cash_account := public.pos_shift_cash_account(p_pos_shift_id);
    if v_cash_account is not null then
      select coalesce(
        (select full_name from public.employees where id = v_shift.cashier_employee_id),
        (select full_name from public.profiles where id = v_user_id),
        'cajero'
      ) into v_cashier;
      insert into public.treasury_movements (
        company_id, branch_id, account_id, direction, amount, movement_type,
        reference_type, reference_id, occurred_on, notes, created_by
      ) values (
        v_company_id, v_shift.branch_id, v_cash_account,
        case when v_difference > 0 then 'in' else 'out' end, abs(v_difference), 'ajuste',
        'pos_shift_close', p_pos_shift_id, public.today_ar(),
        case when v_difference > 0 then 'Sobrante de caja · ' else 'Faltante de caja · ' end || v_cashier,
        v_user_id
      )
      returning id into v_difference_movement;
    end if;
  end if;

  update public.pos_shifts
  set status = 'closed', closed_at = now(), closed_by = v_user_id, closing_counted_cash = p_closing_counted_cash
  where id = p_pos_shift_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_shift.branch_id, v_user_id, 'pos_shift.close', 'pos_shift', p_pos_shift_id::text,
    jsonb_build_object(
      'total', v_total, 'by_account', v_summary, 'opening_cash', v_shift.opening_cash,
      'cash_sales', v_cash_sales, 'cash_movements', v_cash_movements,
      'cash_outflows', v_cash_outflows, 'cash_inflows', v_cash_inflows,
      'cash_withdrawals', v_cash_withdrawals,
      'noncash_outflows', v_noncash_outflows, 'expected_cash', v_expected_cash,
      'counted_cash', p_closing_counted_cash, 'difference', v_difference,
      'difference_movement_id', v_difference_movement
    )
  );

  return jsonb_build_object(
    'total', v_total, 'by_account', v_summary,
    'opening_cash', coalesce(v_shift.opening_cash, 0), 'cash_sales', v_cash_sales,
    'cash_outflows', v_cash_outflows, 'cash_inflows', v_cash_inflows,
    'cash_vales', v_cash_vales, 'cash_supplier_payments', v_cash_supplier,
    'cash_withdrawals', v_cash_withdrawals,
    'noncash_outflows', v_noncash_outflows,
    'expected_cash', v_expected_cash, 'counted_cash', p_closing_counted_cash, 'difference', v_difference
  );
end;
$$;

revoke all on function public.close_pos_shift(uuid, numeric) from public, anon;
grant execute on function public.close_pos_shift(uuid, numeric) to authenticated;

-- El dueño cuenta los papelitos de retiro que no contó todavía (de una sucursal).
create or replace function public.count_cash_withdrawals(p_branch_id uuid, p_counted numeric, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_numbers integer[];
  v_expected numeric(14,2);
  v_difference numeric(14,2);
  v_account uuid;
  v_movement uuid;
  v_count_id uuid;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;
  if p_counted is null or p_counted < 0 then raise exception 'Poné cuánta plata contaste'; end if;

  perform pg_advisory_xact_lock(hashtext('pos_safe_deposits:' || v_company_id::text));

  select coalesce(array_agg(number order by number), '{}'), coalesce(sum(amount), 0)
  into v_numbers, v_expected
  from public.pos_safe_deposits
  where company_id = v_company_id and branch_id = p_branch_id
    and out_movement_id is null and voided_at is null and count_id is null;

  if cardinality(v_numbers) = 0 then raise exception 'No hay retiros sin contar'; end if;

  v_difference := p_counted - v_expected;
  v_account := public.pos_branch_cash_account(v_company_id, p_branch_id);

  if v_difference <> 0 and v_account is not null then
    insert into public.treasury_movements (
      company_id, branch_id, account_id, direction, amount, movement_type,
      occurred_on, notes, created_by
    ) values (
      v_company_id, p_branch_id, v_account,
      case when v_difference > 0 then 'in' else 'out' end, abs(v_difference), 'ajuste',
      public.today_ar(),
      case when v_difference > 0 then 'Sobrante al contar retiros N.º ' else 'Faltante al contar retiros N.º ' end
        || v_numbers[1] || case when cardinality(v_numbers) > 1 then ' a ' || v_numbers[cardinality(v_numbers)] else '' end,
      v_user_id
    )
    returning id into v_movement;
  end if;

  insert into public.pos_cash_withdrawal_counts (
    company_id, branch_id, account_id, numbers, expected, counted, difference, movement_id, notes, created_by
  ) values (
    v_company_id, p_branch_id, v_account, v_numbers, v_expected, p_counted, v_difference, v_movement,
    nullif(trim(coalesce(p_notes, '')), ''), v_user_id
  )
  returning id into v_count_id;

  update public.pos_safe_deposits set count_id = v_count_id
  where company_id = v_company_id and branch_id = p_branch_id
    and out_movement_id is null and voided_at is null and count_id is null and number = any(v_numbers);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'pos_cash_withdrawal.count', 'pos_cash_withdrawal_count', v_count_id::text,
          jsonb_build_object('numbers', v_numbers, 'expected', v_expected, 'counted', p_counted, 'difference', v_difference));

  return jsonb_build_object('id', v_count_id, 'numbers', v_numbers, 'expected', v_expected, 'counted', p_counted, 'difference', v_difference);
end;
$$;

revoke all on function public.count_cash_withdrawals(uuid, numeric, text) from public, anon;
grant execute on function public.count_cash_withdrawals(uuid, numeric, text) to authenticated;

-- Control de la balanza al cerrar: opcional, lo prende o apaga el dueño o un administrador.
create or replace function public.set_scale_close_control(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
begin
  select company_id, role into v_company_id, v_role from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;

  update public.companies
  set features = array_remove(coalesce(features, '{}'), 'control_balanza')
                 || case when p_enabled then array['control_balanza'] else '{}'::text[] end
  where id = v_company_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'company.scale_close_control', 'company', v_company_id::text,
          jsonb_build_object('enabled', p_enabled));
  return p_enabled;
end;
$$;

revoke all on function public.set_scale_close_control(boolean) from public, anon;
grant execute on function public.set_scale_close_control(boolean) to authenticated;

-- Carnes Patagonia es el único que hacía el control de la balanza al cerrar (46 cierres en octubre).
update public.companies
set features = coalesce(features, '{}') || array['control_balanza']
where name = 'Carnes Patagonia' and not ('control_balanza' = any(coalesce(features, '{}')));

insert into public.schema_migrations (version) values ('164_cash_simple') on conflict do nothing;
