-- Sucursales: (1) una cuenta de Tesorería puede ser de UNA sucursal o
-- compartida por todas (branch_id null, el comportamiento de siempre -- no
-- cambia nada para clientes que ya tenían cuentas), (2) un resumen por
-- sucursal (stock, ventas de hoy, turno abierto) con el total de todas
-- juntas, y (3) transferir stock de una sucursal a otra.

alter table public.treasury_accounts add column if not exists branch_id uuid references public.branches(id);

-- Sin este drop, la firma vieja de 3 parámetros y la nueva de 4 (con default)
-- quedan ambiguas para una llamada con 3 argumentos -- Postgres no elige sola.
drop function if exists public.create_treasury_account(text, text, numeric);

-- Reemplaza a la de 008_treasury_and_shifts.sql: suma el parámetro opcional
-- p_branch_id (null = compartida, el default de siempre).
create or replace function public.create_treasury_account(
  p_name text,
  p_payment_method text default null,
  p_initial_balance numeric default 0,
  p_branch_id uuid default null
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

  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;

  insert into public.treasury_accounts (id, company_id, name, payment_method, initial_balance, branch_id)
  values (v_account_id, v_company_id, trim(p_name), p_payment_method, coalesce(p_initial_balance, 0), p_branch_id);

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'treasury_account.create', 'treasury_account', v_account_id::text,
    jsonb_build_object('name', p_name, 'initial_balance', p_initial_balance, 'branch_id', p_branch_id)
  );

  return jsonb_build_object('id', v_account_id, 'name', trim(p_name));
end;
$$;

revoke all on function public.create_treasury_account(text,text,numeric,uuid) from public;
grant execute on function public.create_treasury_account(text,text,numeric,uuid) to authenticated;

-- Cambia a qué sucursal pertenece una cuenta ya creada (o la vuelve
-- compartida con p_branch_id null). Solo dueño/administrador, mismo criterio
-- que "branches.manage" en el frontend.
create or replace function public.set_treasury_account_branch(p_account_id uuid, p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para editar cuentas';
  end if;

  if not exists (select 1 from public.treasury_accounts where id = p_account_id and company_id = v_company_id) then
    raise exception 'Cuenta inválida';
  end if;

  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Sucursal inválida';
  end if;

  update public.treasury_accounts set branch_id = p_branch_id where id = p_account_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'treasury_account.set_branch', 'treasury_account', p_account_id::text,
          jsonb_build_object('branch_id', p_branch_id));
end;
$$;

revoke all on function public.set_treasury_account_branch(uuid, uuid) from public;
grant execute on function public.set_treasury_account_branch(uuid, uuid) to authenticated;

-- Resumen por sucursal: cuánto stock (a costo) hay, cuánto se vendió hoy y si
-- hay un turno de Mostrador abierto. Solo dueño/administrador (mismos datos
-- que ya podían ver sumando Stock + Rentabilidad sucursal por sucursal, acá
-- solo se juntan). La fecha de hoy se calcula en huso horario Argentina
-- inline (mismo criterio que today_ar(), 091_argentina_timezone_dates.sql)
-- en vez de llamarla, para no depender de que esa función ya exista.
create or replace function public.get_branches_overview()
returns table (
  branch_id uuid,
  branch_name text,
  sales_mode text,
  stock_value numeric,
  product_count bigint,
  sales_today_count bigint,
  sales_today_total numeric,
  shift_open boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para ver el resumen de sucursales';
  end if;

  return query
  select
    b.id,
    b.name,
    b.sales_mode,
    coalesce(stock.value, 0),
    coalesce(stock.products, 0),
    coalesce(sales.count, 0),
    coalesce(sales.total, 0),
    exists (select 1 from public.pos_shifts sh where sh.branch_id = b.id and sh.status = 'open')
  from public.branches b
  left join lateral (
    select sum(cs.quantity * p.cost) as value, count(*) filter (where cs.quantity <> 0) as products
    from public.current_stock cs
    join public.products p on p.id = cs.product_id and p.company_id = v_company_id
    where cs.branch_id = b.id and cs.company_id = v_company_id
  ) stock on true
  left join lateral (
    select count(*) as count, sum(s.total) as total
    from public.pos_sales s
    where s.branch_id = b.id and s.voided_at is null
      and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date = (now() at time zone 'America/Argentina/Buenos_Aires')::date
  ) sales on true
  where b.company_id = v_company_id and b.active
  order by b.name;
end;
$$;

revoke all on function public.get_branches_overview() from public;
grant execute on function public.get_branches_overview() to authenticated;

-- Transferir stock de una sucursal a otra: dos movimientos de inventario
-- (salida en origen, entrada en destino) con el mismo p_transfer_id, para
-- poder reconstruir el par despues. No permite dejar el origen en negativo.
create or replace function public.transfer_branch_stock(
  p_from_branch_id uuid,
  p_to_branch_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_available numeric;
  v_transfer_id uuid := gen_random_uuid();
  v_reason text;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para transferir stock entre sucursales';
  end if;

  if p_from_branch_id = p_to_branch_id then
    raise exception 'Elegí dos sucursales distintas';
  end if;

  if not exists (select 1 from public.branches where id = p_from_branch_id and company_id = v_company_id and active) then
    raise exception 'Sucursal de origen inválida';
  end if;

  if not exists (select 1 from public.branches where id = p_to_branch_id and company_id = v_company_id and active) then
    raise exception 'Sucursal de destino inválida';
  end if;

  if not exists (select 1 from public.products where id = p_product_id and company_id = v_company_id) then
    raise exception 'Producto inválido';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad tiene que ser mayor que cero';
  end if;

  -- Bloquea el producto (no se puede hacer "for update" sobre un sum()) para
  -- serializar dos transferencias simultáneas del mismo producto.
  perform 1 from public.products where id = p_product_id and company_id = v_company_id for update;

  select coalesce(sum(quantity), 0) into v_available
  from public.inventory_movements
  where company_id = v_company_id and branch_id = p_from_branch_id and product_id = p_product_id;

  if v_available < p_quantity then
    raise exception 'No hay suficiente stock en la sucursal de origen (disponible: %)', v_available;
  end if;

  v_reason := coalesce(nullif(btrim(p_notes), ''), 'Transferencia entre sucursales');

  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  values (v_company_id, p_from_branch_id, p_product_id, 'transfer_out', -p_quantity, 'branch_transfer', v_transfer_id, v_reason, v_user_id);

  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  values (v_company_id, p_to_branch_id, p_product_id, 'transfer_in', p_quantity, 'branch_transfer', v_transfer_id, v_reason, v_user_id);

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'stock.branch_transfer', 'product', p_product_id::text,
          jsonb_build_object('from_branch_id', p_from_branch_id, 'to_branch_id', p_to_branch_id, 'quantity', p_quantity, 'transfer_id', v_transfer_id));

  return v_transfer_id;
end;
$$;

revoke all on function public.transfer_branch_stock(uuid, uuid, uuid, numeric, text) from public;
grant execute on function public.transfer_branch_stock(uuid, uuid, uuid, numeric, text) to authenticated;

notify pgrst, 'reload schema';
