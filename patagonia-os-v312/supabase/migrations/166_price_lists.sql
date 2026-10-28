-- 166: Listas de precios (mayorista). Un producto, un PLU, varios precios.
--
-- Pedido del dueño (28/10): clientes que venden el chorizo a minorista y a
-- mayorista no quieren 2 productos por cada cosa. Las "presentaciones" (111)
-- siguen para lo que es otro producto de verdad (pechito x 2 kg, cajón x15).
--
-- * price_lists: "Mayorista" con una regla: minorista ± % (base 'retail') o
--   costo + % (base 'cost'), redondeado a pesos enteros. El precio minorista
--   sigue siendo products.price_retail (la "lista" de siempre, no se guarda).
-- * product_list_prices: precio escrito a mano para un producto en una lista
--   (pisa la regla).
-- * Presentaciones (stock_source_id) sin precio a mano: la regla NO se les
--   aplica, se cobran a minorista (ya son ofertas).
-- * customers.price_list_id: el cliente compra siempre con esa lista.
--   create_customer_charge_with_items (Clientes y Venta en ruta) la usa sola.
-- * Mostrador: cada ítem puede traer price_list_id (botón Minorista/Mayorista).
--   create_pos_sale cobra ese precio. Se guarda en pos_sale_items.price_list_id
--   y list_discount (minorista − lo cobrado), así el control de la balanza
--   compara contra lo que imprimió la balanza y sigue dando bien.
--   Etiqueta con importe (scale_amount): se cobra importe × lista / minorista.
-- * Si una empresa no crea ninguna lista, no cambia nada.
-- * Las funciones de cobro se modifican inyectando en su definición viva
--   (igual que 104 y 118); si en una base no está la versión esperada, se avisa
--   y no se toca.

create table if not exists public.price_lists (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  base text not null default 'retail' check (base in ('retail', 'cost')),
  pct numeric(7,2) not null default 0 check (pct > -100 and pct < 1000),
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists price_lists_company_name on public.price_lists (company_id, lower(trim(name)));

create table if not exists public.product_list_prices (
  product_id uuid not null references public.products(id) on delete cascade,
  list_id uuid not null references public.price_lists(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  price numeric(14,2) not null check (price >= 0 and price < 1000000000),
  updated_at timestamptz not null default now(),
  primary key (product_id, list_id)
);
create index if not exists product_list_prices_list on public.product_list_prices (list_id);

alter table public.customers add column if not exists price_list_id uuid references public.price_lists(id) on delete set null;
alter table public.pos_sale_items add column if not exists price_list_id uuid references public.price_lists(id) on delete set null;
alter table public.pos_sale_items add column if not exists list_discount numeric(14,2) not null default 0;

alter table public.price_lists enable row level security;
alter table public.product_list_prices enable row level security;
-- Lectura de la empresa (el cajero necesita los nombres y los precios; no hay costo acá).
drop policy if exists price_lists_company_read on public.price_lists;
create policy price_lists_company_read on public.price_lists for select to authenticated using (company_id = (select public.current_company_id()));
drop policy if exists product_list_prices_company_read on public.product_list_prices;
create policy product_list_prices_company_read on public.product_list_prices for select to authenticated using (company_id = (select public.current_company_id()));
grant select on public.price_lists, public.product_list_prices to authenticated;

do $$
declare t text;
begin
  foreach t in array array['price_lists', 'product_list_prices'] loop
    execute format('drop trigger if exists zz_accountant_readonly on public.%I', t);
    execute format('create trigger zz_accountant_readonly before insert or update or delete on public.%I for each statement execute function public.accountant_readonly_guard()', t);
  end loop;
end $$;

-- Precio de un producto en una lista (interno: usa el costo).
create or replace function public.price_list_price(p_product public.products, p_list_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_list public.price_lists%rowtype;
  v_override numeric;
begin
  if p_list_id is null then
    return p_product.price_retail;
  end if;
  select price into v_override from public.product_list_prices where product_id = p_product.id and list_id = p_list_id;
  if v_override is not null then
    return v_override;
  end if;
  select * into v_list from public.price_lists where id = p_list_id;
  if not found or p_product.stock_source_id is not null then
    return p_product.price_retail;
  end if;
  if v_list.base = 'cost' then
    if coalesce(p_product.cost, 0) <= 0 then
      return p_product.price_retail;
    end if;
    return round(p_product.cost * (1 + v_list.pct / 100));
  end if;
  return round(p_product.price_retail * (1 + v_list.pct / 100));
end;
$$;
revoke all on function public.price_list_price(public.products, uuid) from public, anon, authenticated;

-- Lista pedida en un ítem de Mostrador: tiene que ser de la empresa del producto y estar activa.
create or replace function public.pos_item_list_id(p_product public.products, p_item jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(trim(coalesce(p_item->>'price_list_id', '')), '')::uuid;
begin
  if v_id is null then
    return null;
  end if;
  if not exists (select 1 from public.price_lists where id = v_id and company_id = p_product.company_id and active) then
    raise exception 'Lista de precios inválida: recargá la página (F5)';
  end if;
  return v_id;
end;
$$;
revoke all on function public.pos_item_list_id(public.products, jsonb) from public, anon, authenticated;

create or replace function public.pos_list_unit_price(p_product public.products, p_item jsonb)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.price_list_price(p_product, public.pos_item_list_id(p_product, p_item));
$$;
revoke all on function public.pos_list_unit_price(public.products, jsonb) from public, anon, authenticated;

-- Etiqueta con importe: la balanza cobró a minorista; con lista se cobra en proporción.
create or replace function public.pos_list_scale_amount(p_product public.products, p_item jsonb)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_amount numeric := (p_item->>'scale_amount')::numeric;
  v_list uuid := public.pos_item_list_id(p_product, p_item);
begin
  if v_list is null or coalesce(p_product.price_retail, 0) <= 0 then
    return v_amount;
  end if;
  return round(v_amount * public.price_list_price(p_product, v_list) / p_product.price_retail, 2);
end;
$$;
revoke all on function public.pos_list_scale_amount(public.products, jsonb) from public, anon, authenticated;

-- Lo que se resignó contra minorista en esa línea (para el control de balanza y los reportes).
create or replace function public.pos_list_discount(p_product public.products, p_item jsonb, p_quantity numeric)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if public.pos_item_list_id(p_product, p_item) is null then
    return 0;
  end if;
  if (p_item->>'scale_amount') is not null then
    return round((p_item->>'scale_amount')::numeric - public.pos_list_scale_amount(p_product, p_item), 2);
  end if;
  return round(p_quantity * p_product.price_retail - p_quantity * public.pos_list_unit_price(p_product, p_item), 2);
end;
$$;
revoke all on function public.pos_list_discount(public.products, jsonb, numeric) from public, anon, authenticated;

create or replace function public.customer_list_price(p_product public.products, p_customer_id uuid)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.price_list_price(
    p_product,
    (select c.price_list_id from public.customers c
       join public.price_lists l on l.id = c.price_list_id and l.active and l.company_id = p_product.company_id
     where c.id = p_customer_id)
  );
$$;
revoke all on function public.customer_list_price(public.products, uuid) from public, anon, authenticated;

-- Precio de cada producto en cada lista activa (la misma cuenta que price_list_price,
-- escrita acá porque la vista corre como su dueño). Filtra por empresa adentro (ver 031/050).
create or replace view public.product_list_prices_view as
select
  p.id as product_id,
  l.id as list_id,
  case
    when o.price is not null then o.price
    when p.stock_source_id is not null then p.price_retail
    when l.base = 'cost' and coalesce(p.cost, 0) > 0 then round(p.cost * (1 + l.pct / 100))
    when l.base = 'cost' then p.price_retail
    else round(p.price_retail * (1 + l.pct / 100))
  end as price,
  (o.price is not null) as manual
from public.products p
join public.price_lists l on l.company_id = p.company_id and l.active
left join public.product_list_prices o on o.product_id = p.id and o.list_id = l.id
where p.company_id = (select public.current_company_id());
grant select on public.product_list_prices_view to authenticated;

create or replace function public.price_list_caller()
returns public.profiles
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado';
  end if;
  select * into v_profile from public.profiles where id = auth.uid() and active = true;
  if not found then
    raise exception 'Perfil inválido';
  end if;
  if v_profile.role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o el administrador cambian las listas de precios';
  end if;
  return v_profile;
end;
$$;
revoke all on function public.price_list_caller() from public, anon, authenticated;

create or replace function public.save_price_list(p_id uuid, p_name text, p_base text, p_pct numeric, p_active boolean default true)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_profile public.profiles%rowtype;
  v_id uuid;
begin
  perform public.require_plan('full');
  v_profile := public.price_list_caller();
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Poné un nombre a la lista (ej. Mayorista)';
  end if;
  if lower(trim(p_name)) in ('minorista', 'precio minorista') then
    raise exception 'El minorista es el precio de siempre: no hace falta crearlo';
  end if;
  if p_base not in ('retail', 'cost') then
    raise exception 'Regla inválida';
  end if;
  if p_pct is null or p_pct <= -100 or p_pct >= 1000 then
    raise exception 'El porcentaje no es válido';
  end if;
  if p_base = 'cost' and p_pct < 0 then
    raise exception 'Sobre el costo el porcentaje tiene que ser positivo';
  end if;
  if exists (select 1 from public.price_lists where company_id = v_profile.company_id and lower(trim(name)) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'Ya hay una lista con ese nombre';
  end if;

  if p_id is null then
    insert into public.price_lists (company_id, name, base, pct, active)
    values (v_profile.company_id, trim(p_name), p_base, round(p_pct, 2), coalesce(p_active, true))
    returning id into v_id;
  else
    update public.price_lists
    set name = trim(p_name), base = p_base, pct = round(p_pct, 2), active = coalesce(p_active, true)
    where id = p_id and company_id = v_profile.company_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Lista inválida';
    end if;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, v_profile.id, 'price_list.save', 'price_list', v_id::text,
          jsonb_build_object('name', trim(p_name), 'base', p_base, 'pct', p_pct, 'active', p_active));
  return v_id;
end;
$$;
revoke all on function public.save_price_list(uuid, text, text, numeric, boolean) from public, anon;
grant execute on function public.save_price_list(uuid, text, text, numeric, boolean) to authenticated;

create or replace function public.delete_price_list(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_profile public.profiles%rowtype;
  v_name text;
begin
  v_profile := public.price_list_caller();
  select name into v_name from public.price_lists where id = p_id and company_id = v_profile.company_id for update;
  if v_name is null then
    raise exception 'Lista inválida';
  end if;
  -- Los clientes con esta lista vuelven a minorista (FK on delete set null); las ventas viejas la pierden.
  delete from public.price_lists where id = p_id;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, v_profile.id, 'price_list.delete', 'price_list', p_id::text, jsonb_build_object('name', v_name));
end;
$$;
revoke all on function public.delete_price_list(uuid) from public, anon;
grant execute on function public.delete_price_list(uuid) to authenticated;

-- [{product_id, list_id, price}] ; price null = vuelve a la regla de la lista.
create or replace function public.set_product_list_prices(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_item jsonb;
  v_product uuid;
  v_list uuid;
  v_price numeric;
  v_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'No autorizado para cambiar precios';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 3000 then
    raise exception 'Lista de precios inválida';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product := (v_item->>'product_id')::uuid;
    v_list := (v_item->>'list_id')::uuid;
    v_price := nullif(v_item->>'price', '')::numeric;
    if not exists (select 1 from public.products where id = v_product and company_id = v_company_id) then
      raise exception 'Producto inválido';
    end if;
    if not exists (select 1 from public.price_lists where id = v_list and company_id = v_company_id) then
      raise exception 'Lista inválida';
    end if;
    if v_price is null then
      delete from public.product_list_prices where product_id = v_product and list_id = v_list;
    else
      if v_price < 0 or v_price >= 1000000000 then
        raise exception 'Precio inválido';
      end if;
      insert into public.product_list_prices (product_id, list_id, company_id, price, updated_at)
      values (v_product, v_list, v_company_id, round(v_price, 2), now())
      on conflict (product_id, list_id) do update set price = excluded.price, updated_at = now();
    end if;
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'price_list.product_prices', 'price_list', null, jsonb_build_object('items', p_items));
  return v_count;
end;
$$;
revoke all on function public.set_product_list_prices(jsonb) from public, anon;
grant execute on function public.set_product_list_prices(jsonb) to authenticated;

create or replace function public.set_customer_price_list(p_customer_id uuid, p_list_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_profile public.profiles%rowtype;
begin
  v_profile := public.price_list_caller();
  if p_list_id is not null and not exists (select 1 from public.price_lists where id = p_list_id and company_id = v_profile.company_id and active) then
    raise exception 'Lista inválida';
  end if;
  update public.customers set price_list_id = p_list_id
  where id = p_customer_id and company_id = v_profile.company_id;
  if not found then
    raise exception 'Cliente inválido';
  end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_profile.company_id, v_profile.id, 'customer.price_list', 'customer', p_customer_id::text, jsonb_build_object('price_list_id', p_list_id));
end;
$$;
revoke all on function public.set_customer_price_list(uuid, uuid) from public, anon;
grant execute on function public.set_customer_price_list(uuid, uuid) to authenticated;

-- Botón "Mayorista" tocado a mano en Mostrador: si la empresa tiene PIN de anular, lo pide
-- (mismo PIN, mismos 5 intentos). Sin PIN configurado: ok.
create or replace function public.check_price_list_pin(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_matches boolean;
begin
  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  v_matches := public.pos_void_pin_matches(v_company_id, p_pin);
  if v_matches is null then
    return jsonb_build_object('ok', true);
  end if;
  -- Sin PIN escrito todavía: solo avisa que hace falta (no cuenta como intento fallido).
  if nullif(trim(coalesce(p_pin, '')), '') is null then
    return jsonb_build_object('ok', false, 'need_pin', true);
  end if;
  if public.pos_void_pin_locked(v_company_id) then
    return jsonb_build_object('ok', false, 'error', 'Demasiados intentos con el PIN equivocado. Esperá 15 minutos.');
  end if;
  if not v_matches then
    insert into public.pos_void_pin_failures (company_id, created_by) values (v_company_id, v_user_id);
    return jsonb_build_object('ok', false, 'error', 'PIN de autorización incorrecto.');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.check_price_list_pin(text) from public, anon;
grant execute on function public.check_price_list_pin(text) to authenticated;

-- Mostrador: precio de la lista pedida en cada ítem.
do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.create_pos_sale(uuid,jsonb,jsonb,uuid,numeric,numeric,uuid)');
  v_def text;
  v_new text;
  v_pairs text[][] := array[
    [$a$      v_line_total := (v_quantity * v_product.price_retail) - v_item_discount;$a$,
     $b$      v_line_total := (v_quantity * public.pos_list_unit_price(v_product, v_item)) - v_item_discount;$b$],
    [$a$        v_line_total := (v_item->>'scale_amount')::numeric - v_item_discount;$a$,
     $b$        v_line_total := public.pos_list_scale_amount(v_product, v_item) - v_item_discount;$b$],
    [$a$      v_unit_price := v_product.price_retail;$a$,
     $b$      v_unit_price := public.pos_list_unit_price(v_product, v_item);$b$],
    [$a$        v_unit_price := round((v_item->>'scale_amount')::numeric / v_quantity, 2);$a$,
     $b$        v_unit_price := round(public.pos_list_scale_amount(v_product, v_item) / v_quantity, 2);$b$],
    [$a$line_total, source, scale_tickets, scale_ticket)$a$,
     $b$line_total, source, scale_tickets, scale_ticket, price_list_id, list_discount)$b$],
    [$a$nullif(trim(v_item->>'scale_ticket'), ''));$a$,
     $b$nullif(trim(v_item->>'scale_ticket'), ''), public.pos_item_list_id(v_product, v_item), public.pos_list_discount(v_product, v_item, v_quantity));$b$]
  ];
  i int;
begin
  if v_proc is null then
    raise notice '166: no está create_pos_sale de 7 argumentos (staging viejo): Mostrador sigue sin listas';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position('pos_list_unit_price' in v_def) > 0 then
    raise notice '166: create_pos_sale ya tiene listas de precios';
    return;
  end if;
  v_new := v_def;
  for i in 1 .. array_length(v_pairs, 1) loop
    if position(v_pairs[i][1] in v_new) = 0 then
      raise exception '166: create_pos_sale no tiene el punto %: %', i, v_pairs[i][1];
    end if;
    v_new := replace(v_new, v_pairs[i][1], v_pairs[i][2]);
  end loop;
  execute v_new;
end
$mig$;

-- Clientes y Venta en ruta: la lista del cliente.
do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.create_customer_charge_with_items(uuid,uuid,date,jsonb,text,numeric)');
  v_def text;
  v_new text;
  v_a1 constant text := $a$      v_line_total := v_quantity * v_product.price_retail;$a$;
  v_b1 constant text := $b$      v_line_total := v_quantity * public.customer_list_price(v_product, p_customer_id);$b$;
  v_a2 constant text := $a$      v_unit_price := v_product.price_retail;$a$;
  v_b2 constant text := $b$      v_unit_price := public.customer_list_price(v_product, p_customer_id);$b$;
begin
  if v_proc is null then
    raise notice '166: no está create_customer_charge_with_items de 6 argumentos: Clientes sigue sin listas';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position('customer_list_price' in v_def) > 0 then
    raise notice '166: create_customer_charge_with_items ya tiene listas de precios';
    return;
  end if;
  if position(v_a1 in v_def) = 0 or position(v_a2 in v_def) = 0 then
    raise exception '166: create_customer_charge_with_items no tiene los puntos esperados';
  end if;
  v_new := replace(replace(v_def, v_a1, v_b1), v_a2, v_b2);
  execute v_new;
end
$mig$;

-- Control de la balanza: la balanza imprimió a minorista, así que se suma lo descontado por lista.
create or replace function public.scale_control_totals(p_shift_ids uuid[])
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with items as (
    select i.quantity, i.unit_price, coalesce(i.list_discount, 0) as list_discount,
           coalesce(i.scale_tickets, 1) as tickets, i.source, s.voided_at, pr.unit
    from public.pos_sale_items i
    join public.pos_sales s on s.id = i.sale_id
    left join public.products pr on pr.id = i.product_id
    where s.pos_shift_id = any(p_shift_ids) and i.source is not null
  )
  select jsonb_build_object(
    'system_amount', coalesce((select round(sum(quantity * unit_price + list_discount), 2) from items where voided_at is null), 0),
    'list_discount', coalesce((select round(sum(list_discount), 2) from items where voided_at is null), 0),
    'list_discount_tickets', coalesce((select sum(tickets) from items where voided_at is null and list_discount <> 0), 0),
    'system_kg', coalesce((select round(sum(quantity), 3) from items where voided_at is null and source = 'scale' and unit = 'kg'), 0),
    'system_tickets', coalesce((select sum(tickets) from items where voided_at is null), 0),
    'voided_amount',
      coalesce((select round(sum(amount), 2) from public.scale_ticket_voids where pos_shift_id = any(p_shift_ids)), 0)
      + coalesce((select round(sum(quantity * unit_price + list_discount), 2) from items where voided_at is not null), 0),
    'voided_kg',
      coalesce((select round(sum(weight_kg), 3) from public.scale_ticket_voids where pos_shift_id = any(p_shift_ids)), 0)
      + coalesce((select round(sum(quantity), 3) from items where voided_at is not null and source = 'scale' and unit = 'kg'), 0),
    'voided_tickets',
      coalesce((select count(*) from public.scale_ticket_voids where pos_shift_id = any(p_shift_ids)), 0)
      + coalesce((select sum(tickets) from items where voided_at is not null), 0)
  );
$function$;
revoke all on function public.scale_control_totals(uuid[]) from public, anon, authenticated;

insert into public.schema_migrations (version) values ('166_price_lists') on conflict do nothing;
