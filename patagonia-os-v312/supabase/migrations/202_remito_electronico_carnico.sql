-- Remito Electrónico Cárnico de ARCA (web service wsremcarne), 2026-11-17.
-- Pedido del dueño para Della Finca (CARNES BOTS S.A.): emitir el remito oficial
-- desde el sistema, con la autorización de ARCA, sin cargar un CAI a mano.
--
-- NO reemplaza al Remito R con CAI (migración 147): son regímenes distintos.
--   - Remito cárnico (este): carnes y subproductos de la faena de BOVINOS y
--     PORCINOS (tablas 1 a 13 del manual de ARCA). Cada remito se pide a ARCA y
--     ARCA devuelve número, código de autorización, vencimiento y QR.
--   - Remito R con CAI: el resto de la mercadería (pollo, almacén, etc.).
-- Todo lo de ARCA lo hace la Edge Function `arca-remito` (con la clave del
-- servicio); estas tablas no tienen políticas de escritura y la web solo crea el
-- borrador por create_rec_remito. Separado de las facturas: tablas propias,
-- ticket del WSAA propio (servicio "wsremcarne" en arca_access_tickets).
--
--   rec_settings     categoría del emisor elegida + datos que ARCA devolvió en
--                    "Probar conexión" (categorías, estados, tipos de carne).
--   rec_points       puntos de emisión dados de alta en ARCA para el sistema
--                    "Remito Electrónico Web Services" (cada uno = un domicilio).
--   rec_remitos      cada remito: borrador → ARCA. id_req = el número nuestro que
--                    ARCA usa para no generar dos veces el mismo remito.
--   rec_remito_items renglones (código de mercadería de ARCA, tropa, kilos, unidades).
--   rec_arca_calls   cada pedido y respuesta a ARCA (sin token ni firma).
--   rec_product_codes último código de ARCA usado por producto, para sugerirlo.
-- Plan Full (como el Remito R): require_plan en las funciones y política restrictiva.

create table if not exists public.rec_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  categoria_emisor smallint,
  categoria_emisor_desc text,
  enabled boolean not null default false,
  catalog jsonb not null default '{}'::jsonb,
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_message text,
  updated_at timestamptz not null default now()
);

create table if not exists public.rec_points (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  point_of_emission integer not null check (point_of_emission between 1 and 99999),
  branch_id uuid references public.branches(id),
  label text,
  active boolean not null default true,
  arca_description text,
  created_at timestamptz not null default now(),
  unique (company_id, point_of_emission)
);

create table if not exists public.rec_remitos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid references public.branches(id),
  client_id uuid not null,
  point_of_emission integer not null,
  id_req bigint not null check (id_req between 1 and 999999999999999),
  tipo_movimiento text not null check (tipo_movimiento in ('ENV', 'REP', 'PLA')),
  categoria_emisor smallint,
  cuit_emisor text not null,
  tipo_receptor text check (tipo_receptor in ('MI', 'EM')),
  categoria_receptor smallint,
  cuit_receptor text,
  receptor_name text,
  cod_dom_destino integer,
  destino_desc text,
  destination_branch_id uuid references public.branches(id),
  customer_id uuid references public.customers(id),
  branch_transfer_id uuid references public.branch_transfers(id) on delete set null,
  motivo text,
  cuit_transportista text,
  transportista_name text,
  cuit_conductor text,
  fecha_inicio_viaje date,
  distancia_km numeric(10,2),
  dominio_vehiculo text,
  dominio_acoplado text,
  issuer jsonb not null,
  -- 'pendiente'  todavía no se mandó (o se puede volver a mandar con el mismo id_req)
  -- 'incierto'   se mandó y no llegó la respuesta: antes de reintentar se consulta a ARCA
  -- 'generado'   ARCA lo tiene pero sin emitir (falta autorizar o emitir)
  -- 'emitido'    tiene número y código de autorización
  -- 'rechazado'  ARCA no lo aceptó (se puede corregir en uno nuevo)
  -- 'anulado'    anulado en ARCA antes de emitirse
  -- 'descartado' borrador que nunca llegó a ARCA, tirado por el usuario
  status text not null default 'pendiente'
    check (status in ('pendiente', 'incierto', 'generado', 'emitido', 'rechazado', 'anulado', 'descartado')),
  arca_estado text,
  cod_remito bigint,
  nro_remito integer,
  cod_autorizacion text,
  fecha_emision date,
  fecha_vencimiento date,
  qr_base64 text,
  observations jsonb,
  error_message text,
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  emitted_at timestamptz,
  env text,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, point_of_emission, id_req),
  unique (company_id, client_id)
);

create unique index if not exists rec_remitos_number on public.rec_remitos (company_id, point_of_emission, nro_remito) where nro_remito is not null;
create index if not exists rec_remitos_company_created on public.rec_remitos (company_id, created_at desc);
create index if not exists rec_remitos_open on public.rec_remitos (company_id, status) where status in ('pendiente', 'incierto', 'generado');

create table if not exists public.rec_remito_items (
  id uuid primary key default gen_random_uuid(),
  remito_id uuid not null references public.rec_remitos(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  orden integer not null check (orden between 1 and 9999),
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  cod_tipo_prod text not null check (cod_tipo_prod ~ '^[0-9]{1,2}\.[0-9]{1,3}$'),
  tropa bigint check (tropa between 1 and 9999999999),
  kilos numeric(8,2) check (kilos between 0 and 999999.99),
  unidades numeric(8,2) check (unidades between 0 and 999999.99),
  unique (remito_id, orden)
);

create table if not exists public.rec_arca_calls (
  id bigserial primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  remito_id uuid references public.rec_remitos(id) on delete set null,
  env text not null,
  method text not null,
  request_xml text,
  response_xml text,
  http_status integer,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists rec_arca_calls_remito on public.rec_arca_calls (remito_id, created_at);

create table if not exists public.rec_product_codes (
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  cod_tipo_prod text not null check (cod_tipo_prod ~ '^[0-9]{1,2}\.[0-9]{1,3}$'),
  updated_at timestamptz not null default now(),
  primary key (company_id, product_id)
);

alter table public.rec_settings enable row level security;
alter table public.rec_points enable row level security;
alter table public.rec_remitos enable row level security;
alter table public.rec_remito_items enable row level security;
alter table public.rec_arca_calls enable row level security;
alter table public.rec_product_codes enable row level security;

-- Lectura: la empresa. El registro de pedidos a ARCA, solo dueño/administrador.
drop policy if exists rec_settings_company_read on public.rec_settings;
create policy rec_settings_company_read on public.rec_settings for select to authenticated using (company_id = public.current_company_id());
drop policy if exists rec_points_company_read on public.rec_points;
create policy rec_points_company_read on public.rec_points for select to authenticated using (company_id = public.current_company_id());
drop policy if exists rec_remitos_company_read on public.rec_remitos;
create policy rec_remitos_company_read on public.rec_remitos for select to authenticated using (company_id = public.current_company_id());
drop policy if exists rec_remito_items_company_read on public.rec_remito_items;
create policy rec_remito_items_company_read on public.rec_remito_items for select to authenticated using (company_id = public.current_company_id());
drop policy if exists rec_product_codes_company_read on public.rec_product_codes;
create policy rec_product_codes_company_read on public.rec_product_codes for select to authenticated using (company_id = public.current_company_id());
drop policy if exists rec_arca_calls_admin_read on public.rec_arca_calls;
create policy rec_arca_calls_admin_read on public.rec_arca_calls for select to authenticated using (
  company_id = public.current_company_id()
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role in ('owner', 'admin'))
);

do $$
declare t text;
begin
  foreach t in array array['rec_settings', 'rec_points', 'rec_remitos', 'rec_remito_items', 'rec_arca_calls', 'rec_product_codes'] loop
    execute format('drop policy if exists plan_full on public.%I', t);
    execute format('create policy plan_full on public.%I as restrictive for all to authenticated using (public.company_plan_allows(''full'')) with check (public.company_plan_allows(''full''))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists zz_accountant_readonly on public.%I', t);
    execute format('create trigger zz_accountant_readonly before insert or update or delete on public.%I for each statement execute function public.accountant_readonly_guard()', t);
  end loop;
end;
$$;
revoke all on sequence public.rec_arca_calls_id_seq from anon, authenticated;

-- Dueño/administrador: categoría del emisor (de la lista que devuelve ARCA en "Probar conexión").
create or replace function public.save_rec_settings(p_categoria_emisor smallint, p_categoria_emisor_desc text default null)
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
  if p_categoria_emisor is not null and p_categoria_emisor < 0 then raise exception 'Categoría inválida'; end if;

  insert into public.rec_settings (company_id, categoria_emisor, categoria_emisor_desc, updated_at)
  values (v_company_id, p_categoria_emisor, nullif(trim(coalesce(p_categoria_emisor_desc, '')), ''), now())
  on conflict (company_id) do update
    set categoria_emisor = excluded.categoria_emisor, categoria_emisor_desc = excluded.categoria_emisor_desc, updated_at = now();

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'rec.settings', 'company', v_company_id::text, jsonb_build_object('categoria_emisor', p_categoria_emisor));
end;
$$;

-- Dueño/administrador: punto de emisión (el número que dio ARCA) y de qué local sale.
create or replace function public.save_rec_point(p_point integer, p_branch_id uuid default null, p_label text default null, p_active boolean default true)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_id uuid;
begin
  perform public.require_plan('full');
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;
  if p_point is null or p_point < 1 or p_point > 99999 then raise exception 'El punto de emisión va de 1 a 99999'; end if;
  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Local inválido';
  end if;

  insert into public.rec_points (company_id, point_of_emission, branch_id, label, active)
  values (v_company_id, p_point, p_branch_id, nullif(trim(coalesce(p_label, '')), ''), coalesce(p_active, true))
  on conflict (company_id, point_of_emission) do update
    set branch_id = excluded.branch_id, label = excluded.label, active = excluded.active
  returning id into v_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'rec.point', 'rec_point', v_id::text, jsonb_build_object('point', p_point, 'branch_id', p_branch_id, 'active', p_active));
  return v_id;
end;
$$;

-- Crear el remito (borrador). No habla con ARCA: después la web llama a la Edge
-- Function para mandarlo. p_client_id lo genera la web una vez por formulario: un
-- doble clic o un reintento devuelve el mismo remito, nunca dos.
create or replace function public.create_rec_remito(p_client_id uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_settings record;
  v_fiscal record;
  v_point record;
  v_id uuid;
  v_id_req bigint;
  v_today date := public.today_ar();
  v_mov text := upper(coalesce(p_data->>'tipo_movimiento', ''));
  v_tipo_rec text := nullif(upper(coalesce(p_data->>'tipo_receptor', '')), '');
  v_cuit_rec text := nullif(regexp_replace(coalesce(p_data->>'cuit_receptor', ''), '\D', '', 'g'), '');
  v_cuit_tra text := nullif(regexp_replace(coalesce(p_data->>'cuit_transportista', ''), '\D', '', 'g'), '');
  v_cuit_con text := nullif(regexp_replace(coalesce(p_data->>'cuit_conductor', ''), '\D', '', 'g'), '');
  v_fecha date := nullif(p_data->>'fecha_inicio_viaje', '')::date;
  v_km numeric := nullif(p_data->>'distancia_km', '')::numeric;
  v_dominio text := nullif(upper(regexp_replace(coalesce(p_data->>'dominio_vehiculo', ''), '\s', '', 'g')), '');
  v_dom_dest integer := nullif(p_data->>'cod_dom_destino', '')::integer;
  v_cat_rec smallint := nullif(p_data->>'categoria_receptor', '')::smallint;
  v_item jsonb;
  v_orden integer := 0;
  v_code text;
  v_product uuid;
begin
  perform public.require_plan('full');
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin', 'manager', 'production') then raise exception 'No tenés permiso para emitir remitos'; end if;
  if p_client_id is null then raise exception 'Falta el identificador del pedido'; end if;

  -- Doble clic / reintento: el mismo formulario devuelve el mismo remito.
  select id into v_id from public.rec_remitos where company_id = v_company_id and client_id = p_client_id;
  if v_id is not null then return v_id; end if;

  select * into v_settings from public.rec_settings where company_id = v_company_id;
  if v_settings is null or not v_settings.enabled then
    raise exception 'El remito electrónico cárnico no está conectado con ARCA: probá la conexión en Facturas';
  end if;
  select * into v_fiscal from public.company_fiscal_settings where company_id = v_company_id;
  if v_fiscal is null then raise exception 'Faltan los datos fiscales del negocio'; end if;

  select * into v_point from public.rec_points
  where company_id = v_company_id and point_of_emission = nullif(p_data->>'point_of_emission', '')::integer and active;
  if v_point is null then raise exception 'Elegí un punto de emisión activo'; end if;
  if v_point.branch_id is not null and not public.my_branch_allowed(v_point.branch_id) then
    raise exception 'No podés emitir desde ese local';
  end if;

  -- Reglas del manual de ARCA (2.5.2.4) que se pueden revisar acá. ARCA vuelve a validar todo.
  if v_mov not in ('ENV', 'REP', 'PLA') then raise exception 'Tipo de movimiento inválido'; end if;
  if v_settings.categoria_emisor is null then raise exception 'Falta la categoría del emisor (Facturas → Remito electrónico cárnico)'; end if;
  if v_mov = 'REP' then
    if v_tipo_rec is not null or v_cuit_rec is not null or v_dom_dest is not null or v_cat_rec is not null then
      raise exception 'En un reparto no se informa destinatario ni domicilio de destino';
    end if;
  else
    if v_tipo_rec not in ('MI', 'EM') then raise exception 'Elegí si va a otro depósito propio o a un cliente'; end if;
    if v_cuit_rec is null or not public.is_valid_cuit(v_cuit_rec) then raise exception 'El CUIT del destinatario no es válido'; end if;
    if v_tipo_rec = 'MI' and v_cat_rec is null then raise exception 'Falta la categoría del destinatario'; end if;
    if v_mov = 'ENV' and v_dom_dest is null then raise exception 'Falta el domicilio de destino'; end if;
  end if;
  if v_fecha is null or v_fecha < v_today then raise exception 'La fecha de inicio del viaje no puede ser anterior a hoy'; end if;
  if v_km is null or v_km <= 0 or v_km > 99999 then raise exception 'Falta la distancia en km'; end if;
  if v_cuit_tra is null or not public.is_valid_cuit(v_cuit_tra) then raise exception 'El CUIT del transportista no es válido'; end if;
  if v_cuit_con is not null and not public.is_valid_cuit(v_cuit_con) then raise exception 'El CUIT/CUIL del conductor no es válido'; end if;
  if v_dominio is null then raise exception 'Falta la patente del vehículo'; end if;
  if jsonb_typeof(p_data->'items') <> 'array' or jsonb_array_length(p_data->'items') = 0 then raise exception 'Agregá al menos un producto'; end if;
  if jsonb_array_length(p_data->'items') > 9999 then raise exception 'Demasiados renglones'; end if;

  -- Número del pedido (idReq), único por punto de emisión: AAAAMMDD + 5 cifras, así no
  -- choca con otro sistema que haya numerado desde 1 en el mismo punto.
  perform pg_advisory_xact_lock(hashtext('rec_id_req:' || v_company_id::text || ':' || v_point.point_of_emission::text));
  select coalesce(max(id_req), 0) into v_id_req from public.rec_remitos
  where company_id = v_company_id and point_of_emission = v_point.point_of_emission
    and id_req >= to_char(v_today, 'YYYYMMDD')::bigint * 100000;
  v_id_req := greatest(v_id_req + 1, to_char(v_today, 'YYYYMMDD')::bigint * 100000 + 1);

  insert into public.rec_remitos (
    company_id, branch_id, client_id, point_of_emission, id_req, tipo_movimiento, categoria_emisor, cuit_emisor,
    tipo_receptor, categoria_receptor, cuit_receptor, receptor_name, cod_dom_destino, destino_desc,
    destination_branch_id, customer_id, branch_transfer_id, motivo,
    cuit_transportista, transportista_name, cuit_conductor, fecha_inicio_viaje, distancia_km, dominio_vehiculo, dominio_acoplado,
    issuer, notes, created_by
  ) values (
    v_company_id, v_point.branch_id, p_client_id, v_point.point_of_emission, v_id_req, v_mov, v_settings.categoria_emisor, v_fiscal.cuit,
    case when v_mov = 'REP' then null else v_tipo_rec end, v_cat_rec, v_cuit_rec,
    nullif(trim(coalesce(p_data->>'receptor_name', '')), ''), v_dom_dest, nullif(trim(coalesce(p_data->>'destino_desc', '')), ''),
    (select id from public.branches where id = nullif(p_data->>'destination_branch_id', '')::uuid and company_id = v_company_id),
    (select id from public.customers where id = nullif(p_data->>'customer_id', '')::uuid and company_id = v_company_id),
    (select id from public.branch_transfers where id = nullif(p_data->>'branch_transfer_id', '')::uuid and company_id = v_company_id),
    nullif(trim(coalesce(p_data->>'motivo', '')), ''),
    v_cuit_tra, nullif(trim(coalesce(p_data->>'transportista_name', '')), ''), v_cuit_con, v_fecha, round(v_km, 2), v_dominio,
    nullif(upper(regexp_replace(coalesce(p_data->>'dominio_acoplado', ''), '\s', '', 'g')), ''),
    jsonb_build_object('business_name', v_fiscal.business_name, 'cuit', v_fiscal.cuit, 'address', v_fiscal.address,
      'point_label', v_point.label, 'point_description', v_point.arca_description, 'categoria_emisor_desc', v_settings.categoria_emisor_desc),
    nullif(trim(coalesce(p_data->>'notes', '')), ''), v_user_id
  ) returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_data->'items') loop
    v_orden := v_orden + 1;
    v_code := trim(coalesce(v_item->>'cod_tipo_prod', ''));
    if v_code !~ '^[0-9]{1,2}\.[0-9]{1,3}$' then
      raise exception 'Renglón %: el código de mercadería de ARCA tiene la forma tabla.item (por ejemplo 6.24)', v_orden;
    end if;
    if coalesce((v_item->>'kilos')::numeric, 0) <= 0 and coalesce((v_item->>'unidades')::numeric, 0) <= 0 then
      raise exception 'Renglón %: indicá kilos o unidades', v_orden;
    end if;
    v_product := (select id from public.products where id = nullif(v_item->>'product_id', '')::uuid and company_id = v_company_id);
    insert into public.rec_remito_items (remito_id, company_id, orden, product_id, product_name, cod_tipo_prod, tropa, kilos, unidades)
    values (v_id, v_company_id, v_orden, v_product, nullif(trim(coalesce(v_item->>'product_name', '')), ''), v_code,
      nullif(v_item->>'tropa', '')::bigint, round(nullif(v_item->>'kilos', '')::numeric, 2), round(nullif(v_item->>'unidades', '')::numeric, 2));
    if v_product is not null then
      insert into public.rec_product_codes (company_id, product_id, cod_tipo_prod, updated_at)
      values (v_company_id, v_product, v_code, now())
      on conflict (company_id, product_id) do update set cod_tipo_prod = excluded.cod_tipo_prod, updated_at = now();
    end if;
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_point.branch_id, v_user_id, 'rec.create', 'rec_remito', v_id::text,
    jsonb_build_object('point', v_point.point_of_emission, 'id_req', v_id_req, 'movimiento', v_mov, 'cuit_receptor', v_cuit_rec, 'items', v_orden));
  return v_id;
end;
$$;

-- Tirar un borrador que nunca llegó a ARCA, o uno rechazado. Lo que ARCA ya tiene
-- (generado/incierto/emitido) no se puede tirar desde acá.
create or replace function public.discard_rec_remito(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_row record;
begin
  perform public.require_plan('full');
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin', 'manager', 'production') then raise exception 'No tenés permiso'; end if;

  select * into v_row from public.rec_remitos where id = p_id and company_id = v_company_id for update;
  if v_row is null then raise exception 'Remito inválido'; end if;
  if not (v_row.status = 'rechazado' or (v_row.status = 'pendiente' and v_row.attempts = 0 and v_row.sent_at is null)) then
    raise exception 'Ese remito ya pasó por ARCA: no se puede tirar (consultalo o anulalo)';
  end if;
  if v_row.claimed_at is not null and v_row.claimed_at > now() - interval '5 minutes' then
    raise exception 'Se está mandando a ARCA en este momento';
  end if;

  update public.rec_remitos set status = 'descartado' where id = p_id;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'rec.discard', 'rec_remito', p_id::text, jsonb_build_object('status_before', v_row.status, 'id_req', v_row.id_req));
end;
$$;

revoke all on function public.save_rec_settings(smallint, text) from public, anon;
revoke all on function public.save_rec_point(integer, uuid, text, boolean) from public, anon;
revoke all on function public.create_rec_remito(uuid, jsonb) from public, anon;
revoke all on function public.discard_rec_remito(uuid) from public, anon;
grant execute on function public.save_rec_settings(smallint, text) to authenticated;
grant execute on function public.save_rec_point(integer, uuid, text, boolean) to authenticated;
grant execute on function public.create_rec_remito(uuid, jsonb) to authenticated;
grant execute on function public.discard_rec_remito(uuid) to authenticated;

insert into public.schema_migrations (version) values ('202_remito_electronico_carnico') on conflict do nothing;
