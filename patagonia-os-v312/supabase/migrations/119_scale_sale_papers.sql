-- 119: venta con balanza "artículos + TOTAL", para cualquier marca (arquitectura: docs/ARQUITECTURA_BALANZAS_VENTA.md).
--
-- SOLO STAGING hasta la autorización del dueño. No toca create_pos_sale ni ninguna tabla existente.
--
-- Por qué: la Systel Cuora Max no puede imprimir el N.º de ticket en ningún código (manual y protocolo,
-- función 8). Se escanea el código de cada artículo (producto + cantidad) y el del TOTAL (importe +
-- cantidad de artículos). El stock baja al cobrar, en la misma transacción.
--
-- 1. scale_profiles: formatos de código de la balanza (leídos de ella, solo lectura) por sucursal.
--    repeat_window_minutes = cuánto tiempo se considera "repetido" el mismo papel (1440 = todo el día).
-- 2. scale_catalog_items: catálogo de la balanza (nombre, forma de venta, precios de lista, código de
--    barras) + el VÍNCULO a un producto de Patagonia, decidido por el dueño o un administrador:
--    'product' (descuenta stock), 'libre' (se cobra el importe, sin stock) o 'none' (no se vende).
-- 3. pos_scale_paper_claims: cada papel cobrado (huella + día + N.º de vez). Se escribe en la MISMA
--    transacción que la venta.
--    - Mismo papel en otra caja al mismo tiempo: un candado por huella hace que la segunda espere y lo vea.
--    - Una venta anulada libera su papel.
-- 4. create_pos_scale_sale: valida en el servidor, en este orden:
--    a. el vínculo de cada artículo;
--    b. que cada papel sume EXACTO su TOTAL y tenga la cantidad de artículos;
--    c. que el papel no esté cobrado (salvo "es otro ticket igual", confirmado y registrado).
--    Después llama a create_pos_sale (stock, tesorería y auditoría como siempre) y guarda los papeles.
--    Con la misma clave de idempotencia devuelve la venta ya hecha (reintentos sin conexión).

create table if not exists public.scale_profiles (
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  scale_key text not null check (length(scale_key) between 1 and 60),
  brand text not null,
  model text,
  weighed_format text,
  unit_format text,
  total_format text,
  amount_decimals int not null default 0 check (amount_decimals between 0 and 3),
  generic_codes int[] not null default '{}',
  repeat_window_minutes int not null default 1440 check (repeat_window_minutes between 0 and 1440),
  read_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (company_id, branch_id, scale_key)
);

create table if not exists public.scale_catalog_items (
  company_id uuid not null,
  branch_id uuid not null,
  scale_key text not null,
  code int not null check (code > 0),
  name text not null,
  sale_type text not null check (sale_type in ('P', 'U', 'E', 'C')),
  prices numeric(14,2)[] not null default '{}',
  ean_type int,
  ean_config text,
  read_at timestamptz,
  link_kind text not null default 'none' check (link_kind in ('product', 'libre', 'none')),
  product_id uuid references public.products(id),
  linked_by uuid,
  linked_at timestamptz,
  primary key (company_id, branch_id, scale_key, code),
  foreign key (company_id, branch_id, scale_key) references public.scale_profiles (company_id, branch_id, scale_key) on delete cascade,
  check ((link_kind = 'product') = (product_id is not null))
);

create table if not exists public.pos_scale_paper_claims (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  scale_key text not null,
  sale_id uuid not null references public.pos_sales(id) on delete cascade,
  ticket_date date not null,
  fingerprint text not null,
  occurrence int not null check (occurrence >= 1),
  total numeric(14,2) not null,
  articles int,
  repeat_confirmed_by uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (company_id, branch_id, scale_key, ticket_date, fingerprint, occurrence)
);

create index if not exists pos_scale_paper_claims_sale_idx on public.pos_scale_paper_claims (sale_id);

alter table public.scale_profiles enable row level security;
alter table public.scale_catalog_items enable row level security;
alter table public.pos_scale_paper_claims enable row level security;

drop policy if exists scale_profiles_read on public.scale_profiles;
create policy scale_profiles_read on public.scale_profiles for select to authenticated using (company_id = public.current_company_id());
drop policy if exists scale_catalog_items_read on public.scale_catalog_items;
create policy scale_catalog_items_read on public.scale_catalog_items for select to authenticated using (company_id = public.current_company_id());
drop policy if exists pos_scale_paper_claims_read on public.pos_scale_paper_claims;
create policy pos_scale_paper_claims_read on public.pos_scale_paper_claims for select to authenticated using (company_id = public.current_company_id());

-- Catálogo leído de la balanza (solo lectura de la balanza). Conserva los vínculos ya decididos.
create or replace function public.save_scale_catalog(p_branch_id uuid, p_scale_key text, p_profile jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_role text;
  v_item jsonb;
  v_count int := 0;
  v_removed int := 0;
  v_codes int[] := '{}';
begin
  select company_id, role into v_company, v_role from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede guardar los productos de la balanza'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company and active = true) then raise exception 'Sucursal inválida'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'No hay productos de la balanza'; end if;

  insert into public.scale_profiles (company_id, branch_id, scale_key, brand, model, weighed_format, unit_format, total_format, amount_decimals, generic_codes, read_at, updated_by, updated_at)
  values (v_company, p_branch_id, p_scale_key, coalesce(p_profile->>'brand', 'desconocida'), p_profile->>'model', p_profile->>'weighed_format', p_profile->>'unit_format', p_profile->>'total_format',
          coalesce((p_profile->>'amount_decimals')::int, 0), coalesce(array(select jsonb_array_elements_text(p_profile->'generic_codes')::int), '{}'), now(), v_user, now())
  on conflict (company_id, branch_id, scale_key) do update set
    brand = excluded.brand, model = excluded.model, weighed_format = excluded.weighed_format, unit_format = excluded.unit_format,
    total_format = excluded.total_format, amount_decimals = excluded.amount_decimals, generic_codes = excluded.generic_codes,
    read_at = excluded.read_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.scale_catalog_items (company_id, branch_id, scale_key, code, name, sale_type, prices, ean_type, ean_config, read_at)
    values (v_company, p_branch_id, p_scale_key, (v_item->>'code')::int, v_item->>'name', v_item->>'sale_type',
            array(select jsonb_array_elements_text(v_item->'prices')::numeric), (v_item->>'ean_type')::int, v_item->>'ean_config', now())
    on conflict (company_id, branch_id, scale_key, code) do update set
      name = excluded.name, sale_type = excluded.sale_type, prices = excluded.prices, ean_type = excluded.ean_type, ean_config = excluded.ean_config, read_at = excluded.read_at,
      -- Si en la balanza cambió la forma de venta, el vínculo deja de valer: hay que volver a decidirlo.
      link_kind = case when scale_catalog_items.sale_type <> excluded.sale_type then 'none' else scale_catalog_items.link_kind end,
      product_id = case when scale_catalog_items.sale_type <> excluded.sale_type then null else scale_catalog_items.product_id end;
    v_codes := v_codes || (v_item->>'code')::int;
    v_count := v_count + 1;
  end loop;

  -- Los que ya no están en la balanza: se borran solo si no estaban vinculados (los vinculados quedan con su fecha vieja).
  with d as (
    delete from public.scale_catalog_items
    where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key and link_kind = 'none' and not (code = any (v_codes))
    returning 1
  ) select count(*) into v_removed from d;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, p_branch_id, v_user, 'scale_catalog.save', 'scale_profile', p_scale_key, jsonb_build_object('items', v_count, 'removed', v_removed, 'profile', p_profile));
  return jsonb_build_object('items', v_count, 'removed', v_removed);
end;
$$;

-- Vínculos producto de la balanza → producto de Patagonia (o venta libre, o no se vende).
create or replace function public.set_scale_links(p_branch_id uuid, p_scale_key text, p_links jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_role text;
  v_link jsonb;
  v_row public.scale_catalog_items%rowtype;
  v_product public.products%rowtype;
  v_kind text;
  v_count int := 0;
  v_changes jsonb := '[]';
begin
  select company_id, role into v_company, v_role from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede vincular productos de la balanza'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company and active = true) then raise exception 'Sucursal inválida'; end if;
  if p_links is null or jsonb_typeof(p_links) <> 'array' then raise exception 'Vínculos inválidos'; end if;

  for v_link in select * from jsonb_array_elements(p_links) loop
    select * into v_row from public.scale_catalog_items
    where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key and code = (v_link->>'code')::int
    for update;
    if not found then raise exception 'El producto % no está en los productos leídos de la balanza', v_link->>'code'; end if;
    v_kind := v_link->>'kind';
    if v_kind not in ('product', 'libre', 'none') then raise exception 'Tipo de vínculo inválido'; end if;
    if v_kind = 'product' then
      select * into v_product from public.products where id = (v_link->>'product_id')::uuid and company_id = v_company and active = true;
      if not found then raise exception 'Producto de Patagonia inválido para el % de la balanza', v_row.code; end if;
      if (v_row.sale_type in ('P', 'C', 'E')) <> (v_product.unit = 'kg') then
        raise exception '"%" se vende % en la balanza y "%" % en Patagonia', trim(v_row.name),
          case when v_row.sale_type = 'U' then 'por unidad' else 'por peso' end, v_product.name,
          case when v_product.unit = 'kg' then 'por kg' else 'por unidad' end;
      end if;
    end if;
    v_changes := v_changes || jsonb_build_object('code', v_row.code, 'before', jsonb_build_object('kind', v_row.link_kind, 'product_id', v_row.product_id),
      'after', jsonb_build_object('kind', v_kind, 'product_id', case when v_kind = 'product' then v_product.id end));
    update public.scale_catalog_items
    set link_kind = v_kind, product_id = case when v_kind = 'product' then v_product.id end, linked_by = v_user, linked_at = now()
    where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key and code = v_row.code;
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, p_branch_id, v_user, 'scale_links.set', 'scale_profile', p_scale_key, jsonb_build_object('changes', v_changes));
  return jsonb_build_object('updated', v_count);
end;
$$;

-- Venta de Mostrador con papeles de balanza (artículos + TOTAL).
-- p_papers: [{ fingerprint, ticket_date, total, articles, repeat_confirmed, items: [índices de p_items] }]
-- Cada ítem de un papel lleva "scale_code" (el código de la balanza que se escaneó, o null si es una venta libre sin código).
create or replace function public.create_pos_scale_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_pos_shift_id uuid,
  p_discount_amount numeric,
  p_surcharge_amount numeric,
  p_idempotency_key uuid,
  p_scale_key text,
  p_papers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_existing uuid;
  v_existing_total numeric(14,2);
  v_profile public.scale_profiles%rowtype;
  v_paper jsonb;
  v_idx jsonb;
  v_i int;
  v_item jsonb;
  v_used int[] := '{}';
  v_sum numeric(14,2);
  v_n int;
  v_link public.scale_catalog_items%rowtype;
  v_code int;
  v_date date;
  v_prev int;
  v_last timestamptz;
  v_sale jsonb;
  v_occ int;
begin
  select company_id into v_company from public.profiles where id = v_user and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;

  -- Reintento (sin conexión, doble clic): la venta ya está hecha, con sus papeles.
  if p_idempotency_key is not null then
    select id, total into v_existing, v_existing_total from public.pos_sales where company_id = v_company and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      return jsonb_build_object('sale_id', v_existing, 'total', v_existing_total);
    end if;
  end if;

  select * into v_profile from public.scale_profiles where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key;
  if not found then raise exception 'La balanza % no está configurada en esta sucursal', p_scale_key; end if;
  if p_papers is null or jsonb_typeof(p_papers) <> 'array' or jsonb_array_length(p_papers) = 0 then raise exception 'Faltan los tickets de la balanza'; end if;

  for v_paper in select * from jsonb_array_elements(p_papers) loop
    v_date := (v_paper->>'ticket_date')::date;
    if v_date is null or v_date < public.today_ar() - 2 or v_date > public.today_ar() + 1 then raise exception 'Fecha del ticket de balanza inválida'; end if;
    if coalesce(v_paper->>'fingerprint', '') = '' then raise exception 'Ticket de balanza sin huella'; end if;
    if jsonb_array_length(coalesce(v_paper->'items', '[]')) = 0 then raise exception 'Ticket de balanza sin artículos'; end if;
    v_sum := 0;
    v_n := 0;
    for v_idx in select * from jsonb_array_elements(v_paper->'items') loop
      v_i := (v_idx #>> '{}')::int;
      if v_i is null or v_i < 0 or v_i >= jsonb_array_length(p_items) or v_i = any (v_used) then raise exception 'Artículos del ticket de balanza inválidos'; end if;
      v_used := v_used || v_i;
      v_item := p_items->v_i;
      if coalesce((v_item->>'discount_amount')::numeric, 0) <> 0 then raise exception 'Un artículo de la balanza no puede tener descuento propio (el descuento va a la venta)'; end if;
      v_code := (v_item->>'scale_code')::int;
      if (v_item->>'product_id') is not null then
        if public.pos_item_source(v_item->>'source') is distinct from 'scale' or (v_item->>'scale_amount') is null or v_code is null then
          raise exception 'Artículo de balanza incompleto';
        end if;
        select * into v_link from public.scale_catalog_items
        where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key and code = v_code;
        if not found or v_link.link_kind <> 'product' or v_link.product_id <> (v_item->>'product_id')::uuid then
          raise exception 'El producto % de la balanza no está vinculado a ese producto de Patagonia', v_code;
        end if;
        v_sum := v_sum + (v_item->>'scale_amount')::numeric;
      else
        -- Venta libre: sin producto ni stock. Con código, tiene que ser un genérico o un vínculo "libre".
        if v_code is not null and not (v_code = any (v_profile.generic_codes)) and not exists (
          select 1 from public.scale_catalog_items where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key and code = v_code and link_kind = 'libre'
        ) then
          raise exception 'El producto % de la balanza no es una venta libre', v_code;
        end if;
        v_sum := v_sum + (v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric;
      end if;
      v_n := v_n + 1;
    end loop;
    if round(v_sum, 2) <> round((v_paper->>'total')::numeric, 2) then
      raise exception 'Los artículos del ticket de balanza suman % y el TOTAL es %', v_sum, v_paper->>'total';
    end if;
    if (v_paper->>'articles') is not null and (v_paper->>'articles')::int <> v_n then
      raise exception 'El ticket de balanza tiene % artículos y se cobraron %', v_paper->>'articles', v_n;
    end if;

    -- Mismo papel desde dos cajas a la vez: la segunda espera acá y después ve el de la primera.
    perform pg_advisory_xact_lock(hashtextextended(v_company::text || '|' || p_branch_id::text || '|' || p_scale_key || '|' || v_date::text || '|' || (v_paper->>'fingerprint'), 0));
    select count(*), max(c.created_at) into v_prev, v_last
    from public.pos_scale_paper_claims c join public.pos_sales s on s.id = c.sale_id
    where c.company_id = v_company and c.branch_id = p_branch_id and c.scale_key = p_scale_key and c.ticket_date = v_date
      and c.fingerprint = v_paper->>'fingerprint' and s.voided_at is null
      and c.created_at > now() - make_interval(mins => v_profile.repeat_window_minutes);
    if v_prev > 0 and coalesce((v_paper->>'repeat_confirmed')::boolean, false) is not true then
      raise exception 'TICKET_BALANZA_REPETIDO: ese mismo ticket ya se cobró hoy a las %', to_char(v_last at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI');
    end if;
  end loop;

  -- Todo artículo con source 'scale' tiene que estar en un papel.
  for v_i in 0 .. jsonb_array_length(p_items) - 1 loop
    if public.pos_item_source(p_items->v_i->>'source') = 'scale' and not (v_i = any (v_used)) then raise exception 'Hay un artículo de balanza fuera de su ticket'; end if;
  end loop;

  v_sale := public.create_pos_sale(p_branch_id, p_items, p_payments, p_pos_shift_id, p_discount_amount, p_surcharge_amount, p_idempotency_key);

  for v_paper in select * from jsonb_array_elements(p_papers) loop
    select coalesce(max(occurrence), 0) + 1 into v_occ from public.pos_scale_paper_claims
    where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key and ticket_date = (v_paper->>'ticket_date')::date and fingerprint = v_paper->>'fingerprint';
    insert into public.pos_scale_paper_claims (company_id, branch_id, scale_key, sale_id, ticket_date, fingerprint, occurrence, total, articles, repeat_confirmed_by, created_by)
    values (v_company, p_branch_id, p_scale_key, (v_sale->>'sale_id')::uuid, (v_paper->>'ticket_date')::date, v_paper->>'fingerprint', v_occ,
            (v_paper->>'total')::numeric, (v_paper->>'articles')::int, case when v_occ > 1 and (v_paper->>'repeat_confirmed')::boolean then v_user end, v_user);
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company, p_branch_id, v_user, 'pos_scale_sale.create', 'pos_sale', v_sale->>'sale_id', jsonb_build_object('scale_key', p_scale_key, 'papers', p_papers));
  return v_sale;
end;
$$;

revoke all on function public.save_scale_catalog(uuid, text, jsonb, jsonb) from public, anon;
revoke all on function public.set_scale_links(uuid, text, jsonb) from public, anon;
revoke all on function public.create_pos_scale_sale(uuid, jsonb, jsonb, uuid, numeric, numeric, uuid, text, jsonb) from public, anon;
grant execute on function public.save_scale_catalog(uuid, text, jsonb, jsonb) to authenticated;
grant execute on function public.set_scale_links(uuid, text, jsonb) to authenticated;
grant execute on function public.create_pos_scale_sale(uuid, jsonb, jsonb, uuid, numeric, numeric, uuid, text, jsonb) to authenticated;

insert into public.schema_migrations (version) values ('119_scale_sale_papers') on conflict do nothing;
