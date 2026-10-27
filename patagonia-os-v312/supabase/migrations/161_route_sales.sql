-- 161: Venta en ruta (venta en caliente / autoventa). A pedido para "La primera" (Vladimiro, 3 vendedores de
-- fiambres), 26/10/2026; habilitado por empresa con companies.features 'venta_ruta'.
--
--   * Cada camión es una sucursal marcada is_vehicle (su propio stock) con su cuenta "Efectivo <camión>". Los
--     camiones NO cuentan para el límite de sucursales del plan.
--   * Cargar el camión: route_load_vehicle (depósito → camión, transfer_out / transfer_in).
--   * Vender en la calle: route_sale = una entrega a cuenta corriente con sus artículos
--     (create_customer_charge_with_items, que descuenta el stock DEL CAMIÓN) + los cobros que haga en el momento
--     (register_customer_payment, a las cuentas del camión). Lo que no se cobra queda en la cuenta corriente del
--     cliente. Remito y factura salen de la misma entrega, como en Clientes. Idempotente por p_client_id: la venta
--     que se guardó sin señal y se reintenta nunca se duplica.
--   * Rendir el camión: route_settle = lo que vuelve pasa al depósito, lo que falta queda como faltante (ajuste),
--     la plata contada pasa a la cuenta que se elija y la diferencia queda como ajuste. Todo en route_settlements.

alter table public.branches add column if not exists is_vehicle boolean not null default false;

-- Los camiones no cuentan para el límite de sucursales del plan (misma función de 101, con is_vehicle).
create or replace function public.enforce_branch_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_plan text;
  v_max integer;
  v_count integer;
begin
  if not new.active or coalesce(new.is_vehicle, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.active and not coalesce(old.is_vehicle, false) then
    return new;
  end if;

  select plan into v_plan from public.companies where id = new.company_id;
  select max_branches into v_max from public.plan_limits(v_plan);
  if v_max is null then
    return new;
  end if;

  select count(*) into v_count from public.branches
  where company_id = new.company_id and active and not is_vehicle and id <> new.id;
  if v_count >= v_max then
    raise exception 'Tu plan % permite hasta % sucursal(es). Para agregar otra, pedí un plan más alto a Patagonia OS.',
      public.plan_display_name(v_plan), v_max;
  end if;
  return new;
end;
$$;

create table if not exists public.route_sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  client_id uuid not null,
  vehicle_branch_id uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id),
  charge_id uuid not null references public.customer_charges(id) on delete cascade,
  total numeric(14,2) not null,
  paid numeric(14,2) not null default 0,
  payments jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (company_id, client_id)
);
create index if not exists route_sales_vehicle on public.route_sales (vehicle_branch_id, created_at);

create table if not exists public.route_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  vehicle_branch_id uuid not null references public.branches(id),
  depot_branch_id uuid not null references public.branches(id),
  items jsonb not null default '[]'::jsonb,
  cash_expected numeric(14,2) not null default 0,
  cash_counted numeric(14,2) not null default 0,
  cash_difference numeric(14,2) not null default 0,
  missing_value numeric(14,2) not null default 0,
  sales_count integer not null default 0,
  sales_total numeric(14,2) not null default 0,
  on_account numeric(14,2) not null default 0,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists route_settlements_vehicle on public.route_settlements (vehicle_branch_id, created_at desc);

alter table public.route_sales enable row level security;
alter table public.route_settlements enable row level security;
drop policy if exists route_sales_company_read on public.route_sales;
create policy route_sales_company_read on public.route_sales for select to authenticated using (company_id = public.current_company_id());
drop policy if exists route_settlements_company_read on public.route_settlements;
create policy route_settlements_company_read on public.route_settlements for select to authenticated using (company_id = public.current_company_id());

do $$
declare t text;
begin
  foreach t in array array['route_sales', 'route_settlements'] loop
    execute format('drop trigger if exists zz_accountant_readonly on public.%I', t);
    execute format('create trigger zz_accountant_readonly before insert or update or delete on public.%I for each statement execute function public.accountant_readonly_guard()', t);
  end loop;
end $$;

-- Quién llama: perfil activo de una empresa con 'venta_ruta'. Interno: no se expone.
create or replace function public.route_caller(p_admin boolean)
returns public.profiles
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v public.profiles%rowtype;
begin
  select * into v from public.profiles where id = auth.uid() and active;
  if v.id is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.companies where id = v.company_id and 'venta_ruta' = any(features)) then
    raise exception 'Esta empresa no tiene la venta en ruta habilitada';
  end if;
  if p_admin and v.role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador';
  end if;
  return v;
end;
$$;

create or replace function public.route_vehicle_ok(p_company uuid, p_vehicle uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.branches where id = p_vehicle and company_id = p_company and active and is_vehicle);
$$;

-- Camión nuevo: sucursal is_vehicle + su cuenta de efectivo.
create or replace function public.route_create_vehicle(p_name text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.profiles%rowtype := public.route_caller(true);
  v_id uuid;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if v_name is null then raise exception 'Poné un nombre (ej. Camión 1)'; end if;
  insert into public.branches (company_id, name, is_vehicle, active) values (v.company_id, v_name, true, true) returning id into v_id;
  insert into public.treasury_accounts (company_id, name, payment_method, initial_balance, active, branch_id)
  values (v.company_id, 'Efectivo ' || v_name, 'cash', 0, true, v_id);
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v.company_id, v_id, v.id, 'route.vehicle_create', 'branch', v_id::text, jsonb_build_object('name', v_name));
  return v_id;
end;
$$;

-- Cargar el camión desde el depósito. No frena si el depósito no tiene stock cargado (muchos no lo llevan): queda en negativo.
create or replace function public.route_load_vehicle(p_vehicle uuid, p_depot uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.profiles%rowtype := public.route_caller(true);
  v_item jsonb;
  v_qty numeric;
  v_product uuid;
  v_ref uuid := gen_random_uuid();
  v_count integer := 0;
begin
  if not public.route_vehicle_ok(v.company_id, p_vehicle) then raise exception 'Camión inválido'; end if;
  if not exists (select 1 from public.branches where id = p_depot and company_id = v.company_id and active and not is_vehicle) then
    raise exception 'Depósito inválido';
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_product := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    if not exists (select 1 from public.products where id = v_product and company_id = v.company_id) then raise exception 'Producto inválido'; end if;
    insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
    values (v.company_id, p_depot, v_product, 'transfer_out', -v_qty, 'route_load', v_ref, 'Carga del camión', v.id),
           (v.company_id, p_vehicle, v_product, 'transfer_in', v_qty, 'route_load', v_ref, 'Carga del camión', v.id);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception 'Poné al menos un producto con cantidad'; end if;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v.company_id, p_vehicle, v.id, 'route.load', 'branch', p_vehicle::text, jsonb_build_object('depot', p_depot, 'items', p_items));
  return v_count;
end;
$$;

-- Venta en la calle. p_payments = [{account_id, amount}] (lo cobrado en el momento; vacío = todo a cuenta corriente).
create or replace function public.route_sale(p_client_id uuid, p_vehicle uuid, p_customer_id uuid, p_items jsonb, p_payments jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.profiles%rowtype := public.route_caller(false);
  v_prev public.route_sales%rowtype;
  v_charge jsonb;
  v_pay jsonb;
  v_paid numeric(14,2) := 0;
  v_amount numeric(14,2);
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_balance numeric(14,2);
begin
  if p_client_id is null then raise exception 'Falta el identificador de la venta'; end if;
  select * into v_prev from public.route_sales where company_id = v.company_id and client_id = p_client_id;
  if v_prev.id is not null then
    -- Ya se guardó (reintento de una venta hecha sin señal): se devuelve la misma.
    select balance into v_balance from public.customer_balance where customer_id = v_prev.customer_id;
    return jsonb_build_object('id', v_prev.id, 'charge_id', v_prev.charge_id, 'total', v_prev.total, 'paid', v_prev.paid, 'balance', v_balance, 'repeated', true);
  end if;
  if not public.route_vehicle_ok(v.company_id, p_vehicle) then raise exception 'Camión inválido'; end if;
  -- El vendedor vende desde SU camión; dueño y administrador, desde cualquiera.
  if v.role not in ('owner', 'admin') and v.branch_id is distinct from p_vehicle then
    raise exception 'Tu usuario está asignado a otro camión';
  end if;
  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    if not exists (select 1 from public.treasury_accounts where id = (v_pay->>'account_id')::uuid and company_id = v.company_id and active
                   and (branch_id is null or branch_id = p_vehicle)) then
      raise exception 'Cuenta de cobro inválida';
    end if;
  end loop;

  v_charge := public.create_customer_charge_with_items(p_customer_id, p_vehicle, v_today, p_items, null, 0);

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    v_amount := round((v_pay->>'amount')::numeric, 2);
    if v_amount is null or v_amount <= 0 then continue; end if;
    perform public.register_customer_payment(p_customer_id, p_vehicle, v_today, v_amount, (v_pay->>'account_id')::uuid, 'Cobro en ruta');
    v_paid := v_paid + v_amount;
  end loop;

  insert into public.route_sales (company_id, client_id, vehicle_branch_id, customer_id, charge_id, total, paid, payments, created_by)
  values (v.company_id, p_client_id, p_vehicle, p_customer_id, (v_charge->>'id')::uuid, (v_charge->>'amount')::numeric, v_paid, coalesce(p_payments, '[]'::jsonb), v.id)
  returning * into v_prev;

  select balance into v_balance from public.customer_balance where customer_id = p_customer_id;
  return jsonb_build_object('id', v_prev.id, 'charge_id', v_prev.charge_id, 'total', v_prev.total, 'paid', v_paid, 'balance', v_balance, 'repeated', false);
end;
$$;

-- Estado del camión: stock, plata en sus cuentas y lo vendido desde la última rendición.
create or replace function public.route_vehicle_status(p_vehicle uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v public.profiles%rowtype := public.route_caller(false);
  v_since timestamptz;
begin
  if not public.route_vehicle_ok(v.company_id, p_vehicle) then raise exception 'Camión inválido'; end if;
  select max(created_at) into v_since from public.route_settlements where vehicle_branch_id = p_vehicle;
  return jsonb_build_object(
    'since', v_since,
    'stock', coalesce((select jsonb_agg(jsonb_build_object('productId', x.product_id, 'name', p.name, 'code', p.code, 'unit', p.unit, 'cost', p.cost, 'price', p.price_retail, 'stock', x.stock) order by p.name)
                       from (select product_id, sum(quantity) stock from public.inventory_movements where branch_id = p_vehicle group by product_id having sum(quantity) <> 0) x
                       join public.products p on p.id = x.product_id), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'cash', a.payment_method = 'cash',
                         'balance', a.initial_balance + coalesce((select sum(case when m.direction = 'in' then m.amount else -m.amount end) from public.treasury_movements m where m.account_id = a.id), 0)))
                          from public.treasury_accounts a where a.branch_id = p_vehicle and a.active and a.company_id = v.company_id), '[]'::jsonb),
    'sales', (select jsonb_build_object('count', count(*), 'total', coalesce(sum(total), 0), 'paid', coalesce(sum(paid), 0))
              from public.route_sales where vehicle_branch_id = p_vehicle and (v_since is null or created_at > v_since))
  );
end;
$$;

-- Rendición. p_returns = [{product_id, quantity}] lo que volvió (lo no listado volvió 0). p_cash_counted = la plata
-- contada del efectivo del camión; pasa a p_dest_account. Deja el camión en cero de stock y de efectivo.
create or replace function public.route_settle(p_vehicle uuid, p_depot uuid, p_returns jsonb, p_cash_counted numeric, p_dest_account uuid, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v public.profiles%rowtype := public.route_caller(true);
  r record;
  v_returned numeric;
  v_missing numeric;
  v_items jsonb := '[]'::jsonb;
  v_missing_value numeric(14,2) := 0;
  v_ref uuid := gen_random_uuid();
  v_cash_account uuid;
  v_expected numeric(14,2);
  v_counted numeric(14,2) := round(coalesce(p_cash_counted, 0), 2);
  v_diff numeric(14,2);
  v_since timestamptz;
  v_sales record;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_name text;
  v_id uuid;
begin
  if not public.route_vehicle_ok(v.company_id, p_vehicle) then raise exception 'Camión inválido'; end if;
  if not exists (select 1 from public.branches where id = p_depot and company_id = v.company_id and active and not is_vehicle) then
    raise exception 'Depósito inválido';
  end if;
  if v_counted < 0 then raise exception 'La plata contada no puede ser negativa'; end if;
  select name into v_name from public.branches where id = p_vehicle;

  for r in select x.product_id, x.stock, p.name, p.cost, p.unit
           from (select product_id, sum(quantity) stock from public.inventory_movements where branch_id = p_vehicle group by product_id having sum(quantity) <> 0) x
           join public.products p on p.id = x.product_id
  loop
    select coalesce(sum((e->>'quantity')::numeric), 0) into v_returned
    from jsonb_array_elements(coalesce(p_returns, '[]'::jsonb)) e where (e->>'product_id')::uuid = r.product_id;
    if v_returned < 0 then raise exception 'Cantidad inválida en %', r.name; end if;
    if v_returned > greatest(r.stock, 0) then
      raise exception 'De % volvió más (%) de lo que tenía el camión (%)', r.name, v_returned, r.stock;
    end if;
    if v_returned > 0 then
      insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
      values (v.company_id, p_vehicle, r.product_id, 'transfer_out', -v_returned, 'route_settle', v_ref, 'Rendición: vuelve al depósito', v.id),
             (v.company_id, p_depot, r.product_id, 'transfer_in', v_returned, 'route_settle', v_ref, 'Rendición: vuelve del camión', v.id);
    end if;
    v_missing := r.stock - v_returned;
    if v_missing <> 0 then
      insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
      values (v.company_id, p_vehicle, r.product_id, 'adjustment', -v_missing, 'route_settle', v_ref,
              case when v_missing > 0 then 'Rendición: faltante en el camión' else 'Rendición: sobrante en el camión' end, v.id);
      v_missing_value := v_missing_value + round(v_missing * coalesce(r.cost, 0), 2);
    end if;
    v_items := v_items || jsonb_build_object('productId', r.product_id, 'name', r.name, 'unit', r.unit, 'had', r.stock, 'returned', v_returned, 'missing', v_missing);
  end loop;

  -- Efectivo del camión (la primera cuenta del camión, la que crea route_create_vehicle).
  select id into v_cash_account from public.treasury_accounts where branch_id = p_vehicle and company_id = v.company_id and active and payment_method = 'cash' order by created_at limit 1;
  if v_cash_account is null then raise exception 'El camión no tiene cuenta de efectivo'; end if;
  select a.initial_balance + coalesce((select sum(case when m.direction = 'in' then m.amount else -m.amount end) from public.treasury_movements m where m.account_id = a.id), 0)
    into v_expected from public.treasury_accounts a where a.id = v_cash_account;
  v_diff := v_counted - v_expected;
  if v_counted > 0 then
    if not exists (select 1 from public.treasury_accounts where id = p_dest_account and company_id = v.company_id and active and id <> v_cash_account) then
      raise exception 'Elegí a qué cuenta pasa la plata';
    end if;
    insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type, reference_type, reference_id, occurred_on, notes, created_by)
    values (v.company_id, p_vehicle, v_cash_account, 'out', v_counted, 'transferencia', 'route_settle', v_ref, v_today, 'Rendición ' || v_name, v.id),
           (v.company_id, p_depot, p_dest_account, 'in', v_counted, 'transferencia', 'route_settle', v_ref, v_today, 'Rendición ' || v_name, v.id);
  end if;
  if v_diff <> 0 then
    -- Deja el efectivo del camión en cero: faltante (out) o sobrante (in).
    insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type, reference_type, reference_id, occurred_on, notes, created_by)
    values (v.company_id, p_vehicle, v_cash_account, case when v_diff < 0 then 'out' else 'in' end, abs(v_diff), 'ajuste', 'route_settle', v_ref, v_today,
            case when v_diff < 0 then 'Rendición: faltante de efectivo ' else 'Rendición: sobrante de efectivo ' end || v_name, v.id);
  end if;

  select max(created_at) into v_since from public.route_settlements where vehicle_branch_id = p_vehicle;
  select count(*) c, coalesce(sum(total), 0) t, coalesce(sum(total - paid), 0) a into v_sales
  from public.route_sales where vehicle_branch_id = p_vehicle and (v_since is null or created_at > v_since);

  insert into public.route_settlements (company_id, vehicle_branch_id, depot_branch_id, items, cash_expected, cash_counted, cash_difference, missing_value, sales_count, sales_total, on_account, notes, created_by)
  values (v.company_id, p_vehicle, p_depot, v_items, v_expected, v_counted, v_diff, v_missing_value, v_sales.c, v_sales.t, greatest(v_sales.a, 0), nullif(trim(coalesce(p_notes, '')), ''), v.id)
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v.company_id, p_vehicle, v.id, 'route.settle', 'route_settlement', v_id::text,
          jsonb_build_object('cash_expected', v_expected, 'cash_counted', v_counted, 'missing_value', v_missing_value));
  return jsonb_build_object('id', v_id, 'cashExpected', v_expected, 'cashCounted', v_counted, 'cashDifference', v_diff, 'missingValue', v_missing_value, 'items', v_items,
                            'salesCount', v_sales.c, 'salesTotal', v_sales.t);
end;
$$;

revoke all on function public.route_caller(boolean) from public, anon, authenticated;
revoke all on function public.route_vehicle_ok(uuid, uuid) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'route_create_vehicle(text)',
    'route_load_vehicle(uuid,uuid,jsonb)',
    'route_sale(uuid,uuid,uuid,jsonb,jsonb)',
    'route_vehicle_status(uuid)',
    'route_settle(uuid,uuid,jsonb,numeric,uuid,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

insert into public.schema_migrations (version) values ('161_route_sales') on conflict do nothing;
