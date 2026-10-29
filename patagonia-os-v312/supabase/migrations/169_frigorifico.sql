-- Frigorífico (a pedido, 2026-10-27): stock de medias reses por tropa, garrón
-- y kilo. Solo lo ve una empresa con 'frigorifico' en companies.features
-- (igual que 'cuentas' y 'gastos', migración 143). Se activa desde el panel de
-- plataforma: tarjeta del cliente → "Pantallas a pedido" → Frigorífico
-- (set_company_feature, punto 11 de abajo).
--
-- Ciclo:
--   1) DT de carga (frigo_dts): qué y cuántos animales se van a faenar.
--   2) Faena (frigo_slaughter): cada animal son 2 medias; a cada media se le
--      da tropa, garrón (correlativo desde 1 en cada día de faena: 300
--      animales = 600 garrones), kilos y la cámara donde entra.
--   3) Cámaras (frigo_camaras): el stock son las medias sin salida.
--   4) Salida (frigo_create_salida), con tropa, garrón y kilo de cada media:
--      - 'cliente': venta; crea una entrega en la cuenta corriente del cliente
--        (customer_charges + un ítem por media), así la deuda y los pagos se
--        manejan en Clientes como siempre.
--      - 'sucursal': envío a una carnicería propia (ciclo 2): suma los kilos
--        al stock de un producto en esa sucursal (inventory_movements).
--   Anular una salida (frigo_void_salida) devuelve las medias a su cámara y
--   saca la entrega del cliente o los kilos de la sucursal.
--
-- Las tablas se leen directo (RLS por empresa + que tenga la pantalla); no
-- tienen políticas de escritura: todo pasa por las funciones de abajo.

-- 1) Tablas ---------------------------------------------------------------

create table if not exists public.frigo_camaras (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  number integer not null check (number > 0),
  name text not null,
  capacity integer check (capacity is null or capacity > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, number)
);

create table if not exists public.frigo_dts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  dt_number text not null,
  dt_date date not null,
  producer text not null,
  renspa text,
  origin text,
  category text not null,
  heads integer not null check (heads between 1 and 2000),
  tropa integer check (tropa is null or tropa > 0),
  slaughter_date date,
  status text not null default 'pendiente' check (status in ('pendiente', 'faenado')),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists frigo_dts_tropa_uq on public.frigo_dts (company_id, tropa) where tropa is not null;

create table if not exists public.frigo_salidas (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  number integer not null,
  salida_date date not null,
  kind text not null check (kind in ('cliente', 'sucursal')),
  customer_id uuid references public.customers(id),
  dest_branch_id uuid references public.branches(id),
  product_id uuid references public.products(id),
  price_per_kg numeric(14,2),
  total_kg numeric(14,1) not null,
  total numeric(14,2) not null default 0,
  customer_charge_id uuid references public.customer_charges(id),
  notes text,
  voided_at timestamptz,
  voided_reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, number),
  check (
    (kind = 'cliente' and customer_id is not null)
    or (kind = 'sucursal' and dest_branch_id is not null and product_id is not null)
  )
);

create table if not exists public.frigo_medias (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  dt_id uuid not null references public.frigo_dts(id),
  tropa integer not null,
  garron integer not null check (garron > 0),
  slaughter_date date not null,
  animal integer not null check (animal > 0),
  side smallint not null check (side in (1, 2)),
  kg numeric(10,1) not null check (kg > 0),
  camara_id uuid not null references public.frigo_camaras(id),
  salida_id uuid references public.frigo_salidas(id),
  created_at timestamptz not null default now(),
  unique (company_id, slaughter_date, garron)
);
create index if not exists frigo_medias_stock_idx on public.frigo_medias (company_id, camara_id) where salida_id is null;
create index if not exists frigo_medias_tropa_idx on public.frigo_medias (company_id, tropa);
create index if not exists frigo_medias_salida_idx on public.frigo_medias (salida_id) where salida_id is not null;

-- 2) Lectura: la empresa del usuario y solo si tiene la pantalla ------------

create or replace function public.frigo_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.companies
    where id = public.current_company_id() and 'frigorifico' = any(features)
  );
$$;
revoke all on function public.frigo_enabled() from public, anon;
grant execute on function public.frigo_enabled() to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['frigo_camaras', 'frigo_dts', 'frigo_salidas', 'frigo_medias'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_company_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (company_id = public.current_company_id())', t || '_company_read', t);
    execute format('drop policy if exists frigo_feature on public.%I', t);
    execute format('create policy frigo_feature on public.%I as restrictive for all to authenticated using (public.frigo_enabled()) with check (public.frigo_enabled())', t);
    -- El Contador no escribe nada (migración 155): toda tabla nueva lleva este trigger.
    execute format('drop trigger if exists zz_accountant_readonly on public.%I', t);
    execute format('create trigger zz_accountant_readonly before insert or update or delete on public.%I for each statement execute function public.accountant_readonly_guard()', t);
  end loop;
end $$;

-- 3) Helper interno: quién llama (no expuesto) ------------------------------

create or replace function public.frigo_caller(out company_id uuid, out user_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  user_id := auth.uid();
  if user_id is null then raise exception 'Usuario no autenticado'; end if;
  select p.company_id, p.role into company_id, v_role
  from public.profiles p where p.id = user_id and p.active = true;
  if company_id is null then raise exception 'Perfil inválido'; end if;
  if not exists (select 1 from public.companies c where c.id = company_id and 'frigorifico' = any(c.features)) then
    raise exception 'Esta empresa no tiene la pantalla Frigorífico';
  end if;
  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Tu usuario no puede cargar datos del frigorífico';
  end if;
end;
$$;
revoke all on function public.frigo_caller() from public, anon, authenticated;

-- 4) Cámaras ----------------------------------------------------------------

create or replace function public.frigo_save_camara(
  p_id uuid,
  p_number integer,
  p_name text,
  p_capacity integer default null,
  p_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_id uuid := p_id;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  select * into c from public.frigo_caller();
  if p_number is null or p_number <= 0 then raise exception 'Poné el número de la cámara'; end if;
  if v_name is null then v_name := 'Cámara ' || p_number; end if;
  if p_capacity is not null and p_capacity <= 0 then raise exception 'La capacidad tiene que ser mayor que cero'; end if;

  if exists (
    select 1 from public.frigo_camaras
    where company_id = c.company_id and number = p_number and (v_id is null or id <> v_id)
  ) then
    raise exception 'Ya hay una cámara con el número %', p_number;
  end if;

  if v_id is null then
    insert into public.frigo_camaras (company_id, number, name, capacity, active)
    values (c.company_id, p_number, v_name, p_capacity, coalesce(p_active, true))
    returning id into v_id;
  else
    if not coalesce(p_active, true) and exists (
      select 1 from public.frigo_medias where camara_id = v_id and salida_id is null
    ) then
      raise exception 'La cámara tiene medias adentro: pasalas a otra antes de darla de baja';
    end if;
    update public.frigo_camaras
    set number = p_number, name = v_name, capacity = p_capacity, active = coalesce(p_active, true)
    where id = v_id and company_id = c.company_id;
    if not found then raise exception 'Cámara inválida'; end if;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, c.user_id, 'frigo.camara.save', 'frigo_camara', v_id::text,
          jsonb_build_object('number', p_number, 'name', v_name, 'capacity', p_capacity, 'active', p_active));
  return v_id;
end;
$$;

-- 5) DT de carga ------------------------------------------------------------

create or replace function public.frigo_create_dt(
  p_branch_id uuid,
  p_dt_number text,
  p_dt_date date,
  p_producer text,
  p_renspa text,
  p_origin text,
  p_category text,
  p_heads integer,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_id uuid;
begin
  select * into c from public.frigo_caller();
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = c.company_id and active = true) then
    raise exception 'Sucursal inválida';
  end if;
  if nullif(trim(coalesce(p_dt_number, '')), '') is null then raise exception 'Poné el número de DT'; end if;
  if nullif(trim(coalesce(p_producer, '')), '') is null then raise exception 'Poné el productor'; end if;
  if nullif(trim(coalesce(p_category, '')), '') is null then raise exception 'Poné la categoría'; end if;
  if p_heads is null or p_heads <= 0 or p_heads > 2000 then raise exception 'La cantidad de cabezas no es válida'; end if;

  insert into public.frigo_dts (company_id, branch_id, dt_number, dt_date, producer, renspa, origin, category, heads, notes, created_by)
  values (c.company_id, p_branch_id, trim(p_dt_number), coalesce(p_dt_date, current_date), trim(p_producer),
          nullif(trim(coalesce(p_renspa, '')), ''), nullif(trim(coalesce(p_origin, '')), ''), trim(p_category),
          p_heads, nullif(trim(coalesce(p_notes, '')), ''), c.user_id)
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, p_branch_id, c.user_id, 'frigo.dt.create', 'frigo_dt', v_id::text,
          jsonb_build_object('dt_number', p_dt_number, 'producer', p_producer, 'category', p_category, 'heads', p_heads));
  return v_id;
end;
$$;

create or replace function public.frigo_delete_dt(p_dt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_dt public.frigo_dts%rowtype;
begin
  select * into c from public.frigo_caller();
  select * into v_dt from public.frigo_dts where id = p_dt_id and company_id = c.company_id for update;
  if not found then raise exception 'DT inválido'; end if;
  if v_dt.status <> 'pendiente' then raise exception 'El DT ya se faenó: no se puede borrar'; end if;
  delete from public.frigo_dts where id = p_dt_id;
  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data)
  values (c.company_id, v_dt.branch_id, c.user_id, 'frigo.dt.delete', 'frigo_dt', p_dt_id::text, to_jsonb(v_dt));
end;
$$;

-- 6) Faena: medias con tropa, garrón y kilo ---------------------------------
-- p_medias: [{kg, camara_id}, ...] en orden; 2 por animal (la 1 y la 2 del
-- animal 1, después las del animal 2...). El garrón lo pone la base.

create or replace function public.frigo_slaughter(
  p_dt_id uuid,
  p_tropa integer,
  p_slaughter_date date,
  p_medias jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_dt public.frigo_dts%rowtype;
  v_date date := coalesce(p_slaughter_date, current_date);
  v_next integer;
  v_item jsonb;
  v_i bigint;
  v_kg numeric;
  v_camara uuid;
  v_total numeric := 0;
begin
  select * into c from public.frigo_caller();
  select * into v_dt from public.frigo_dts where id = p_dt_id and company_id = c.company_id for update;
  if not found then raise exception 'DT inválido'; end if;
  if v_dt.status <> 'pendiente' then raise exception 'Este DT ya se faenó'; end if;
  if p_tropa is null or p_tropa <= 0 then raise exception 'Poné el número de tropa'; end if;
  if exists (select 1 from public.frigo_dts where company_id = c.company_id and tropa = p_tropa) then
    raise exception 'La tropa % ya existe', p_tropa;
  end if;
  if p_medias is null or jsonb_typeof(p_medias) <> 'array' or jsonb_array_length(p_medias) <> v_dt.heads * 2 then
    raise exception 'Tienen que ser % medias (% animales)', v_dt.heads * 2, v_dt.heads;
  end if;

  -- Garrón correlativo por día de faena: un solo cálculo a la vez por empresa y día.
  perform pg_advisory_xact_lock(hashtext('frigo_garron:' || c.company_id::text || v_date::text));
  select coalesce(max(garron), 0) + 1 into v_next
  from public.frigo_medias where company_id = c.company_id and slaughter_date = v_date;

  for v_item, v_i in select e, ord from jsonb_array_elements(p_medias) with ordinality as t(e, ord)
  loop
    v_kg := round((v_item->>'kg')::numeric, 1);
    if v_kg is null or v_kg <= 0 or v_kg > 500 then
      raise exception 'Los kilos de la media % no son válidos', v_i;
    end if;
    v_camara := (v_item->>'camara_id')::uuid;
    if not exists (select 1 from public.frigo_camaras where id = v_camara and company_id = c.company_id and active = true) then
      raise exception 'Cámara inválida en la media %', v_i;
    end if;
    insert into public.frigo_medias (company_id, branch_id, dt_id, tropa, garron, slaughter_date, animal, side, kg, camara_id)
    values (c.company_id, v_dt.branch_id, v_dt.id, p_tropa, v_next + v_i::integer - 1, v_date,
            ((v_i + 1) / 2)::integer, case when v_i % 2 = 1 then 1 else 2 end, v_kg, v_camara);
    v_total := v_total + v_kg;
  end loop;

  update public.frigo_dts set status = 'faenado', tropa = p_tropa, slaughter_date = v_date where id = v_dt.id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, v_dt.branch_id, c.user_id, 'frigo.slaughter', 'frigo_dt', v_dt.id::text,
          jsonb_build_object('tropa', p_tropa, 'date', v_date, 'first_garron', v_next,
                             'last_garron', v_next + v_dt.heads * 2 - 1, 'total_kg', v_total));

  return jsonb_build_object('tropa', p_tropa, 'first_garron', v_next,
                            'last_garron', v_next + v_dt.heads * 2 - 1, 'total_kg', v_total);
end;
$$;

-- 7) Pasar medias de cámara --------------------------------------------------

create or replace function public.frigo_move_medias(p_media_ids uuid[], p_camara_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_count integer;
begin
  select * into c from public.frigo_caller();
  if not exists (select 1 from public.frigo_camaras where id = p_camara_id and company_id = c.company_id and active = true) then
    raise exception 'Cámara inválida';
  end if;
  update public.frigo_medias
  set camara_id = p_camara_id
  where company_id = c.company_id and id = any(p_media_ids) and salida_id is null and camara_id <> p_camara_id;
  get diagnostics v_count = row_count;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, c.user_id, 'frigo.medias.move', 'frigo_camara', p_camara_id::text,
          jsonb_build_object('media_ids', p_media_ids, 'moved', v_count));
  return v_count;
end;
$$;

-- 8) Salida: venta a cliente o envío a carnicería propia --------------------

create or replace function public.frigo_create_salida(
  p_branch_id uuid,
  p_salida_date date,
  p_kind text,
  p_customer_id uuid,
  p_dest_branch_id uuid,
  p_product_id uuid,
  p_price_per_kg numeric,
  p_media_ids uuid[],
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_date date := coalesce(p_salida_date, current_date);
  v_salida_id uuid := gen_random_uuid();
  v_charge_id uuid;
  v_number integer;
  v_count integer;
  v_kg numeric := 0;
  v_total numeric := 0;
  v_price numeric(14,2);
  v_m record;
  v_ids uuid[];
begin
  select * into c from public.frigo_caller();
  if p_kind not in ('cliente', 'sucursal') then raise exception 'Tipo de salida inválido'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = c.company_id and active = true) then
    raise exception 'Sucursal inválida';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_media_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 then raise exception 'Elegí al menos una media'; end if;

  -- Bloquea las medias y verifica que sigan en cámara.
  v_count := 0;
  for v_m in
    select id, tropa, garron, kg, salida_id from public.frigo_medias
    where company_id = c.company_id and id = any(v_ids)
    order by slaughter_date, garron
    for update
  loop
    if v_m.salida_id is not null then
      raise exception 'La media tropa % garrón % ya salió', v_m.tropa, v_m.garron;
    end if;
    v_count := v_count + 1;
    v_kg := v_kg + v_m.kg;
  end loop;
  if v_count <> cardinality(v_ids) then raise exception 'Alguna media no existe'; end if;

  if p_kind = 'cliente' then
    if not exists (select 1 from public.customers where id = p_customer_id and company_id = c.company_id and active = true) then
      raise exception 'Cliente inválido';
    end if;
    v_price := round(coalesce(p_price_per_kg, 0), 2);
    if v_price <= 0 then raise exception 'Poné el precio por kilo'; end if;
    select round(sum(round(kg * v_price, 2))) into v_total from public.frigo_medias where id = any(v_ids);
  else
    if not exists (select 1 from public.branches where id = p_dest_branch_id and company_id = c.company_id and active = true) then
      raise exception 'Carnicería (sucursal) inválida';
    end if;
    if not exists (select 1 from public.products where id = p_product_id and company_id = c.company_id and active = true) then
      raise exception 'Producto inválido';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('frigo_salida:' || c.company_id::text));
  select coalesce(max(number), 0) + 1 into v_number from public.frigo_salidas where company_id = c.company_id;

  if p_kind = 'cliente' then
    v_charge_id := gen_random_uuid();
    insert into public.customer_charges (id, company_id, customer_id, charge_date, amount, reason, created_by)
    values (v_charge_id, c.company_id, p_customer_id, v_date, v_total,
            'Frigorífico · remito ' || v_number || ' · ' || v_count || ' medias · ' || replace(to_char(v_kg, 'FM9999990.0'), '.', ',') || ' kg',
            c.user_id);
    insert into public.customer_charge_items (charge_id, product_id, description, quantity, unit_price, line_total)
    select v_charge_id, null,
           'Media res · tropa ' || tropa || ' · garrón ' || garron || ' · faena ' || to_char(slaughter_date, 'DD/MM'),
           kg, v_price, round(kg * v_price, 2)
    from public.frigo_medias where id = any(v_ids)
    order by slaughter_date, garron;
  end if;

  insert into public.frigo_salidas (id, company_id, branch_id, number, salida_date, kind, customer_id, dest_branch_id, product_id,
                                    price_per_kg, total_kg, total, customer_charge_id, notes, created_by)
  values (v_salida_id, c.company_id, p_branch_id, v_number, v_date, p_kind,
          case when p_kind = 'cliente' then p_customer_id end,
          case when p_kind = 'sucursal' then p_dest_branch_id end,
          case when p_kind = 'sucursal' then p_product_id end,
          case when p_kind = 'cliente' then v_price end,
          v_kg, v_total, v_charge_id, nullif(trim(coalesce(p_notes, '')), ''), c.user_id);

  if p_kind = 'sucursal' then
    insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
    values (c.company_id, p_dest_branch_id, p_product_id, 'frigo_ingreso', v_kg, 'frigo_salida', v_salida_id,
            'Ingreso desde Frigorífico · remito ' || v_number || ' · ' || v_count || ' medias', c.user_id);
  end if;

  update public.frigo_medias set salida_id = v_salida_id where id = any(v_ids);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, p_branch_id, c.user_id, 'frigo.salida.create', 'frigo_salida', v_salida_id::text,
          jsonb_build_object('number', v_number, 'kind', p_kind, 'customer_id', p_customer_id, 'dest_branch_id', p_dest_branch_id,
                             'medias', v_count, 'total_kg', v_kg, 'price_per_kg', v_price, 'total', v_total));

  return jsonb_build_object('id', v_salida_id, 'number', v_number, 'medias', v_count, 'total_kg', v_kg, 'total', v_total);
end;
$$;

create or replace function public.frigo_void_salida(p_salida_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_s public.frigo_salidas%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into c from public.frigo_caller();
  if v_reason is null then raise exception 'Poné por qué se anula'; end if;
  select * into v_s from public.frigo_salidas where id = p_salida_id and company_id = c.company_id for update;
  if not found then raise exception 'Salida inválida'; end if;
  if v_s.voided_at is not null then raise exception 'La salida ya está anulada'; end if;

  update public.frigo_salidas
  set voided_at = now(), voided_reason = v_reason, customer_charge_id = null
  where id = v_s.id;

  if v_s.customer_charge_id is not null then
    -- Si tiene factura, el control de Facturas (customer_charges_invoice_guard) frena el borrado.
    delete from public.customer_charges where id = v_s.customer_charge_id;
  end if;

  if v_s.kind = 'sucursal' then
    insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reference_id, reason, created_by)
    values (c.company_id, v_s.dest_branch_id, v_s.product_id, 'frigo_ingreso', -v_s.total_kg, 'frigo_salida', v_s.id,
            'Anulación remito Frigorífico ' || v_s.number || ': ' || v_reason, c.user_id);
  end if;

  update public.frigo_medias set salida_id = null where salida_id = v_s.id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (c.company_id, v_s.branch_id, c.user_id, 'frigo.salida.void', 'frigo_salida', v_s.id::text, to_jsonb(v_s),
          jsonb_build_object('reason', v_reason));
end;
$$;

-- 9) La entrega del cliente que viene del frigorífico se anula desde ahí ----
-- (si se borrara desde Clientes, las medias quedarían como vendidas).

create or replace function public.customer_charges_frigo_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.amount = old.amount and new.customer_id = old.customer_id then
    return new;
  end if;
  if exists (select 1 from public.frigo_salidas where customer_charge_id = old.id and voided_at is null) then
    raise exception 'Esta entrega salió del Frigorífico: anulala desde Frigorífico → Salidas';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function public.customer_charges_frigo_guard() from public, anon, authenticated;

drop trigger if exists customer_charges_frigo_guard on public.customer_charges;
create trigger customer_charges_frigo_guard
before update or delete on public.customer_charges
for each row execute function public.customer_charges_frigo_guard();

-- 10) Permisos de las funciones --------------------------------------------

revoke all on function public.frigo_save_camara(uuid, integer, text, integer, boolean) from public, anon;
grant execute on function public.frigo_save_camara(uuid, integer, text, integer, boolean) to authenticated;
revoke all on function public.frigo_create_dt(uuid, text, date, text, text, text, text, integer, text) from public, anon;
grant execute on function public.frigo_create_dt(uuid, text, date, text, text, text, text, integer, text) to authenticated;
revoke all on function public.frigo_delete_dt(uuid) from public, anon;
grant execute on function public.frigo_delete_dt(uuid) to authenticated;
revoke all on function public.frigo_slaughter(uuid, integer, date, jsonb) from public, anon;
grant execute on function public.frigo_slaughter(uuid, integer, date, jsonb) to authenticated;
revoke all on function public.frigo_move_medias(uuid[], uuid) from public, anon;
grant execute on function public.frigo_move_medias(uuid[], uuid) to authenticated;
revoke all on function public.frigo_create_salida(uuid, date, text, uuid, uuid, uuid, numeric, uuid[], text) from public, anon;
grant execute on function public.frigo_create_salida(uuid, date, text, uuid, uuid, uuid, numeric, uuid[], text) to authenticated;
revoke all on function public.frigo_void_salida(uuid, text) from public, anon;
grant execute on function public.frigo_void_salida(uuid, text) to authenticated;

-- 11) Pantallas a pedido desde el panel de plataforma ---------------------
-- Antes companies.features se cambiaba a mano con SQL. Ahora el administrador
-- de plataforma lo tilda en la tarjeta de cada cliente. Solo claves conocidas,
-- para que un error de tipeo no deje una pantalla prendida que no existe.

create or replace function public.list_company_features()
returns table (company_id uuid, features text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  return query select c.id, c.features from public.companies c;
end;
$$;

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
  if p_feature is null or p_feature not in ('frigorifico', 'cuentas', 'gastos', 'reporte_ventas', 'ventas_detalle', 'paquetes', 'venta_ruta') then
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

revoke all on function public.list_company_features() from public, anon;
grant execute on function public.list_company_features() to authenticated;
revoke all on function public.set_company_feature(uuid, text, boolean) from public, anon;
grant execute on function public.set_company_feature(uuid, text, boolean) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('169_frigorifico') on conflict do nothing;
