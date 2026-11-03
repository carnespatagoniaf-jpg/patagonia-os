-- 194: Plan "Planta" + paquetes con código (2026-11-03, etapa 1). Decisión del dueño: un plan aparte para la
-- carnicería que deposta en una planta y vende en locales de autoservicio (todo envasado al vacío, la gente se
-- sirve de la heladera). "Empresa + extras": trae todo lo de Empresa (envíos entre locales con remito y
-- recepción, varios locales) y además la pantalla Planta. Precio a definir.
--
-- Recorrido de un paquete:
--   1. En la planta se deposta (Despiece / Compras, como siempre: ahí entran los kilos al stock), se clasifica,
--      se pesa y se ENVASA: planta_pack crea un paquete por cada peso, con su código propio (PQ + 8 dígitos,
--      correlativo por empresa), el lote (la media res de Despiece, si se elige) y el vencimiento.
--      Envasar NO mueve stock: los kilos ya están; el paquete es la etiqueta de una parte de esos kilos.
--   2. Se DESPACHA a un local escaneando los paquetes (planta_ship): arma un envío de Mercadería entre locales
--      (190) con los kilos de esos paquetes por producto, así sale con su remito y el local lo recibe en
--      "Entre locales" como cualquier envío. Al recibir, los paquetes quedan en el local; si el envío se anula
--      en viaje, vuelven a la planta.
--   3. En Mostrador se escanea el paquete: la línea es su producto con sus kilos, al precio de hoy (con zona o
--      lista, como cualquier producto). El código viaja en pos_sale_items.scale_ticket (118), así que
--      create_pos_sale NO se tocó. Un trigger marca el paquete vendido (nunca frena la venta) y anular la venta
--      lo devuelve al local.
-- Combos con cambios y la "etiqueta dorada" (cupón dentro del paquete) son las etapas 2 y 3.
--
-- Plan: 'planta' tiene el mismo orden que 'empresa' (plan_rank 4), así que todo require_plan('empresa') le
-- sirve. Lo que es SOLO de Planta pregunta planta_enabled() (el plan exacto), no el orden.

-- Plan ---------------------------------------------------------------------------------------------------------

alter table public.companies drop constraint if exists companies_plan_check;
alter table public.companies add constraint companies_plan_check check (plan in ('basico', 'estandar', 'full', 'empresa', 'planta'));

create or replace function public.plan_rank(p_plan text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_plan when 'basico' then 1 when 'estandar' then 2 when 'full' then 3 when 'empresa' then 4 when 'planta' then 4 else 4 end;
$$;

create or replace function public.plan_display_name(p_plan text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_plan when 'basico' then 'Básico' when 'estandar' then 'Estándar' when 'full' then 'Full' when 'empresa' then 'Empresa'
    when 'planta' then 'Planta' else p_plan end;
$$;

create or replace function public.set_company_plan(p_company_id uuid, p_plan text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_plan is null or p_plan not in ('basico', 'estandar', 'full', 'empresa', 'planta') then
    raise exception 'Plan inválido';
  end if;

  update public.companies set plan = p_plan where id = p_company_id;
  if not found then
    raise exception 'Cliente inválido';
  end if;
end;
$$;

revoke all on function public.set_company_plan(uuid, text) from public, anon;
grant execute on function public.set_company_plan(uuid, text) to authenticated;

-- ¿La empresa de quien llama tiene el plan Planta? Sin perfil, no (a diferencia de company_plan_allows).
create or replace function public.planta_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.plan = 'planta' from public.profiles p join public.companies c on c.id = p.company_id
                   where p.id = auth.uid()), false);
$$;
revoke all on function public.planta_enabled() from public, anon;
grant execute on function public.planta_enabled() to authenticated;

-- Paquetes -----------------------------------------------------------------------------------------------------

create table if not exists public.planta_packages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  number integer not null check (number > 0),
  code text not null,
  product_id uuid not null references public.products(id),
  origin_branch_id uuid not null references public.branches(id),
  branch_id uuid not null references public.branches(id),
  carcass_batch_id uuid references public.carcass_batches(id) on delete set null,
  quantity numeric(12,3) not null check (quantity > 0),
  packed_on date not null,
  expires_on date,
  status text not null default 'en_planta' check (status in ('en_planta', 'en_viaje', 'en_local', 'vendido', 'anulado')),
  transfer_id uuid references public.branch_transfers(id),
  pos_sale_id uuid references public.pos_sales(id),
  sold_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) <= 200),
  voided_by uuid references auth.users(id),
  voided_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number),
  unique (company_id, code)
);
create index if not exists planta_packages_branch_status on public.planta_packages (company_id, branch_id, status);
create index if not exists planta_packages_transfer on public.planta_packages (transfer_id) where transfer_id is not null;
create index if not exists planta_packages_sale on public.planta_packages (pos_sale_id) where pos_sale_id is not null;

alter table public.planta_packages enable row level security;
drop policy if exists planta_packages_company_read on public.planta_packages;
create policy planta_packages_company_read on public.planta_packages
  for select to authenticated using (company_id = public.current_company_id());
drop policy if exists plan_planta on public.planta_packages;
create policy plan_planta on public.planta_packages as restrictive
  for all to authenticated using (public.planta_enabled()) with check (public.planta_enabled());
-- Sin políticas de escritura: solo las funciones de abajo (migración 175).

drop trigger if exists zz_accountant_readonly on public.planta_packages;
create trigger zz_accountant_readonly before insert or update or delete on public.planta_packages
  for each statement execute function public.accountant_readonly_guard();

-- Quién envasa, anula y despacha: plan Planta y un papel que trabaja con mercadería, en un local que le toca.
create or replace function public.planta_caller(p_branch_id uuid, out company_id uuid, out user_id uuid)
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
  if not public.planta_enabled() then
    raise exception 'Esto está en el plan Planta. Pedíselo a Patagonia OS.' using hint = 'plan_required:planta';
  end if;
  select p.company_id, p.role into company_id, v_role from public.profiles p where p.id = user_id and p.active = true;
  if company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin', 'manager', 'production') then
    raise exception 'No autorizado para envasar o despachar paquetes';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = planta_caller.company_id and b.active) then
    raise exception 'Local inválido';
  end if;
  if not public.my_branch_allowed(p_branch_id) then
    raise exception 'Solo podés trabajar con los paquetes de tu local';
  end if;
end;
$$;
revoke all on function public.planta_caller(uuid) from public, anon, authenticated;

-- 1. Envasar: un paquete por cada cantidad (kilos, o unidades si el producto va por unidad) -------------------------
create or replace function public.planta_pack(
  p_branch_id uuid, p_product_id uuid, p_quantities numeric[], p_carcass_batch_id uuid default null, p_expires_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_product record;
  v_qty numeric;
  v_number integer;
  v_out jsonb := '[]'::jsonb;
  v_id uuid;
  v_code text;
begin
  select * into c from public.planta_caller(p_branch_id);
  select id, name, unit into v_product from public.products
  where id = p_product_id and company_id = c.company_id and active = true;
  if v_product.id is null then raise exception 'Producto inválido'; end if;
  if p_quantities is null or coalesce(array_length(p_quantities, 1), 0) = 0 then raise exception 'Poné el peso de al menos un paquete'; end if;
  if array_length(p_quantities, 1) > 200 then raise exception 'Son muchos paquetes de una vez (máximo 200)'; end if;
  if p_carcass_batch_id is not null
     and not exists (select 1 from public.carcass_batches where id = p_carcass_batch_id and company_id = c.company_id) then
    raise exception 'Lote de despiece inválido';
  end if;
  if p_expires_on is not null and p_expires_on < public.today_ar() then raise exception 'El vencimiento ya pasó'; end if;

  foreach v_qty in array p_quantities loop
    if v_qty is null or v_qty <= 0 then raise exception 'Cada paquete necesita un peso mayor que cero'; end if;
    if v_qty > 100 then raise exception 'Un paquete no puede tener más de 100 %', case when v_product.unit = 'kg' then 'kg' else 'unidades' end; end if;
    if v_product.unit <> 'kg' and v_qty <> round(v_qty) then raise exception '% va por unidad: poné unidades enteras', v_product.name; end if;
  end loop;

  -- Número correlativo por empresa, sin cruzarse con otra persona envasando al mismo tiempo.
  perform pg_advisory_xact_lock(hashtext('planta_packages:' || c.company_id::text));
  select coalesce(max(number), 0) into v_number from public.planta_packages where company_id = c.company_id;

  foreach v_qty in array p_quantities loop
    v_number := v_number + 1;
    v_code := 'PQ' || lpad(v_number::text, 8, '0');
    insert into public.planta_packages (company_id, number, code, product_id, origin_branch_id, branch_id, carcass_batch_id,
      quantity, packed_on, expires_on, created_by)
    values (c.company_id, v_number, v_code, v_product.id, p_branch_id, p_branch_id, p_carcass_batch_id,
      round(v_qty, 3), public.today_ar(), p_expires_on, c.user_id)
    returning id into v_id;
    v_out := v_out || jsonb_build_object('id', v_id, 'number', v_number, 'code', v_code, 'quantity', round(v_qty, 3));
  end loop;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, p_branch_id, c.user_id, 'planta.pack', 'product', v_product.id::text,
    jsonb_build_object('count', jsonb_array_length(v_out), 'carcass_batch_id', p_carcass_batch_id, 'expires_on', p_expires_on,
      'from', v_out->0->>'code', 'to', v_out->-1->>'code'));
  return v_out;
end;
$$;

-- 2. Anular un paquete (etiqueta mal impresa, se rompió el vacío). No toca los kilos: si la carne se tira, va por
--    Decomiso como siempre. Solo un paquete en la planta o en el local, nunca uno vendido o en viaje.
create or replace function public.planta_void_package(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pkg record;
  c record;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into v_pkg from public.planta_packages where id = p_id and company_id = public.current_company_id() for update;
  if v_pkg.id is null then raise exception 'Paquete inválido'; end if;
  select * into c from public.planta_caller(v_pkg.branch_id);
  if v_pkg.status not in ('en_planta', 'en_local') then
    raise exception 'Ese paquete ya está %: no se puede anular', replace(v_pkg.status, '_', ' ');
  end if;
  if v_reason is null then raise exception 'Escribí por qué se anula'; end if;
  if length(v_reason) > 200 then raise exception 'El motivo es muy largo (200 letras)'; end if;

  update public.planta_packages
  set status = 'anulado', void_reason = v_reason, voided_by = c.user_id, voided_at = now(), updated_at = now()
  where id = p_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (c.company_id, v_pkg.branch_id, c.user_id, 'planta.void_package', 'planta_package', p_id::text,
    jsonb_build_object('code', v_pkg.code, 'status', v_pkg.status), jsonb_build_object('reason', v_reason));
end;
$$;

-- 3. Despachar a un local escaneando paquetes: un envío de Mercadería entre locales (190) con sus kilos -------------
create or replace function public.planta_ship(
  p_from uuid, p_to uuid, p_codes text[], p_carrier text default null, p_vehicle text default null, p_notes text default null,
  p_remito_r boolean default false, p_delivery_address text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_codes text[];
  v_found integer;
  v_bad text;
  v_items jsonb;
  v_result jsonb;
begin
  select * into c from public.planta_caller(p_from);
  select array_agg(distinct upper(trim(x))) into v_codes from unnest(p_codes) x where nullif(trim(x), '') is not null;
  if coalesce(array_length(v_codes, 1), 0) = 0 then raise exception 'Escaneá al menos un paquete'; end if;
  if array_length(v_codes, 1) > 1000 then raise exception 'Son muchos paquetes para un envío (máximo 1000)'; end if;

  perform 1 from public.planta_packages where company_id = c.company_id and code = any(v_codes) order by id for update;

  select min(x) into v_bad from unnest(v_codes) x
  where not exists (select 1 from public.planta_packages p where p.company_id = c.company_id and p.code = x);
  if v_bad is not null then raise exception 'El paquete % no existe', v_bad; end if;
  select min(code) into v_bad from public.planta_packages
  where company_id = c.company_id and code = any(v_codes) and (status <> 'en_planta' or branch_id <> p_from);
  if v_bad is not null then raise exception 'El paquete % no está en este local para mandar', v_bad; end if;

  select jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', qty)), count(*) into v_items, v_found
  from (select product_id, sum(quantity) as qty from public.planta_packages
        where company_id = c.company_id and code = any(v_codes) group by product_id) s;

  -- Mismo camino que un envío armado a mano: remito, stock que sale de la planta, recepción en el local.
  v_result := public.dispatch_branch_transfer(null, p_from, p_to, v_items, p_carrier, p_vehicle, p_notes,
    coalesce(p_remito_r, false), false, p_delivery_address);

  update public.planta_packages
  set status = 'en_viaje', transfer_id = (v_result->>'id')::uuid, updated_at = now()
  where company_id = c.company_id and code = any(v_codes);

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (c.company_id, p_from, c.user_id, 'planta.ship', 'branch_transfer', v_result->>'id',
    jsonb_build_object('to_branch_id', p_to, 'packages', array_length(v_codes, 1), 'products', v_found));
  return v_result || jsonb_build_object('packages', array_length(v_codes, 1));
end;
$$;

-- Recibido o anulado en viaje: los paquetes del envío lo siguen.
create or replace function public.planta_packages_follow_transfer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'recibido' and old.status is distinct from 'recibido' then
    update public.planta_packages set status = 'en_local', branch_id = new.to_branch_id, updated_at = now()
    where transfer_id = new.id and status = 'en_viaje';
  elsif new.status = 'cancelado' and old.status = 'en_viaje' then
    update public.planta_packages set status = 'en_planta', branch_id = new.from_branch_id, transfer_id = null, updated_at = now()
    where transfer_id = new.id and status = 'en_viaje';
  end if;
  return null;
end;
$$;
revoke all on function public.planta_packages_follow_transfer() from public, anon, authenticated;

drop trigger if exists planta_packages_follow_transfer on public.branch_transfers;
create trigger planta_packages_follow_transfer after update of status on public.branch_transfers
  for each row execute function public.planta_packages_follow_transfer();

-- 4. Mostrador: el paquete escaneado queda vendido. Nunca frena la venta. -------------------------------------------
create or replace function public.planta_packages_on_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    update public.planta_packages p
    set status = 'vendido', pos_sale_id = new.sale_id, sold_at = now(), branch_id = s.branch_id, updated_at = now()
    from public.pos_sales s
    where s.id = new.sale_id and p.company_id = s.company_id and p.code = upper(trim(new.scale_ticket))
      and p.product_id is not distinct from new.product_id
      and p.status in ('en_planta', 'en_viaje', 'en_local');
  exception when others then
    null; -- un paquete sin marcar es mejor que una venta frenada
  end;
  return null;
end;
$$;
revoke all on function public.planta_packages_on_sale() from public, anon, authenticated;

drop trigger if exists planta_packages_on_sale on public.pos_sale_items;
create trigger planta_packages_on_sale after insert on public.pos_sale_items
  for each row when (new.scale_ticket like 'PQ%') execute function public.planta_packages_on_sale();

-- Anular la venta devuelve el paquete al local donde se vendió.
create or replace function public.planta_packages_on_sale_void()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.voided_at is null and new.voided_at is not null then
    begin
      update public.planta_packages set status = 'en_local', pos_sale_id = null, sold_at = null, updated_at = now()
      where pos_sale_id = new.id and status = 'vendido';
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;
revoke all on function public.planta_packages_on_sale_void() from public, anon, authenticated;

drop trigger if exists planta_packages_on_sale_void on public.pos_sales;
create trigger planta_packages_on_sale_void after update of voided_at on public.pos_sales
  for each row execute function public.planta_packages_on_sale_void();

revoke all on function public.planta_pack(uuid, uuid, numeric[], uuid, date) from public, anon;
grant execute on function public.planta_pack(uuid, uuid, numeric[], uuid, date) to authenticated;
revoke all on function public.planta_void_package(uuid, text) from public, anon;
grant execute on function public.planta_void_package(uuid, text) to authenticated;
revoke all on function public.planta_ship(uuid, uuid, text[], text, text, text, boolean, text) from public, anon;
grant execute on function public.planta_ship(uuid, uuid, text[], text, text, text, boolean, text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('194_plan_planta') on conflict do nothing;
