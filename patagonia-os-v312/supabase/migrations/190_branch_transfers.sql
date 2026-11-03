-- 190: Sucursales etapa 2, mover la mercadería como una empresa (2026-11-02, plan Empresa, migración 189).
-- Maqueta aprobada por el dueño el 02/11 ("Sí, armá la etapa 2").
--
-- Recorrido: pedido → preparando → en viaje → recibido (o cancelado).
--   - Un local PIDE a otro (normalmente la Planta o el depósito) productos y cantidades: request_branch_transfer.
--   - El que manda lo PREPARA (puede cambiar cantidades, sumar productos o mandar 0) y lo DESPACHA:
--     prepare_branch_transfer / dispatch_branch_transfer. También puede armar un envío sin pedido.
--   - Al despachar la mercadería sale del stock del origen (transfer_out) y queda "en viaje": no está en ningún
--     local hasta que el destino la recibe. Sale con remito: el interno (el número del envío) o, si la empresa
--     tiene CAI, un Remito R (tabla remitos de la 147/148, con branch_transfer_id).
--   - El que recibe anota lo que llegó (receive_branch_transfer): entra eso (transfer_in) y quién lo recibió.
--     Lo que no llegó NO vuelve al origen: queda registrado como faltante del traslado (sent − received) y el
--     dueño lo ve en Sucursales. Decisión del dueño (propuesta de la maqueta): así el stock es lo que hay de verdad.
--   - Antes de despachar se cancela (cancel_branch_transfer). Ya en viaje, solo dueño/administrador lo anula
--     (void_branch_transfer): la mercadería vuelve al origen y el Remito R, si hubo, queda anulado.
-- El pase instantáneo de la 098 (transfer_branch_stock, "Pase rápido") sigue igual.
--
-- Mínimo de stock por local: branch_min_stock (producto + local). Sin fila, vale el mínimo general
-- (products.min_stock). Lo cargan dueño/administrador (set_branch_min_stock).
--
-- Quién: dueño y administrador en cualquier local; encargado, cajero y producción solo en SU local
-- (pide para su local, prepara/despacha desde su local, recibe en su local). Esa regla vive en un solo lugar,
-- transfers_branch_allowed, para que la etapa 3 (encargado de varios locales) la cambie ahí.
-- Lectura: toda la empresa, solo con plan Empresa. Escritura: solo por estas funciones (migración 175).

-- Tablas -----------------------------------------------------------------------------------------------------

create table if not exists public.branch_transfers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  number integer not null check (number > 0),
  from_branch_id uuid not null references public.branches(id),
  to_branch_id uuid not null references public.branches(id),
  status text not null default 'pedido' check (status in ('pedido', 'preparando', 'en_viaje', 'recibido', 'cancelado')),
  needed_by date,
  request_notes text check (request_notes is null or length(request_notes) <= 300),
  carrier text check (carrier is null or length(carrier) <= 80),
  vehicle text check (vehicle is null or length(vehicle) <= 40),
  show_cost boolean not null default false,
  remito_id uuid references public.remitos(id),
  requested_by uuid references auth.users(id),
  requested_at timestamptz,
  prepared_by uuid references auth.users(id),
  prepared_at timestamptz,
  dispatched_by uuid references auth.users(id),
  dispatched_at timestamptz,
  received_by uuid references auth.users(id),
  received_by_name text check (received_by_name is null or length(received_by_name) <= 60),
  received_at timestamptz,
  receive_notes text check (receive_notes is null or length(receive_notes) <= 300),
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 200),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_branch_id <> to_branch_id),
  unique (company_id, number)
);

create table if not exists public.branch_transfer_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  transfer_id uuid not null references public.branch_transfers(id) on delete cascade,
  product_id uuid not null references public.products(id),
  -- null = no estaba en el pedido (lo sumó el que manda).
  requested_qty numeric(12, 3) check (requested_qty is null or requested_qty > 0),
  sent_qty numeric(12, 3) check (sent_qty is null or sent_qty >= 0),
  received_qty numeric(12, 3) check (received_qty is null or received_qty >= 0),
  -- Costo del producto al despachar (para el remito y el valor de lo que está en viaje).
  unit_cost numeric(14, 2),
  position integer not null default 0,
  unique (transfer_id, product_id)
);

create table if not exists public.branch_min_stock (
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  product_id uuid not null references public.products(id) on delete cascade,
  min_stock numeric(12, 3) not null check (min_stock > 0),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (branch_id, product_id)
);

create index if not exists branch_transfers_status_idx on public.branch_transfers (company_id, status, created_at desc);
create index if not exists branch_transfers_from_idx on public.branch_transfers (from_branch_id, status);
create index if not exists branch_transfers_to_idx on public.branch_transfers (to_branch_id, status);
create index if not exists branch_transfer_items_transfer_idx on public.branch_transfer_items (transfer_id);
create index if not exists branch_min_stock_company_idx on public.branch_min_stock (company_id, branch_id);

-- El Remito R de un envío (uno emitido por envío).
alter table public.remitos add column if not exists branch_transfer_id uuid references public.branch_transfers(id);
create unique index if not exists remitos_one_per_transfer on public.remitos (branch_transfer_id)
  where status = 'emitido' and branch_transfer_id is not null;

alter table public.branch_transfers enable row level security;
alter table public.branch_transfer_items enable row level security;
alter table public.branch_min_stock enable row level security;
revoke all on public.branch_transfers from anon, authenticated;
revoke all on public.branch_transfer_items from anon, authenticated;
revoke all on public.branch_min_stock from anon, authenticated;
grant select on public.branch_transfers, public.branch_transfer_items, public.branch_min_stock to authenticated;

drop policy if exists branch_transfers_company_read on public.branch_transfers;
create policy branch_transfers_company_read on public.branch_transfers for select to authenticated
  using (company_id = public.current_company_id());
drop policy if exists branch_transfer_items_company_read on public.branch_transfer_items;
create policy branch_transfer_items_company_read on public.branch_transfer_items for select to authenticated
  using (company_id = public.current_company_id());
drop policy if exists branch_min_stock_company_read on public.branch_min_stock;
create policy branch_min_stock_company_read on public.branch_min_stock for select to authenticated
  using (company_id = public.current_company_id());

drop policy if exists plan_empresa on public.branch_transfers;
create policy plan_empresa on public.branch_transfers as restrictive for all to authenticated
  using (public.company_plan_allows('empresa')) with check (public.company_plan_allows('empresa'));
drop policy if exists plan_empresa on public.branch_transfer_items;
create policy plan_empresa on public.branch_transfer_items as restrictive for all to authenticated
  using (public.company_plan_allows('empresa')) with check (public.company_plan_allows('empresa'));
drop policy if exists plan_empresa on public.branch_min_stock;
create policy plan_empresa on public.branch_min_stock as restrictive for all to authenticated
  using (public.company_plan_allows('empresa')) with check (public.company_plan_allows('empresa'));

-- El Contador no escribe nada (migración 155).
drop trigger if exists zz_accountant_readonly on public.branch_transfers;
create trigger zz_accountant_readonly before insert or update or delete on public.branch_transfers
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.branch_transfer_items;
create trigger zz_accountant_readonly before insert or update or delete on public.branch_transfer_items
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.branch_min_stock;
create trigger zz_accountant_readonly before insert or update or delete on public.branch_min_stock
  for each statement execute function public.accountant_readonly_guard();

-- Helpers internos (no expuestos) ------------------------------------------------------------------------------

-- Quién llama. Plan Empresa y un papel que trabaja con mercadería.
create or replace function public.transfers_caller(out company_id uuid, out user_id uuid, out role text, out branch_id uuid, out full_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_plan('empresa');
  user_id := auth.uid();
  if user_id is null then raise exception 'Usuario no autenticado'; end if;
  select p.company_id, p.role, p.branch_id, p.full_name into company_id, role, branch_id, full_name
  from public.profiles p where p.id = user_id and p.active = true;
  if company_id is null then raise exception 'Perfil inválido'; end if;
  if role not in ('owner', 'admin', 'manager', 'production', 'cashier') then
    raise exception 'No autorizado para mover mercadería entre locales';
  end if;
end;
$$;

-- ¿Puede actuar por ese local? Dueño/administrador en todos; el resto solo en el suyo.
-- Etapa 3 (encargado de varios locales): cambiar solo esto.
create or replace function public.transfers_branch_allowed(p_role text, p_own_branch uuid, p_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_role in ('owner', 'admin') or (p_own_branch is not null and p_own_branch = p_branch);
$$;

create or replace function public.transfers_check_branches(p_company_id uuid, p_from uuid, p_to uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from record;
  v_to record;
begin
  select id, active, is_vehicle into v_from from public.branches where id = p_from and company_id = p_company_id;
  if v_from.id is null or not v_from.active then raise exception 'Local de origen inválido'; end if;
  select id, active, is_vehicle into v_to from public.branches where id = p_to and company_id = p_company_id;
  if v_to.id is null or not v_to.active then raise exception 'Local de destino inválido'; end if;
  if p_from = p_to then raise exception 'Elegí dos locales distintos'; end if;
  if v_from.is_vehicle or v_to.is_vehicle then
    raise exception 'Los camiones se cargan desde Camiones, no con un envío entre locales';
  end if;
end;
$$;

create or replace function public.transfers_check_product(p_company_id uuid, p_product_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_product record;
begin
  select id, name, active, stock_source_id into v_product
  from public.products where id = p_product_id and company_id = p_company_id;
  if v_product.id is null then raise exception 'Producto inválido'; end if;
  if v_product.active = false then raise exception '"%" está dado de baja', v_product.name; end if;
  if v_product.stock_source_id is not null then
    raise exception '"%" es una presentación: pedí o mandá el producto principal', v_product.name;
  end if;
  return v_product.name;
end;
$$;

-- Número correlativo por empresa (es el número del pedido y del remito interno).
create or replace function public.transfers_next_number(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('branch_transfers:' || p_company_id::text, 0));
  select coalesce(max(number), 0) + 1 into v_next from public.branch_transfers where company_id = p_company_id;
  return v_next;
end;
$$;

-- Crea un envío sin pedido o actualiza uno pedido/preparando con lo que se manda. p_items: [{product_id, quantity}]
-- con quantity >= 0 (0 = no se manda). Lo pedido que no viene en p_items queda en 0; lo agregado que se sacó se borra.
create or replace function public.branch_transfer_save(
  p_company_id uuid, p_user_id uuid, p_role text, p_own_branch uuid,
  p_id uuid, p_from uuid, p_to uuid, p_items jsonb, p_carrier text, p_vehicle text, p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer public.branch_transfers%rowtype;
  v_id uuid;
  v_item jsonb;
  v_pid uuid;
  v_qty numeric;
  v_seen uuid[] := '{}';
  v_pos integer := 0;
  v_carrier text := nullif(btrim(coalesce(p_carrier, '')), '');
  v_vehicle text := nullif(btrim(coalesce(p_vehicle, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if v_carrier is not null and length(v_carrier) > 80 then raise exception 'El nombre de quien lo lleva es muy largo'; end if;
  if v_vehicle is not null and length(v_vehicle) > 40 then raise exception 'La patente es muy larga'; end if;
  if v_notes is not null and length(v_notes) > 300 then raise exception 'La nota es muy larga (300 letras)'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Faltan los productos'; end if;

  if p_id is null then
    if not public.transfers_branch_allowed(p_role, p_own_branch, p_from) then
      raise exception 'Solo podés mandar mercadería desde tu local';
    end if;
    perform public.transfers_check_branches(p_company_id, p_from, p_to);
    v_id := gen_random_uuid();
    insert into public.branch_transfers (id, company_id, number, from_branch_id, to_branch_id, status, request_notes, created_by)
    values (v_id, p_company_id, public.transfers_next_number(p_company_id), p_from, p_to, 'preparando', v_notes, p_user_id);
  else
    select * into v_transfer from public.branch_transfers where id = p_id and company_id = p_company_id for update;
    if v_transfer.id is null then raise exception 'Envío inválido'; end if;
    if v_transfer.status = 'cancelado' then raise exception 'Ese pedido está cancelado'; end if;
    if v_transfer.status in ('en_viaje', 'recibido') then raise exception 'Ese envío ya salió: no se puede cambiar'; end if;
    if not public.transfers_branch_allowed(p_role, p_own_branch, v_transfer.from_branch_id) then
      raise exception 'Solo el local que manda puede preparar este pedido';
    end if;
    v_id := p_id;
  end if;

  update public.branch_transfer_items set sent_qty = 0 where transfer_id = v_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid := nullif(v_item->>'product_id', '')::uuid;
    v_qty := nullif(v_item->>'quantity', '')::numeric;
    if v_pid is null then raise exception 'Producto inválido'; end if;
    if v_qty is null or v_qty < 0 then raise exception 'Las cantidades no pueden ser negativas'; end if;
    if v_qty > 100000 then raise exception 'Cantidad demasiado grande'; end if;
    if v_pid = any(v_seen) then raise exception 'Hay un producto repetido'; end if;
    v_seen := v_seen || v_pid;
    v_pos := v_pos + 1;
    if exists (select 1 from public.branch_transfer_items where transfer_id = v_id and product_id = v_pid) then
      update public.branch_transfer_items set sent_qty = v_qty where transfer_id = v_id and product_id = v_pid;
    else
      perform public.transfers_check_product(p_company_id, v_pid);
      insert into public.branch_transfer_items (company_id, transfer_id, product_id, requested_qty, sent_qty, position)
      values (p_company_id, v_id, v_pid, null, v_qty, 1000 + v_pos);
    end if;
  end loop;

  -- Lo que agregó el que manda y después sacó, se borra (lo pedido queda, en 0).
  delete from public.branch_transfer_items
  where transfer_id = v_id and requested_qty is null and not (product_id = any(v_seen));

  update public.branch_transfers
  set status = 'preparando', carrier = v_carrier, vehicle = v_vehicle,
      request_notes = case when p_id is null then v_notes else request_notes end,
      prepared_by = p_user_id, prepared_at = now(), updated_at = now()
  where id = v_id;

  return v_id;
end;
$$;

-- Remito R de un envío (misma numeración y CAI que issue_remito de la 148). Transporte propio: sin transportista.
create or replace function public.branch_transfer_issue_remito(p_company_id uuid, p_user_id uuid, p_transfer_id uuid, p_delivery_address text, p_show_cost boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer record;
  v_fiscal record;
  v_cai record;
  v_next integer;
  v_items jsonb;
  v_total numeric;
  v_id uuid;
  v_today date := public.today_ar();
  v_address text := nullif(btrim(coalesce(p_delivery_address, '')), '');
  v_notes text;
begin
  select t.*, bf.name as from_name, bt.name as to_name into v_transfer
  from public.branch_transfers t
  join public.branches bf on bf.id = t.from_branch_id
  join public.branches bt on bt.id = t.to_branch_id
  where t.id = p_transfer_id and t.company_id = p_company_id;
  if v_transfer.id is null then raise exception 'Envío inválido'; end if;

  select id into v_id from public.remitos where branch_transfer_id = p_transfer_id and status = 'emitido';
  if v_id is not null then return v_id; end if;

  select * into v_fiscal from public.company_fiscal_settings where company_id = p_company_id;
  if v_fiscal is null
     or nullif(trim(coalesce(v_fiscal.cuit, '')), '') is null
     or nullif(trim(coalesce(v_fiscal.business_name, '')), '') is null
     or nullif(trim(coalesce(v_fiscal.address, '')), '') is null
     or nullif(trim(coalesce(v_fiscal.gross_income_number, '')), '') is null
     or v_fiscal.activity_start is null then
    raise exception 'Faltan datos fiscales del negocio para el remito (CUIT, razón social, domicilio, Ingresos Brutos e inicio de actividades): cargalos en Facturas';
  end if;
  if v_fiscal.tax_condition = 'monotributo' then
    raise exception 'Un monotributista no puede ser autoimpresor: el Remito R desde el sistema es solo para responsables inscriptos o exentos';
  end if;
  if v_address is null then raise exception 'Para el Remito R falta el domicilio del local que recibe'; end if;
  if length(v_address) > 200 then raise exception 'El domicilio es muy largo'; end if;

  select jsonb_agg(jsonb_build_object(
      'description', p.name, 'code', p.code, 'unit', p.unit, 'quantity', i.sent_qty,
      'unit_price', coalesce(i.unit_cost, 0), 'line_total', round(i.sent_qty * coalesce(i.unit_cost, 0), 2)
    ) order by i.position, p.name),
    sum(round(i.sent_qty * coalesce(i.unit_cost, 0), 2))
  into v_items, v_total
  from public.branch_transfer_items i
  join public.products p on p.id = i.product_id
  where i.transfer_id = p_transfer_id and i.sent_qty > 0;
  if v_items is null then raise exception 'El envío no tiene productos'; end if;

  for v_cai in
    select * from public.remito_cai
    where company_id = p_company_id and active and cai_due >= v_today
    order by cai_due, number_from
    for update
  loop
    select greatest(v_cai.number_from, coalesce(max(number), 0) + 1) into v_next
    from public.remitos where company_id = p_company_id and point_of_sale = v_cai.point_of_sale;
    if v_next <= v_cai.number_to then
      exit;
    end if;
    v_next := null;
  end loop;
  if v_next is null then
    raise exception 'No hay un CAI vigente con números libres: cargá uno nuevo en Facturas → Remito R, o mandalo con el remito interno';
  end if;

  v_notes := 'Traslado entre locales propios: ' || v_transfer.from_name || ' → ' || v_transfer.to_name || '. Envío N.º ' || v_transfer.number
    || coalesce('. Lo lleva: ' || v_transfer.carrier, '') || coalesce(' (' || v_transfer.vehicle || ')', '');

  insert into public.remitos (
    company_id, branch_id, cai_id, point_of_sale, number, cai, cai_due, issued_on,
    customer_id, customer_charge_id, branch_transfer_id, issuer, receiver, items, show_values, total,
    delivery_address, carrier, notes, created_by
  ) values (
    p_company_id, v_transfer.from_branch_id, v_cai.id, v_cai.point_of_sale, v_next, v_cai.cai, v_cai.cai_due, v_today,
    null, null, p_transfer_id,
    jsonb_build_object(
      'business_name', v_fiscal.business_name, 'trade_name', v_fiscal.trade_name, 'cuit', v_fiscal.cuit,
      'tax_condition', v_fiscal.tax_condition, 'address', v_fiscal.address,
      'gross_income_number', v_fiscal.gross_income_number, 'activity_start', v_fiscal.activity_start),
    jsonb_build_object(
      'name', v_fiscal.business_name || ' — local ' || v_transfer.to_name, 'number', null,
      'tax_id', regexp_replace(v_fiscal.cuit, '\D', '', 'g'), 'tax_condition', v_fiscal.tax_condition,
      'address', v_address, 'locality', null, 'province', null),
    v_items, coalesce(p_show_cost, false), v_total,
    v_address, null, v_notes, p_user_id
  ) returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (p_company_id, v_transfer.from_branch_id, p_user_id, 'remito.issue', 'remito', v_id::text,
    jsonb_build_object('point_of_sale', v_cai.point_of_sale, 'number', v_next, 'branch_transfer_id', p_transfer_id));

  return v_id;
end;
$$;

revoke all on function public.transfers_caller() from public, anon, authenticated;
revoke all on function public.transfers_branch_allowed(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.transfers_check_branches(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.transfers_check_product(uuid, uuid) from public, anon, authenticated;
revoke all on function public.transfers_next_number(uuid) from public, anon, authenticated;
revoke all on function public.branch_transfer_save(uuid, uuid, text, uuid, uuid, uuid, uuid, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.branch_transfer_issue_remito(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;

-- 1. Pedir ------------------------------------------------------------------------------------------------------
-- p_items: [{product_id, quantity}] con quantity > 0.
create or replace function public.request_branch_transfer(p_from uuid, p_to uuid, p_needed_by date, p_notes text, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_id uuid := gen_random_uuid();
  v_number integer;
  v_item jsonb;
  v_pid uuid;
  v_qty numeric;
  v_seen uuid[] := '{}';
  v_pos integer := 0;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  select * into c from public.transfers_caller();
  if not public.transfers_branch_allowed(c.role, c.branch_id, p_to) then
    raise exception 'Solo podés pedir mercadería para tu local';
  end if;
  perform public.transfers_check_branches(c.company_id, p_from, p_to);
  if v_notes is not null and length(v_notes) > 300 then raise exception 'La nota es muy larga (300 letras)'; end if;
  if p_needed_by is not null and p_needed_by < public.today_ar() - 1 then raise exception 'La fecha ya pasó'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agregá al menos un producto';
  end if;

  v_number := public.transfers_next_number(c.company_id);
  insert into public.branch_transfers (id, company_id, number, from_branch_id, to_branch_id, status, needed_by, request_notes, requested_by, requested_at, created_by)
  values (v_id, c.company_id, v_number, p_from, p_to, 'pedido', p_needed_by, v_notes, c.user_id, now(), c.user_id);

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid := nullif(v_item->>'product_id', '')::uuid;
    v_qty := nullif(v_item->>'quantity', '')::numeric;
    if v_pid is null then raise exception 'Producto inválido'; end if;
    if v_qty is null or v_qty <= 0 then raise exception 'Cada producto necesita una cantidad mayor que cero'; end if;
    if v_qty > 100000 then raise exception 'Cantidad demasiado grande'; end if;
    if v_pid = any(v_seen) then raise exception 'Hay un producto repetido'; end if;
    v_seen := v_seen || v_pid;
    perform public.transfers_check_product(c.company_id, v_pid);
    v_pos := v_pos + 1;
    insert into public.branch_transfer_items (company_id, transfer_id, product_id, requested_qty, position)
    values (c.company_id, v_id, v_pid, v_qty, v_pos);
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, p_to, c.user_id, 'branch_transfer.request', 'branch_transfer', v_id::text,
    jsonb_build_object('number', v_number, 'from_branch_id', p_from, 'to_branch_id', p_to, 'items', jsonb_array_length(p_items)));

  return v_id;
end;
$$;

-- 2. Preparar (guardar y seguir después) ---------------------------------------------------------------------------
-- p_id null = envío sin pedido (de p_from a p_to). Con p_id, p_from/p_to se ignoran.
create or replace function public.prepare_branch_transfer(p_id uuid, p_from uuid, p_to uuid, p_items jsonb, p_carrier text, p_vehicle text, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_id uuid;
begin
  select * into c from public.transfers_caller();
  v_id := public.branch_transfer_save(c.company_id, c.user_id, c.role, c.branch_id, p_id, p_from, p_to, p_items, p_carrier, p_vehicle, p_notes);
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, c.user_id, 'branch_transfer.prepare', 'branch_transfer', v_id::text, jsonb_build_object('items', jsonb_array_length(p_items)));
  return v_id;
end;
$$;

-- 3. Despachar: guarda lo que se manda, lo saca del stock del origen y queda en viaje ---------------------------------
-- Como route_load_vehicle (161), no frena si el origen queda en negativo (la pantalla avisa antes).
create or replace function public.dispatch_branch_transfer(
  p_id uuid, p_from uuid, p_to uuid, p_items jsonb, p_carrier text, p_vehicle text, p_notes text,
  p_remito_r boolean default false, p_show_cost boolean default false, p_delivery_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_id uuid;
  v_transfer record;
  v_remito uuid;
  v_reason text;
begin
  select * into c from public.transfers_caller();
  v_id := public.branch_transfer_save(c.company_id, c.user_id, c.role, c.branch_id, p_id, p_from, p_to, p_items, p_carrier, p_vehicle, p_notes);

  select t.*, bt.name as to_name into v_transfer
  from public.branch_transfers t join public.branches bt on bt.id = t.to_branch_id
  where t.id = v_id for update of t;

  if not exists (select 1 from public.branch_transfer_items where transfer_id = v_id and sent_qty > 0) then
    raise exception 'No hay nada para mandar: poné la cantidad de al menos un producto';
  end if;

  -- Bloquea los productos en orden (como transfer_branch_stock) para no cruzarse con otro movimiento.
  perform 1 from public.products
  where id in (select product_id from public.branch_transfer_items where transfer_id = v_id and sent_qty > 0)
  order by id for update;

  update public.branch_transfer_items i set unit_cost = p.cost
  from public.products p where p.id = i.product_id and i.transfer_id = v_id;

  v_reason := 'Envío N.º ' || v_transfer.number || ' a ' || v_transfer.to_name;
  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  select c.company_id, v_transfer.from_branch_id, i.product_id, 'transfer_out', -i.sent_qty, 'branch_shipment', v_id, v_reason, c.user_id
  from public.branch_transfer_items i where i.transfer_id = v_id and i.sent_qty > 0;

  update public.branch_transfers
  set status = 'en_viaje', dispatched_by = c.user_id, dispatched_at = now(), show_cost = coalesce(p_show_cost, false), updated_at = now()
  where id = v_id;

  if coalesce(p_remito_r, false) then
    v_remito := public.branch_transfer_issue_remito(c.company_id, c.user_id, v_id, p_delivery_address, p_show_cost);
    update public.branch_transfers set remito_id = v_remito where id = v_id;
  end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, v_transfer.from_branch_id, c.user_id, 'branch_transfer.dispatch', 'branch_transfer', v_id::text,
    jsonb_build_object('number', v_transfer.number, 'to_branch_id', v_transfer.to_branch_id, 'remito_id', v_remito,
      'items', (select jsonb_agg(jsonb_build_object('product_id', product_id, 'sent', sent_qty)) from public.branch_transfer_items where transfer_id = v_id and sent_qty > 0)));

  return jsonb_build_object('id', v_id, 'number', v_transfer.number, 'remito_id', v_remito);
end;
$$;

-- 4. Recibir: entra lo que llegó; la diferencia queda registrada como faltante (o sobrante) del traslado ---------------
-- p_items: [{item_id, received}], uno por cada producto que se mandó.
create or replace function public.receive_branch_transfer(p_id uuid, p_items jsonb, p_received_by_name text, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_transfer record;
  v_item record;
  v_received numeric;
  v_name text := nullif(btrim(coalesce(p_received_by_name, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_reason text;
  v_missing numeric := 0;
  v_extra numeric := 0;
begin
  select * into c from public.transfers_caller();
  select t.*, bf.name as from_name into v_transfer
  from public.branch_transfers t join public.branches bf on bf.id = t.from_branch_id
  where t.id = p_id and t.company_id = c.company_id for update of t;
  if v_transfer.id is null then raise exception 'Envío inválido'; end if;
  if v_transfer.status = 'recibido' then raise exception 'Ese envío ya se recibió'; end if;
  if v_transfer.status <> 'en_viaje' then raise exception 'Ese envío todavía no salió (o está cancelado)'; end if;
  if not public.transfers_branch_allowed(c.role, c.branch_id, v_transfer.to_branch_id) then
    raise exception 'Solo el local que recibe puede confirmar lo que llegó';
  end if;
  if v_name is not null and length(v_name) > 60 then raise exception 'El nombre es muy largo'; end if;
  if v_notes is not null and length(v_notes) > 300 then raise exception 'El comentario es muy largo (300 letras)'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Faltan las cantidades que llegaron'; end if;

  perform 1 from public.products
  where id in (select product_id from public.branch_transfer_items where transfer_id = p_id and sent_qty > 0)
  order by id for update;

  for v_item in
    select i.id, i.sent_qty, p.name from public.branch_transfer_items i join public.products p on p.id = i.product_id
    where i.transfer_id = p_id and i.sent_qty > 0
  loop
    select nullif(e->>'received', '')::numeric into v_received
    from jsonb_array_elements(p_items) e where (e->>'item_id')::uuid = v_item.id limit 1;
    if v_received is null then raise exception 'Falta anotar cuánto llegó de %', v_item.name; end if;
    if v_received < 0 then raise exception 'La cantidad de % no puede ser negativa', v_item.name; end if;
    if v_received > 100000 then raise exception 'Cantidad demasiado grande'; end if;
    update public.branch_transfer_items set received_qty = v_received where id = v_item.id;
    v_missing := v_missing + greatest(v_item.sent_qty - v_received, 0);
    v_extra := v_extra + greatest(v_received - v_item.sent_qty, 0);
  end loop;

  v_reason := 'Recibido envío N.º ' || v_transfer.number || ' de ' || v_transfer.from_name;
  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  select c.company_id, v_transfer.to_branch_id, i.product_id, 'transfer_in', i.received_qty, 'branch_shipment', p_id, v_reason, c.user_id
  from public.branch_transfer_items i where i.transfer_id = p_id and i.received_qty > 0;

  update public.branch_transfers
  set status = 'recibido', received_by = c.user_id, received_by_name = coalesce(v_name, c.full_name), received_at = now(),
      receive_notes = v_notes, updated_at = now()
  where id = p_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, v_transfer.to_branch_id, c.user_id, 'branch_transfer.receive', 'branch_transfer', p_id::text,
    jsonb_build_object('number', v_transfer.number, 'received_by_name', coalesce(v_name, c.full_name), 'missing', v_missing, 'extra', v_extra,
      'items', (select jsonb_agg(jsonb_build_object('product_id', product_id, 'sent', sent_qty, 'received', received_qty)) from public.branch_transfer_items where transfer_id = p_id and sent_qty > 0)));

  return jsonb_build_object('missing', v_missing, 'extra', v_extra);
end;
$$;

-- 5. Cancelar antes de despachar (el que pidió o el que manda) ------------------------------------------------------
create or replace function public.cancel_branch_transfer(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_transfer public.branch_transfers%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into c from public.transfers_caller();
  select * into v_transfer from public.branch_transfers where id = p_id and company_id = c.company_id for update;
  if v_transfer.id is null then raise exception 'Envío inválido'; end if;
  if v_transfer.status = 'cancelado' then return; end if;
  if v_transfer.status not in ('pedido', 'preparando') then
    raise exception 'Ese envío ya salió: solo el dueño o un administrador puede anularlo';
  end if;
  if not (public.transfers_branch_allowed(c.role, c.branch_id, v_transfer.from_branch_id)
          or public.transfers_branch_allowed(c.role, c.branch_id, v_transfer.to_branch_id)) then
    raise exception 'Ese pedido no es de tu local';
  end if;
  if v_reason is not null and length(v_reason) > 200 then raise exception 'El motivo es muy largo'; end if;

  update public.branch_transfers
  set status = 'cancelado', cancelled_by = c.user_id, cancelled_at = now(), cancel_reason = v_reason, updated_at = now()
  where id = p_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, c.user_id, 'branch_transfer.cancel', 'branch_transfer', p_id::text,
    jsonb_build_object('number', v_transfer.number, 'status', v_transfer.status, 'reason', v_reason));
end;
$$;

-- 6. Anular un envío en viaje (dueño/administrador): la mercadería vuelve al origen ----------------------------------
create or replace function public.void_branch_transfer(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_transfer public.branch_transfers%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into c from public.transfers_caller();
  if c.role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede anular un envío que ya salió'; end if;
  if v_reason is null then raise exception 'Escribí por qué se anula'; end if;
  if length(v_reason) > 200 then raise exception 'El motivo es muy largo'; end if;
  select * into v_transfer from public.branch_transfers where id = p_id and company_id = c.company_id for update;
  if v_transfer.id is null then raise exception 'Envío inválido'; end if;
  if v_transfer.status <> 'en_viaje' then raise exception 'Solo se anula un envío que está en viaje'; end if;

  perform 1 from public.products
  where id in (select product_id from public.branch_transfer_items where transfer_id = p_id and sent_qty > 0)
  order by id for update;

  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
  select c.company_id, v_transfer.from_branch_id, i.product_id, 'transfer_in', i.sent_qty, 'branch_shipment', p_id,
         'Envío N.º ' || v_transfer.number || ' anulado: vuelve al local', c.user_id
  from public.branch_transfer_items i where i.transfer_id = p_id and i.sent_qty > 0;

  update public.branch_transfers
  set status = 'cancelado', cancelled_by = c.user_id, cancelled_at = now(), cancel_reason = v_reason, updated_at = now()
  where id = p_id;

  if v_transfer.remito_id is not null then
    update public.remitos set status = 'anulado', voided_at = now(), voided_by = c.user_id
    where id = v_transfer.remito_id and status = 'emitido';
  end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, v_transfer.from_branch_id, c.user_id, 'branch_transfer.void', 'branch_transfer', p_id::text,
    jsonb_build_object('number', v_transfer.number, 'reason', v_reason, 'remito_id', v_transfer.remito_id));
end;
$$;

-- 7. Mínimo de stock de cada local (dueño/administrador) --------------------------------------------------------------
-- p_items: [{product_id, min_stock}]; null o 0 = sin mínimo propio (vale el general del producto).
create or replace function public.set_branch_min_stock(p_branch_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_item jsonb;
  v_pid uuid;
  v_min numeric;
  v_count integer := 0;
begin
  select * into c from public.transfers_caller();
  if c.role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador cambia los mínimos de cada local'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = c.company_id) then
    raise exception 'Local inválido';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Faltan los productos'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid := nullif(v_item->>'product_id', '')::uuid;
    v_min := nullif(v_item->>'min_stock', '')::numeric;
    if v_pid is null or not exists (select 1 from public.products where id = v_pid and company_id = c.company_id) then
      raise exception 'Producto inválido';
    end if;
    if v_min is not null and (v_min < 0 or v_min > 100000) then raise exception 'Mínimo inválido'; end if;
    if v_min is null or v_min = 0 then
      delete from public.branch_min_stock where branch_id = p_branch_id and product_id = v_pid;
    else
      insert into public.branch_min_stock (company_id, branch_id, product_id, min_stock, updated_by, updated_at)
      values (c.company_id, p_branch_id, v_pid, v_min, c.user_id, now())
      on conflict (branch_id, product_id) do update set min_stock = excluded.min_stock, updated_by = excluded.updated_by, updated_at = now();
    end if;
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, p_branch_id, c.user_id, 'branch_min_stock.set', 'branch', p_branch_id::text, jsonb_build_object('items', v_count));

  return v_count;
end;
$$;

revoke all on function public.request_branch_transfer(uuid, uuid, date, text, jsonb) from public, anon;
grant execute on function public.request_branch_transfer(uuid, uuid, date, text, jsonb) to authenticated;
revoke all on function public.prepare_branch_transfer(uuid, uuid, uuid, jsonb, text, text, text) from public, anon;
grant execute on function public.prepare_branch_transfer(uuid, uuid, uuid, jsonb, text, text, text) to authenticated;
revoke all on function public.dispatch_branch_transfer(uuid, uuid, uuid, jsonb, text, text, text, boolean, boolean, text) from public, anon;
grant execute on function public.dispatch_branch_transfer(uuid, uuid, uuid, jsonb, text, text, text, boolean, boolean, text) to authenticated;
revoke all on function public.receive_branch_transfer(uuid, jsonb, text, text) from public, anon;
grant execute on function public.receive_branch_transfer(uuid, jsonb, text, text) to authenticated;
revoke all on function public.cancel_branch_transfer(uuid, text) from public, anon;
grant execute on function public.cancel_branch_transfer(uuid, text) to authenticated;
revoke all on function public.void_branch_transfer(uuid, text) from public, anon;
grant execute on function public.void_branch_transfer(uuid, text) to authenticated;
revoke all on function public.set_branch_min_stock(uuid, jsonb) from public, anon;
grant execute on function public.set_branch_min_stock(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('190_branch_transfers') on conflict do nothing;
