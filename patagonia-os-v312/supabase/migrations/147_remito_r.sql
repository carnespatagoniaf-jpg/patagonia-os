-- Remito R con CAI (2026-10-22, pedido del dueño: "dejalo armado para el plan
-- premium" = Full). No se conecta con ARCA en cada remito como la factura: el
-- comercio (su contador) pide en ARCA, como autoimpresor, un CAI para un punto
-- de venta y un rango de números con fecha de vencimiento, y lo carga en
-- Facturas. El sistema numera en orden, sin saltos ni repetidos, y arma el
-- remito (código 91, "documento no válido como factura") con el CAI.
--
--   remito_cai: CAI cargados (punto de venta, CAI de 14 dígitos, vencimiento,
--               desde/hasta). Solo dueño/admin, por save_remito_cai.
--   remitos:    remitos emitidos, con copia de los datos del emisor, del
--               destinatario y de los artículos tal como salieron (si después
--               cambia el cliente o el producto, el remito no cambia).
--               Uno por venta a cuenta (customer_charges); un anulado no libera
--               su número.
-- Plan Full: require_plan en cada función y política restrictiva en las tablas.

create table if not exists public.remito_cai (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  point_of_sale integer not null check (point_of_sale between 1 and 99999),
  cai text not null check (cai ~ '^[0-9]{14}$'),
  cai_due date not null,
  number_from integer not null check (number_from >= 1),
  number_to integer not null check (number_to <= 99999999),
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (number_to >= number_from)
);

create table if not exists public.remitos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid references public.branches(id),
  cai_id uuid not null references public.remito_cai(id),
  point_of_sale integer not null,
  number integer not null,
  cai text not null,
  cai_due date not null,
  issued_on date not null,
  customer_id uuid references public.customers(id),
  customer_charge_id uuid references public.customer_charges(id) on delete set null,
  issuer jsonb not null,
  receiver jsonb not null,
  items jsonb not null,
  show_values boolean not null default false,
  total numeric(14,2),
  delivery_address text,
  carrier text,
  notes text,
  status text not null default 'emitido' check (status in ('emitido', 'anulado')),
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, point_of_sale, number)
);

create unique index if not exists remitos_one_per_charge on public.remitos (customer_charge_id) where status = 'emitido' and customer_charge_id is not null;
create index if not exists remitos_company_created on public.remitos (company_id, created_at desc);
create index if not exists remito_cai_company on public.remito_cai (company_id, point_of_sale);

alter table public.remito_cai enable row level security;
alter table public.remitos enable row level security;

-- Lectura: toda la empresa (Clientes muestra el remito emitido); escritura solo por las funciones.
drop policy if exists remito_cai_company_read on public.remito_cai;
create policy remito_cai_company_read on public.remito_cai for select to authenticated using (company_id = public.current_company_id());
drop policy if exists remitos_company_read on public.remitos;
create policy remitos_company_read on public.remitos for select to authenticated using (company_id = public.current_company_id());

drop policy if exists plan_full on public.remito_cai;
create policy plan_full on public.remito_cai as restrictive for all to authenticated using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));
drop policy if exists plan_full on public.remitos;
create policy plan_full on public.remitos as restrictive for all to authenticated using (public.company_plan_allows('full')) with check (public.company_plan_allows('full'));

revoke all on public.remito_cai from anon;
revoke all on public.remitos from anon;
grant select on public.remito_cai, public.remitos to authenticated;

-- Cargar un CAI nuevo.
create or replace function public.save_remito_cai(p_point_of_sale integer, p_cai text, p_cai_due date, p_number_from integer, p_number_to integer)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_cai text := regexp_replace(coalesce(p_cai, ''), '\D', '', 'g');
  v_last integer;
  v_id uuid;
begin
  perform public.require_plan('full');

  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;

  if p_point_of_sale is null or p_point_of_sale < 1 or p_point_of_sale > 99999 then
    raise exception 'El punto de venta va de 1 a 99999';
  end if;
  if length(v_cai) <> 14 then
    raise exception 'El CAI tiene 14 números';
  end if;
  if p_cai_due is null or p_cai_due < public.today_ar() then
    raise exception 'La fecha de vencimiento del CAI ya pasó';
  end if;
  if p_number_from is null or p_number_to is null or p_number_from < 1 or p_number_to < p_number_from or p_number_to > 99999999 then
    raise exception 'Revisá los números: desde tiene que ser 1 o más y hasta, mayor o igual';
  end if;

  if exists (
    select 1 from public.remito_cai c
    where c.company_id = v_company_id and c.point_of_sale = p_point_of_sale and c.active
      and c.number_from <= p_number_to and c.number_to >= p_number_from
  ) then
    raise exception 'Esos números ya están en otro CAI del mismo punto de venta';
  end if;

  select max(number) into v_last from public.remitos where company_id = v_company_id and point_of_sale = p_point_of_sale;
  if v_last is not null and p_number_from <= v_last then
    raise exception 'En el punto de venta % ya se emitió hasta el remito %: el CAI nuevo tiene que empezar después', p_point_of_sale, v_last;
  end if;

  insert into public.remito_cai (company_id, point_of_sale, cai, cai_due, number_from, number_to, created_by)
  values (v_company_id, p_point_of_sale, v_cai, p_cai_due, p_number_from, p_number_to, v_user_id)
  returning id into v_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'remito_cai.create', 'remito_cai', v_id::text,
    jsonb_build_object('point_of_sale', p_point_of_sale, 'cai', v_cai, 'cai_due', p_cai_due, 'number_from', p_number_from, 'number_to', p_number_to));

  return v_id;
end;
$$;

-- Dar de baja un CAI cargado por error (si todavía no se usó) o volver a activarlo.
create or replace function public.set_remito_cai_active(p_cai_id uuid, p_active boolean)
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
  perform public.require_plan('full');

  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;

  update public.remito_cai set active = coalesce(p_active, false)
  where id = p_cai_id and company_id = v_company_id;
  if not found then raise exception 'CAI inválido'; end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'remito_cai.set_active', 'remito_cai', p_cai_id::text, jsonb_build_object('active', p_active));
end;
$$;

-- Emitir el Remito R de una venta a cuenta. Si ya tiene uno emitido, devuelve ese.
create or replace function public.issue_remito(p_charge_id uuid, p_delivery_address text default null, p_carrier text default null, p_notes text default null, p_show_values boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_charge record;
  v_fiscal record;
  v_cai record;
  v_next integer;
  v_items jsonb;
  v_id uuid;
  v_today date := public.today_ar();
begin
  perform public.require_plan('full');

  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;

  select cc.id, cc.charge_date, cc.amount, cc.customer_id, c.name, c.tax_id, c.tax_condition, c.locality, c.province, c.branch_id, c.number as customer_number
  into v_charge
  from public.customer_charges cc
  join public.customers c on c.id = cc.customer_id
  where cc.id = p_charge_id and cc.company_id = v_company_id
  for update of cc;
  if not found then raise exception 'Venta inválida'; end if;

  select id into v_id from public.remitos where customer_charge_id = p_charge_id and status = 'emitido';
  if v_id is not null then return v_id; end if;

  select jsonb_agg(jsonb_build_object(
      'description', coalesce(p.name, i.description),
      'code', p.code,
      'unit', p.unit,
      'quantity', i.quantity,
      'unit_price', i.unit_price,
      'line_total', i.line_total
    ) order by i.created_at)
  into v_items
  from public.customer_charge_items i
  left join public.products p on p.id = i.product_id
  where i.charge_id = p_charge_id;
  if v_items is null then
    raise exception 'Esta venta no tiene detalle de productos: el remito necesita saber qué mercadería sale';
  end if;

  select * into v_fiscal from public.company_fiscal_settings where company_id = v_company_id;
  if v_fiscal is null or nullif(trim(coalesce(v_fiscal.cuit, '')), '') is null or nullif(trim(coalesce(v_fiscal.business_name, '')), '') is null
     or nullif(trim(coalesce(v_fiscal.address, '')), '') is null then
    raise exception 'Faltan los datos fiscales del negocio (CUIT, razón social y domicilio): cargalos en Facturas';
  end if;

  -- El CAI vigente que vence primero y todavía tiene números. Se bloquea para que dos cajas no saquen el mismo número.
  for v_cai in
    select * from public.remito_cai
    where company_id = v_company_id and active and cai_due >= v_today
    order by cai_due, number_from
    for update
  loop
    select greatest(v_cai.number_from, coalesce(max(number), 0) + 1) into v_next
    from public.remitos where company_id = v_company_id and point_of_sale = v_cai.point_of_sale;
    if v_next <= v_cai.number_to then
      exit;
    end if;
    v_next := null;
  end loop;

  if v_next is null then
    raise exception 'No hay un CAI vigente con números libres: cargá uno nuevo en Facturas → Remito R';
  end if;

  insert into public.remitos (
    company_id, branch_id, cai_id, point_of_sale, number, cai, cai_due, issued_on,
    customer_id, customer_charge_id, issuer, receiver, items, show_values, total,
    delivery_address, carrier, notes, created_by
  ) values (
    v_company_id, v_charge.branch_id, v_cai.id, v_cai.point_of_sale, v_next, v_cai.cai, v_cai.cai_due, v_today,
    v_charge.customer_id, p_charge_id,
    jsonb_build_object(
      'business_name', v_fiscal.business_name, 'trade_name', v_fiscal.trade_name, 'cuit', v_fiscal.cuit,
      'tax_condition', v_fiscal.tax_condition, 'address', v_fiscal.address,
      'gross_income_number', v_fiscal.gross_income_number, 'activity_start', v_fiscal.activity_start),
    jsonb_build_object(
      'name', v_charge.name, 'number', v_charge.customer_number, 'tax_id', v_charge.tax_id, 'tax_condition', v_charge.tax_condition,
      'locality', v_charge.locality, 'province', v_charge.province),
    v_items, coalesce(p_show_values, false), v_charge.amount,
    nullif(trim(coalesce(p_delivery_address, '')), ''), nullif(trim(coalesce(p_carrier, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    v_user_id
  ) returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_charge.branch_id, v_user_id, 'remito.issue', 'remito', v_id::text,
    jsonb_build_object('point_of_sale', v_cai.point_of_sale, 'number', v_next, 'customer_charge_id', p_charge_id));

  return v_id;
end;
$$;

-- Anular un remito: queda guardado como anulado y su número no se vuelve a usar.
create or replace function public.void_remito(p_remito_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_remito record;
begin
  perform public.require_plan('full');

  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;

  select * into v_remito from public.remitos where id = p_remito_id and company_id = v_company_id for update;
  if not found then raise exception 'Remito inválido'; end if;
  if v_remito.status = 'anulado' then return; end if;

  update public.remitos set status = 'anulado', voided_at = now(), voided_by = v_user_id where id = p_remito_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_remito.branch_id, v_user_id, 'remito.void', 'remito', p_remito_id::text,
    jsonb_build_object('point_of_sale', v_remito.point_of_sale, 'number', v_remito.number));
end;
$$;

revoke all on function public.save_remito_cai(integer, text, date, integer, integer) from public, anon;
grant execute on function public.save_remito_cai(integer, text, date, integer, integer) to authenticated;
revoke all on function public.set_remito_cai_active(uuid, boolean) from public, anon;
grant execute on function public.set_remito_cai_active(uuid, boolean) to authenticated;
revoke all on function public.issue_remito(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.issue_remito(uuid, text, text, text, boolean) to authenticated;
revoke all on function public.void_remito(uuid) from public, anon;
grant execute on function public.void_remito(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('147_remito_r') on conflict do nothing;
