-- 196: Negocios que no son carnicería + Pedidos para venta online (2026-11-09, pedido del dueño para "mates and chill":
-- venta de mates online con retiro en la casa, un solo usuario que es el dueño).
--
-- Dos pantallas a pedido nuevas (companies.features, panel de plataforma → "Pantallas a pedido"):
--
-- - 'sin_carniceria': solo web. Esconde Despiece, Balanzas y Frigorífico a todos los usuarios de la empresa, los productos
--   nuevos arrancan "por unidad" y "+ Agregar producto" deja cargar variantes (un producto con su stock por color/modelo).
--   No toca la base: las funciones de despiece/balanza no cambian para nadie.
--
-- - 'pedidos_tienda' (junto con 'pedidos'): el dueño y el administrador también ven y cargan los pedidos (en 187 eran
--   solo del cajero y el encargado del local), y un pedido se cobra en Mostrador: la web carga sus productos en el ticket
--   y, con la venta hecha, deliver_customer_order lo marca entregado y guarda qué venta fue (customer_orders.pos_sale_id).
--   La venta es una venta normal de Mostrador (create_pos_sale, sin cambios): baja stock y entra a Tesorería como siempre.
--   Las empresas que solo tienen 'pedidos' siguen exactamente igual.

-- 1. Lista de pantallas a pedido que acepta el panel de plataforma.
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
  if p_feature is null or p_feature not in ('frigorifico', 'cuentas', 'gastos', 'reporte_ventas', 'ventas_detalle', 'paquetes',
                                             'venta_ruta', 'costo_parejo', 'traer_balanza', 'pedidos',
                                             'sin_carniceria', 'pedidos_tienda') then
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

-- 2. ¿La empresa del que llama tiene Pedidos para tienda? (solo sobre el que llama, como orders_enabled)
create or replace function public.orders_owner_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.companies
    where id = public.current_company_id() and 'pedidos_tienda' = any(features)
  );
$$;

revoke all on function public.orders_owner_enabled() from public, anon;
grant execute on function public.orders_owner_enabled() to authenticated;

-- 3. Quién ve los pedidos de una sucursal: cajero/encargado de esa sucursal (187/191), y con 'pedidos_tienda' también
--    el dueño y el administrador (my_branch_allowed ya les deja cualquier sucursal).
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
      and (p.role in ('manager', 'cashier')
           or (p.role in ('owner', 'admin') and public.orders_owner_enabled()))
  ) and public.my_branch_allowed(p_branch_id);
$$;

-- 4. Lo mismo para escribir (save_customer_order, set_customer_order_status y deliver_customer_order lo llaman).
create or replace function public.orders_caller(p_branch_id uuid, out company_id uuid, out user_id uuid)
language plpgsql
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
  if not (v_role in ('manager', 'cashier')
          or (v_role in ('owner', 'admin')
              and exists (select 1 from public.companies c where c.id = company_id and 'pedidos_tienda' = any(c.features)))) then
    raise exception 'Los pedidos se cargan con el usuario de cajero o encargado del local';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = orders_caller.company_id) then
    raise exception 'Sucursal inválida';
  end if;
  if not public.my_branch_allowed(p_branch_id) then
    raise exception 'Solo podés cargar pedidos de tu sucursal';
  end if;
end;
$$;

revoke all on function public.orders_caller(uuid) from public, anon, authenticated;

-- 5. Qué venta de Mostrador cobró el pedido.
alter table public.customer_orders add column if not exists pos_sale_id uuid references public.pos_sales(id) on delete set null;

-- 6. Cobrado en Mostrador: entregado + la venta. Si la venta quedó en la cola sin conexión, p_pos_sale_id va null.
create or replace function public.deliver_customer_order(p_id uuid, p_pos_sale_id uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_order public.customer_orders%rowtype;
begin
  select * into v_order from public.customer_orders where id = p_id for update;
  if v_order.id is null then raise exception 'Pedido inválido'; end if;
  select * into c from public.orders_caller(v_order.branch_id);
  if v_order.company_id <> c.company_id then raise exception 'Pedido inválido'; end if;
  if v_order.status = 'entregado' then return 'entregado'; end if;
  if v_order.status = 'cancelado' then raise exception 'Ese pedido ya está cancelado'; end if;
  if p_pos_sale_id is not null and not exists (
    select 1 from public.pos_sales s
    where s.id = p_pos_sale_id and s.company_id = c.company_id and s.branch_id = v_order.branch_id and s.voided_at is null
  ) then
    raise exception 'Venta inválida';
  end if;

  update public.customer_orders
  set status = 'entregado', pos_sale_id = p_pos_sale_id, status_changed_at = now(), updated_at = now()
  where id = p_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (c.company_id, v_order.branch_id, c.user_id, 'customer_order.deliver', 'customer_order', p_id::text,
          jsonb_build_object('status', v_order.status),
          jsonb_build_object('status', 'entregado', 'pos_sale_id', p_pos_sale_id));
  return 'entregado';
end;
$$;

revoke all on function public.deliver_customer_order(uuid, uuid) from public, anon;
grant execute on function public.deliver_customer_order(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('196_tienda_pedidos_dueno') on conflict do nothing;
