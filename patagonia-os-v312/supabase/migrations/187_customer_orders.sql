-- 187: Pedidos de clientes (2026-11-01, pedido del dueño).
--
-- El cajero anota el pedido del cliente ("2 kg de asado y una morcilla para el sábado a las 11") en vez de un
-- papelito que se pierde. El día del retiro (y el anterior) el sistema avisa, y "Planificación" suma lo encargado
-- por producto para comprar (kilos por un lado, unidades por otro).
--
-- REGLA: es solo informativo. No baja stock, no mueve la caja, ni el turno, ni Tesorería. Total y seña son datos
-- del pedido; ninguna función de acá lee ni escribe inventory_movements, pos_*, treasury_*.
--
-- - Pantalla a pedido: companies.features 'pedidos' (panel de plataforma → Pantallas a pedido).
-- - Es el cuaderno de CADA local (pedido del dueño, 01/11): solo el cajero y el encargado, y solo los de su
--   sucursal. Dueño, administrador y solo lectura (la administración) no los ven ni los cargan.
-- - Escriben solo por RPC (migración 175).
-- - Estados: pendiente → listo → entregado; cancelado. Entregado o cancelado ya no se edita.

create table if not exists public.customer_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null check (length(btrim(customer_name)) between 1 and 80),
  customer_phone text check (customer_phone is null or length(customer_phone) <= 40),
  pickup_date date not null,
  pickup_time time,
  notes text check (notes is null or length(notes) <= 300),
  total numeric(14, 2) check (total is null or total >= 0),
  deposit numeric(14, 2) not null default 0 check (deposit >= 0),
  status text not null default 'pendiente' check (status in ('pendiente', 'listo', 'entregado', 'cancelado')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status_changed_at timestamptz
);

create table if not exists public.customer_order_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  order_id uuid not null references public.customer_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity numeric(10, 3) not null check (quantity > 0),
  unit text not null,
  notes text check (notes is null or length(notes) <= 120),
  position integer not null default 0
);

create index if not exists customer_orders_day_idx on public.customer_orders (company_id, branch_id, pickup_date);
create index if not exists customer_orders_status_idx on public.customer_orders (company_id, status);
create index if not exists customer_order_items_order_idx on public.customer_order_items (order_id);

-- Lectura -------------------------------------------------------------------

create or replace function public.orders_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.companies
    where id = public.current_company_id() and 'pedidos' = any(features)
  );
$$;
revoke all on function public.orders_enabled() from public, anon;
grant execute on function public.orders_enabled() to authenticated;

-- ¿Puede ver los pedidos de esta sucursal? Solo el encargado y el cajero de esa sucursal.
create or replace function public.orders_branch_visible(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true
      and p.role in ('manager', 'cashier') and p.branch_id = p_branch_id
  );
$$;
revoke all on function public.orders_branch_visible(uuid) from public, anon;
grant execute on function public.orders_branch_visible(uuid) to authenticated;

alter table public.customer_orders enable row level security;
alter table public.customer_order_items enable row level security;
revoke all on public.customer_orders from anon, authenticated;
revoke all on public.customer_order_items from anon, authenticated;
grant select on public.customer_orders to authenticated;
grant select on public.customer_order_items to authenticated;

drop policy if exists customer_orders_read on public.customer_orders;
create policy customer_orders_read on public.customer_orders for select to authenticated
  using (company_id = public.current_company_id() and public.orders_branch_visible(branch_id));
drop policy if exists customer_order_items_read on public.customer_order_items;
create policy customer_order_items_read on public.customer_order_items for select to authenticated
  using (
    company_id = public.current_company_id()
    and exists (select 1 from public.customer_orders o where o.id = order_id and public.orders_branch_visible(o.branch_id))
  );
drop policy if exists orders_feature on public.customer_orders;
create policy orders_feature on public.customer_orders as restrictive for all to authenticated
  using (public.orders_enabled()) with check (public.orders_enabled());
drop policy if exists orders_feature on public.customer_order_items;
create policy orders_feature on public.customer_order_items as restrictive for all to authenticated
  using (public.orders_enabled()) with check (public.orders_enabled());

-- El Contador no escribe nada (migración 155).
drop trigger if exists zz_accountant_readonly on public.customer_orders;
create trigger zz_accountant_readonly before insert or update or delete on public.customer_orders
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.customer_order_items;
create trigger zz_accountant_readonly before insert or update or delete on public.customer_order_items
  for each statement execute function public.accountant_readonly_guard();

-- Helper interno: quién llama y si puede escribir en esa sucursal (no expuesto) ---------------------------

create or replace function public.orders_caller(p_branch_id uuid, out company_id uuid, out user_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_branch uuid;
begin
  user_id := auth.uid();
  if user_id is null then raise exception 'Usuario no autenticado'; end if;
  select p.company_id, p.role, p.branch_id into company_id, v_role, v_branch
  from public.profiles p where p.id = user_id and p.active = true;
  if company_id is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.companies c where c.id = company_id and 'pedidos' = any(c.features)) then
    raise exception 'Esta empresa no tiene la pantalla Pedidos';
  end if;
  if v_role not in ('manager', 'cashier') then
    raise exception 'Los pedidos se cargan con el usuario de cajero o encargado del local';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = orders_caller.company_id) then
    raise exception 'Sucursal inválida';
  end if;
  if v_branch is distinct from p_branch_id then
    raise exception 'Solo podés cargar pedidos de tu sucursal';
  end if;
end;
$$;
revoke all on function public.orders_caller(uuid) from public, anon, authenticated;

-- Guardar (nuevo o editar) --------------------------------------------------
-- p_items: [{product_id, quantity, notes?}]. Los ítems se reemplazan enteros al editar.

create or replace function public.save_customer_order(
  p_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_pickup_date date,
  p_pickup_time time,
  p_notes text,
  p_total numeric,
  p_deposit numeric,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_order public.customer_orders%rowtype;
  v_id uuid;
  v_name text := nullif(btrim(regexp_replace(coalesce(p_customer_name, ''), '\s+', ' ', 'g')), '');
  v_phone text := nullif(btrim(coalesce(p_customer_phone, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric;
  v_pos integer := 0;
begin
  if p_id is not null then
    select * into v_order from public.customer_orders where id = p_id for update;
    if v_order.id is null then raise exception 'Pedido inválido'; end if;
    select * into c from public.orders_caller(v_order.branch_id);
    if v_order.company_id <> c.company_id then raise exception 'Pedido inválido'; end if;
    if v_order.status in ('entregado', 'cancelado') then
      raise exception 'Ese pedido ya está %: no se puede cambiar', v_order.status;
    end if;
    if p_branch_id is not null and p_branch_id <> v_order.branch_id then
      raise exception 'Un pedido no se cambia de sucursal: cancelalo y cargalo en la otra';
    end if;
  else
    select * into c from public.orders_caller(p_branch_id);
  end if;

  if v_name is null then raise exception 'Poné el nombre del cliente'; end if;
  if length(v_name) > 80 then raise exception 'El nombre es muy largo'; end if;
  if v_phone is not null and length(v_phone) > 40 then raise exception 'El teléfono es muy largo'; end if;
  if v_notes is not null and length(v_notes) > 300 then raise exception 'La nota es muy larga (300 letras)'; end if;
  if p_pickup_date is null then raise exception 'Elegí el día de retiro'; end if;
  if p_total is not null and p_total < 0 then raise exception 'El total no puede ser negativo'; end if;
  if coalesce(p_deposit, 0) < 0 then raise exception 'La seña no puede ser negativa'; end if;
  if p_total is not null and coalesce(p_deposit, 0) > p_total then raise exception 'La seña no puede ser mayor que el total'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agregá al menos un producto';
  end if;
  if jsonb_array_length(p_items) > 60 then raise exception 'Demasiados productos en un pedido'; end if;
  if p_customer_id is not null and not exists (
    select 1 from public.customers where id = p_customer_id and company_id = c.company_id
  ) then
    raise exception 'Cliente inválido';
  end if;

  if p_id is null then
    insert into public.customer_orders (
      company_id, branch_id, customer_id, customer_name, customer_phone, pickup_date, pickup_time, notes,
      total, deposit, created_by
    ) values (
      c.company_id, p_branch_id, p_customer_id, v_name, v_phone, p_pickup_date, p_pickup_time, v_notes,
      p_total, coalesce(p_deposit, 0), c.user_id
    )
    returning id into v_id;
  else
    v_id := p_id;
    update public.customer_orders
    set customer_id = p_customer_id, customer_name = v_name, customer_phone = v_phone,
        pickup_date = p_pickup_date, pickup_time = p_pickup_time, notes = v_notes,
        total = p_total, deposit = coalesce(p_deposit, 0), updated_at = now()
    where id = v_id;
    delete from public.customer_order_items where order_id = v_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 then raise exception 'Cantidad inválida'; end if;
    select * into v_product from public.products
    where id = (v_item ->> 'product_id')::uuid and company_id = c.company_id;
    if v_product.id is null then raise exception 'Producto inválido'; end if;
    insert into public.customer_order_items (company_id, order_id, product_id, quantity, unit, notes, position)
    values (c.company_id, v_id, v_product.id, round(v_qty, 3), v_product.unit,
            nullif(left(btrim(coalesce(v_item ->> 'notes', '')), 120), ''), v_pos);
    v_pos := v_pos + 1;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, coalesce(p_branch_id, v_order.branch_id), c.user_id,
          case when p_id is null then 'customer_order.create' else 'customer_order.update' end,
          'customer_order', v_id::text,
          jsonb_build_object('customer_name', v_name, 'pickup_date', p_pickup_date, 'pickup_time', p_pickup_time,
                             'items', jsonb_array_length(p_items), 'total', p_total, 'deposit', coalesce(p_deposit, 0)));

  return v_id;
end;
$$;
revoke all on function public.save_customer_order(uuid, uuid, uuid, text, text, date, time, text, numeric, numeric, jsonb) from public, anon;
grant execute on function public.save_customer_order(uuid, uuid, uuid, text, text, date, time, text, numeric, numeric, jsonb) to authenticated;

-- Cambiar el estado ---------------------------------------------------------
-- pendiente ↔ listo, (pendiente|listo) → entregado | cancelado. Entregado y cancelado son finales.

create or replace function public.set_customer_order_status(p_id uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_order public.customer_orders%rowtype;
begin
  if p_status is null or p_status not in ('pendiente', 'listo', 'entregado', 'cancelado') then
    raise exception 'Estado inválido';
  end if;
  select * into v_order from public.customer_orders where id = p_id for update;
  if v_order.id is null then raise exception 'Pedido inválido'; end if;
  select * into c from public.orders_caller(v_order.branch_id);
  if v_order.company_id <> c.company_id then raise exception 'Pedido inválido'; end if;
  if v_order.status = p_status then return p_status; end if;
  if v_order.status in ('entregado', 'cancelado') then
    raise exception 'Ese pedido ya está %', v_order.status;
  end if;

  update public.customer_orders
  set status = p_status, status_changed_at = now(), updated_at = now()
  where id = p_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (c.company_id, v_order.branch_id, c.user_id, 'customer_order.status', 'customer_order', p_id::text,
          jsonb_build_object('status', v_order.status), jsonb_build_object('status', p_status));
  return p_status;
end;
$$;
revoke all on function public.set_customer_order_status(uuid, text) from public, anon;
grant execute on function public.set_customer_order_status(uuid, text) to authenticated;

-- Pantalla a pedido: se suma 'pedidos' a la lista de set_company_feature (misma función que 173).
create or replace function public.set_company_feature(p_company_id uuid, p_feature text, p_enabled boolean)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_features text[];
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_feature is null or p_feature not in ('frigorifico', 'cuentas', 'gastos', 'reporte_ventas', 'ventas_detalle', 'paquetes', 'venta_ruta', 'costo_parejo', 'traer_balanza', 'pedidos') then
    raise exception 'Pantalla inválida';
  end if;
  update public.companies
  set features = case
    when coalesce(p_enabled, false) then (select array(select distinct unnest(features || array[p_feature])))
    else array_remove(features, p_feature)
  end
  where id = p_company_id
  returning features into v_features;
  if not found then
    raise exception 'Cliente inválido';
  end if;
  return v_features;
end;
$$;
revoke all on function public.set_company_feature(uuid, text, boolean) from public, anon;
grant execute on function public.set_company_feature(uuid, text, boolean) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('187_customer_orders') on conflict do nothing;
